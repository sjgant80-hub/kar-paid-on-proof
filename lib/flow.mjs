// flow.mjs — Kar, the conductor. One end-to-end run of the trust layer on any chain adapter
// (lib/chain-local.mjs = an in-process Shanghai EVM; lib/chain-rpc.mjs = QDay Aevum testnet).
// Every step is a real transaction; every refusal is a real reverted transaction. The returned audit
// trail lists each one with its hash, status, decoded events or decoded error, and the state it changed.

import { encodeFunctionData, getAddress, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  verifyDeliverable, readAnswer, screenInjection, checkSessionAction, TAG,
  sourcesRoot, questionHash, deliverableHash, requestHash, reportHash,
  sessionActionTypedData, agentWalletTypedData, registrationFile, dataURI, units, fmt,
  KIND_CALL, KIND_TRANSFER,
} from '../sdk/index.mjs';

export const ATTACKER = '0xBAD000000000000000000000000000000000BaD0'; // checksummed; nobody holds its key

// The deliberately ungrounded deliverable for the FAIL path: the worker rewords the source instead of
// copying it. The words are close; they are not the source's words, so the verifier refuses to sign.
export function paraphrase(deliverable) {
  const reworded = deliverable.answer.replace(/\bMUST\b/, 'has to');
  return { answer: reworded === deliverable.answer ? 'In short, ' + reworded : reworded, claims: deliverable.claims };
}

export async function runFlow(chain, { keys, art, job, token: tokenAddr, log = () => {} }) {
  const who = {
    principal: privateKeyToAccount(keys.principal),
    worker: privateKeyToAccount(keys.worker),
    validator: privateKeyToAccount(keys.validator),
    session: privateKeyToAccount(keys.session),
  };
  const trail = { chainId: chain.chainId, network: chain.name, started: new Date().toISOString(), roles: {}, contracts: {}, steps: [], checks: [] };
  for (const [r, a] of Object.entries(who)) trail.roles[r] = a.address;
  trail.roles.attacker = ATTACKER;

  const record = (step, label, actor, res, extra = {}) => {
    const entry = { step, label, actor, hash: res.hash, status: res.status, block: res.block, gasUsed: res.gasUsed?.toString(),
      events: res.events, error: res.error, ...extra };
    trail.steps.push(entry);
    log(`${res.status === 'success' ? '✓' : '✗'} [${step}] ${label}${res.error ? '  -> reverted ' + res.error.name : ''}  ${res.hash}`);
    return res;
  };
  const check = (name, ok, detail) => {
    trail.checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) throw new Error(`check failed: ${name} (${detail})`);
  };
  const send = (actor, to, abi, fn, args, opts) => chain.send(keys[actor], to, abi, fn, args, opts);

  // ── S0 deploy ───────────────────────────────────────────────────────────
  const dep = async (name, args) => {
    const r = await chain.deploy(keys.principal, art[name], args);
    trail.contracts[name] = r.address;
    record('S0', `deploy ${name}`, 'principal', r, { contract: r.address });
    return r.address;
  };
  let token = tokenAddr;
  if (!token) {
    token = await dep('MockUSD8', []);
    record('S0', 'mint 10 local tUSD8 to the principal', 'principal',
      await send('principal', token, art.MockUSD8.abi, 'mint', [who.principal.address, units(10)]));
  }
  trail.contracts.tUSD8 = token;
  const identity = await dep('AgentIdentityRegistry', []);
  const validation = await dep('ValidationRegistry', [identity]);
  const market = await dep('Fallmarket', [identity, validation]);
  const gate = await dep('FulfilmentGate', [token, identity, validation, market]);
  const account = await dep('AgentAccount', [who.principal.address, token]);
  for (const r of ['worker', 'validator']) {
    if ((await chain.balance(who[r].address)) < chain.gasFloat) {
      record('S0', `send gas (${chain.gasSymbol}) to the ${r}`, 'principal', await chain.sendValue(keys.principal, who[r].address, chain.gasFloat));
    }
  }

  const A = (n) => art[n].abi;
  const bal = (a) => chain.read(token, A('MockUSD8'), 'balanceOf', [a]);

  // ── S1 ERC-8004 identities ────────────────────────────────────────────────
  const registerAgent = async (actor, name, description, services) => {
    const predicted = (await chain.read(identity, A('AgentIdentityRegistry'), 'agentCount', [])) + 1n;
    const file = registrationFile({ name, description, services, agentId: predicted, chainId: chain.chainId, registry: identity });
    const res = record('S1', `register ERC-8004 identity: ${name}`, actor,
      await send(actor, identity, A('AgentIdentityRegistry'), 'register', [dataURI(file)]));
    const ev = res.events.find((e) => e.name === 'Registered');
    check(`${name} registered as agent #${predicted}`, ev && ev.args.agentId === predicted, `agentId ${ev?.args.agentId}`);
    return predicted;
  };
  const buyerId = await registerAgent('principal', 'Kar buyer agent', 'Takes jobs from Fallmarket and pays only on verified delivery, through a session key it cannot exceed.',
    [{ name: 'web', endpoint: 'https://sjgant80-hub.github.io/kar-trust-layer/' }]);
  const workerId = await registerAgent('worker', 'Copy-only worker', 'A verified worker mind: answers from your sources by copying the passage, with byte offsets.',
    [{ name: 'web', endpoint: 'https://sjgant80-hub.github.io/kar-trust-layer/#worker' }]);
  const validatorId = await registerAgent('validator', 'DocDec verifier', 'Checks a deliverable is grounded: every word at its cited offsets in the committed sources, and on the question. Signs PASS or FAIL in the ERC-8004 Validation Registry.',
    [{ name: 'web', endpoint: 'https://sjgant80-hub.github.io/docdecdemo/' }]);

  const now0 = await chain.time();
  const wDeadline = now0 + 240n;
  const sig = await who.principal.signTypedData(agentWalletTypedData({ chainId: chain.chainId, registry: identity, agentId: buyerId,
    newWallet: account, owner: who.principal.address, deadline: wDeadline }));
  record('S1', 'bind the agent smart account as the buyer agent\'s ERC-8004 agentWallet (ERC-1271)', 'principal',
    await send('principal', identity, A('AgentIdentityRegistry'), 'setAgentWallet', [buyerId, account, wDeadline, sig]));
  check('buyer agentWallet = smart account', getAddress(await chain.read(identity, A('AgentIdentityRegistry'), 'getAgentWallet', [buyerId])) === getAddress(account), account);

  // ── S2 fund the account and scope the session key ─────────────────────────
  const CAP = units(job.cap);
  const PRICE = units(job.price);
  record('S2', `fund the agent account with ${fmt(CAP)} tUSD8`, 'principal',
    await send('principal', token, A('MockUSD8'), 'transfer', [account, CAP]));
  const sExpiry = (await chain.time()) + 86400n;
  record('S2', `grant the session key: cap ${fmt(CAP)} tUSD8, expires in 24 h, may pay only the FulfilmentGate`, 'principal',
    await send('principal', account, A('AgentAccount'), 'grantSession', [who.session.address, CAP, sExpiry, [gate]]));

  // ── S3 Fallmarket listing (its terms carry a prompt injection) ────────────
  const terms = { service: 'Grounded answer from your own documents, every word cited', price: `${job.price} tUSD8`, validator: 'DocDec verifier', note: job.injection };
  const lExpiry = (await chain.time()) + 3n * 86400n;
  const listRes = record('S3', 'worker lists a job on Fallmarket (its terms hide a prompt injection)', 'worker',
    await send('worker', market, A('Fallmarket'), 'list', [workerId, who.validator.address, PRICE, lExpiry, dataURI(terms)]));
  const listingId = listRes.events.find((e) => e.name === 'Listed').args.listingId;

  // ── S4 the agent takes the job through its session key ────────────────────
  const screen = screenInjection(job.injection);
  trail.screen = screen;
  log(`  immune screen on the listing terms: ${screen.flagged ? 'FLAGGED: ' + screen.reasons.join('; ') : 'clean'}`);
  const sources = job.sources.map((s) => s.text);
  const root = sourcesRoot(sources);

  const sessionAct = async (step, label, kind, target, amount, data, expect) => {
    const s = await chain.read(account, A('AgentAccount'), 'sessions', [who.session.address]);
    const [cap, spent, expiry, nonce, active] = s;
    const deadline = (await chain.time()) + 600n;
    const td = sessionActionTypedData({ chainId: chain.chainId, account, kind, target, amount, data, nonce, deadline });
    const signature = await who.session.signTypedData(td);
    const preview = checkSessionAction({ cap, spent, expiry, active, allowlist: [gate] },
      { kind, target, amount, dataLength: (data.length - 2) / 2, deadline, signerOk: true, token }, await chain.time());
    const res = await chain.send(keys.principal, account, A('AgentAccount'), 'executeSession',
      [who.session.address, kind, target, amount, data, deadline, signature], { allowRevert: expect !== 'success' });
    record(step, label, 'session key (relayed by the principal)', res, { preview });
    check(`${label}: chain ${expect === 'success' ? 'accepts' : 'refuses with ' + expect}`,
      expect === 'success' ? res.status === 'success' : res.status === 'reverted' && res.error?.name === expect,
      `${res.status} ${res.error?.name ?? ''}`);
    check(`${label}: the SDK preview agrees with the chain`, (preview.ok && res.status === 'success') || preview.error === res.error?.name, `${preview.error} vs ${res.error?.name}`);
    return res;
  };
  const jobDeadline = async () => (await chain.time()) + 2n * 86400n;
  const openData = async (q) => encodeFunctionData({ abi: A('FulfilmentGate'), functionName: 'openJob', args: [listingId, buyerId, questionHash(q), root, await jobDeadline()] });

  const take1 = await sessionAct('S4', `agent takes job 1 on Fallmarket: escrows ${fmt(PRICE)} tUSD8 in the FulfilmentGate`, KIND_CALL, gate, PRICE, await openData(job.question), 'success');
  const job1 = take1.events.find((e) => e.name === 'JobOpened').args.jobId;

  // ── S5 the injection: assume the model obeyed it. The chain does not. ─────
  await sessionAct('S5', `injection obeyed: session key signs "pay ${ATTACKER} 10,000 tUSD8"`, KIND_TRANSFER, ATTACKER, units(10000), '0x', 'RecipientNotAllowed');
  await sessionAct('S5', 'injection, second try: route 10,000 tUSD8 through the allowed gate', KIND_CALL, gate, units(10000), await openData(job.question), 'OverCap');

  // ── S6 the worker does the job (copy-only) and asks the DocDec verifier ───
  const deliverable = readAnswer(job.question, sources);
  check('worker produced a cited answer', deliverable.claims.length > 0, deliverable.answer);
  const dHash1 = deliverableHash(job.question, deliverable.answer, deliverable.claims);
  const rHash1 = requestHash(chain.chainId, gate, job1, dHash1);
  const dURI1 = dataURI({ jobId: Number(job1), question: job.question, answer: deliverable.answer, claims: deliverable.claims });
  record('S6', 'worker submits its deliverable (answer + byte offsets) to the gate', 'worker',
    await send('worker', gate, A('FulfilmentGate'), 'submit', [job1, dHash1, dURI1]));
  record('S6', 'worker requests validation from the DocDec verifier (ERC-8004 Validation Registry)', 'worker',
    await send('worker', validation, A('ValidationRegistry'), 'validationRequest', [who.validator.address, workerId, dURI1, rHash1]));

  // ── S7 DocDec verifies ────────────────────────────────────────────────────
  const verdict1 = verifyDeliverable({ question: job.question, sources, deliverable });
  const report1 = { jobId: Number(job1), verdict: verdict1.verdict, reason: verdict1.reason, claims: verdict1.claims, coverage: verdict1.coverage, tag: TAG };
  check('DocDec verdict on job 1 is PASS', verdict1.pass, verdict1.reason);
  record('S7', `DocDec verifier signs ${verdict1.verdict} (${verdict1.response}/100) for job 1`, 'validator',
    await send('validator', validation, A('ValidationRegistry'), 'validationResponse', [rHash1, verdict1.response, dataURI(report1), reportHash(report1), TAG]));

  // ── S8 release on proof ───────────────────────────────────────────────────
  const claims1 = deliverable.claims.map((c) => ({ doc: c.doc, start: c.start, end: c.end }));
  const before = await bal(who.worker.address);
  record('S8', `gate re-checks the quote on-chain and releases ${fmt(PRICE)} tUSD8 to the worker`, 'anyone (the principal)',
    await send('principal', gate, A('FulfilmentGate'), 'release', [job1, sources.map((t) => toBytesHex(t)), toBytesHex(deliverable.answer), claims1]));
  check('worker was paid exactly the price', (await bal(who.worker.address)) - before === PRICE, fmt((await bal(who.worker.address)) - before));

  // ── S9 the FAIL path: an ungrounded deliverable cannot be paid ─────────────
  const take2 = await sessionAct('S9', `agent takes job 2: escrows ${fmt(PRICE)} tUSD8`, KIND_CALL, gate, PRICE, await openData(job.question2 || job.question), 'success');
  const job2 = take2.events.find((e) => e.name === 'JobOpened').args.jobId;
  const q2 = job.question2 || job.question;
  const sloppy = paraphrase(readAnswer(q2, sources));
  const dHash2 = deliverableHash(q2, sloppy.answer, sloppy.claims);
  const rHash2 = requestHash(chain.chainId, gate, job2, dHash2);
  const dURI2 = dataURI({ jobId: Number(job2), question: q2, answer: sloppy.answer, claims: sloppy.claims });
  record('S9', 'worker submits a REWORDED answer (close to the source, not its words)', 'worker',
    await send('worker', gate, A('FulfilmentGate'), 'submit', [job2, dHash2, dURI2]));
  record('S9', 'worker requests validation for job 2', 'worker',
    await send('worker', validation, A('ValidationRegistry'), 'validationRequest', [who.validator.address, workerId, dURI2, rHash2]));
  const verdict2 = verifyDeliverable({ question: q2, sources, deliverable: sloppy });
  check('DocDec verdict on the reworded answer is FAIL', !verdict2.pass, verdict2.reason);
  const report2 = { jobId: Number(job2), verdict: verdict2.verdict, reason: verdict2.reason, rebuilt: verdict2.rebuilt, tag: TAG };
  record('S9', `DocDec verifier signs ${verdict2.verdict} (0/100): ${verdict2.reason}`, 'validator',
    await send('validator', validation, A('ValidationRegistry'), 'validationResponse', [rHash2, 0, dataURI(report2), reportHash(report2), TAG]));
  const rel2 = record('S9', 'someone tries to release job 2 anyway', 'anyone (the principal)',
    await send('principal', gate, A('FulfilmentGate'), 'release', [job2, sources.map(toBytesHex), toBytesHex(sloppy.answer), sloppy.claims], { allowRevert: true }));
  check('release of the ungrounded deliverable reverts NotValidated', rel2.status === 'reverted' && rel2.error?.name === 'NotValidated', rel2.error?.name);
  const accBefore = await bal(account);
  record('S9', 'refund: the verifier said FAIL, so the escrow returns to the agent account', 'anyone (the principal)',
    await send('principal', gate, A('FulfilmentGate'), 'refund', [job2]));
  check('agent account got its escrow back', (await bal(account)) - accBefore === PRICE, fmt((await bal(account)) - accBefore));

  // ── S10 metabolism: the market prunes a worker below the bar ──────────────
  const pr = record('S10', 'anyone prunes the listing: the worker\'s verified record is 1 PASS + 1 FAIL = 50/100, under the 60 bar', 'anyone (the principal)',
    await send('principal', market, A('Fallmarket'), 'prune', [listingId]));
  check('listing delisted for failed validations', pr.events.some((e) => e.name === 'Delisted' && e.args.reason === 'failed-validations'), 'Delisted');

  // ── S11 revoke: the owner pulls the key; it is dead at once ───────────────
  record('S11', 'the owner revokes the session key', 'principal',
    await send('principal', account, A('AgentAccount'), 'revokeSession', [who.session.address]));
  await sessionAct('S11', 'the revoked key tries one more payment', KIND_TRANSFER, gate, units(0.5), '0x', 'SessionNotActive');

  // ── final state ───────────────────────────────────────────────────────────
  const s = await chain.read(account, A('AgentAccount'), 'sessions', [who.session.address]);
  const [count, avg] = await chain.read(validation, A('ValidationRegistry'), 'getSummary', [workerId, [who.validator.address], '']);
  trail.final = {
    balances: {
      agentAccount: fmt(await bal(account)), worker: fmt(await bal(who.worker.address)), gate: fmt(await bal(gate)), attacker: fmt(await bal(ATTACKER)),
    },
    session: { cap: fmt(s[0]), spent: fmt(s[1]), active: s[4] },
    workerValidations: { count: Number(count), average: Number(avg) },
    listingLive: await chain.read(market, A('Fallmarket'), 'isLive', [listingId]),
    jobs: { job1: Number((await chain.read(gate, A('FulfilmentGate'), 'getJob', [job1])).state), job2: Number((await chain.read(gate, A('FulfilmentGate'), 'getJob', [job2])).state) },
  };
  check('attacker received nothing', trail.final.balances.attacker === '0.00', trail.final.balances.attacker);
  check('gate holds no stranded escrow', trail.final.balances.gate === '0.00', trail.final.balances.gate);
  trail.ids = { buyerAgentId: Number(buyerId), workerAgentId: Number(workerId), validatorAgentId: Number(validatorId), listingId: Number(listingId), job1: Number(job1), job2: Number(job2) };
  trail.deliverables = { job1: { question: job.question, ...deliverable, verdict: verdict1 }, job2: { question: q2, ...sloppy, verdict: verdict2 } };
  trail.finished = new Date().toISOString();
  return trail;
}

function toBytesHex(text) {
  return stringToHex(text);
}
