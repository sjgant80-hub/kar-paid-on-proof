// FulfilmentGate: money moves only on (verifier PASS for this exact deliverable) AND (on-chain verbatim re-check).
import { test, before } from 'node:test';
import { world, K, addr, acct, assert, units, stringToHex, walletSig } from './helpers.mjs';
import { sourcesRoot, questionHash, deliverableHash, requestHash, locate } from '../sdk/index.mjs';

const ZERO32 = '0x' + '00'.repeat(32);
const ZERO = '0x0000000000000000000000000000000000000000';
const DOCS = ['Fees are due in thirty days. Late fees apply.', 'The agentURI MUST resolve to the registration file.'];
const Q = 'What must the agentURI resolve to?';
const ANSWER = 'The agentURI MUST resolve to the registration file.';
const claimOf = (doc, phrase, docs = DOCS) => ({ doc, ...locate(docs[doc], phrase) });
const GOOD = { answer: ANSWER, claims: [claimOf(1, ANSWER)] };

let w, token, identity, validation, market, gate, L, PRICE;

before(async () => {
  w = await world();
  token = await w.deploy('MockUSD8');
  identity = await w.deploy('AgentIdentityRegistry');
  validation = await w.deploy('ValidationRegistry', [identity]);
  market = await w.deploy('Fallmarket', [identity, validation]);
  gate = await w.deploy('FulfilmentGate', [token, identity, validation, market]);
  for (const who of ['alice', 'bob', 'carol']) await w.ok(w.send(K[who], identity, 'AgentIdentityRegistry', 'register', [`ipfs://${who}`]));
  await w.ok(w.send(K.owner, token, 'MockUSD8', 'mint', [addr.alice, units(1000)]));
  await w.ok(w.send(K.alice, token, 'MockUSD8', 'approve', [gate, units(1000)]));
  PRICE = units(1);
  L = await list();
});

async function list(price = PRICE) {
  const r = await w.ok(w.send(K.bob, market, 'Fallmarket', 'list', [2n, addr.validator, price, (await w.chain.time()) + 30n * 86400n, 'terms']));
  return w.ev(r, 'Listed')[0].args.listingId;
}
async function openJob({ docs = DOCS, q = Q, deadlineIn = 86400n, listing } = {}) {
  const deadline = (await w.chain.time()) + deadlineIn;
  const r = await w.ok(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [listing ?? L, 1n, questionHash(q), sourcesRoot(docs), deadline]));
  return { id: w.ev(r, 'JobOpened')[0].args.jobId, deadline, docs, q, r };
}
async function submit(job, d, who = K.bob) {
  const dh = deliverableHash(job.q, d.answer, d.claims);
  await w.ok(w.send(who, gate, 'FulfilmentGate', 'submit', [job.id, dh, 'data:deliverable']));
  return requestHash(w.chain.chainId, gate, job.id, dh);
}
async function validate(rh, response, { validator = K.validator, agentId = 2n, requester = K.bob, respond = true } = {}) {
  const vAddr = Object.entries(K).find(([, k]) => k === validator)[0];
  await w.ok(w.send(requester, validation, 'ValidationRegistry', 'validationRequest', [addr[vAddr], agentId, 'data:req', rh]));
  if (respond) await w.ok(w.send(validator, validation, 'ValidationRegistry', 'validationResponse', [rh, response, '', ZERO32, 'docdec-verbatim-v1']));
}
const release = (job, d, docs = job.docs, from = K.carol) =>
  w.send(from, gate, 'FulfilmentGate', 'release', [job.id, docs.map(stringToHex), stringToHex(d.answer), d.claims], { allowRevert: true });
const refund = (job) => w.send(K.carol, gate, 'FulfilmentGate', 'refund', [job.id], { allowRevert: true });
const bal = (a) => w.read(token, 'MockUSD8', 'balanceOf', [a]);
const state = async (job) => Number((await w.read(gate, 'FulfilmentGate', 'getJob', [job.id])).state);
async function passed(d = GOOD, opts = {}) {
  const job = await openJob(opts);
  await validate(await submit(job, d), 100);
  return job;
}

// ── the happy path ──────────────────────────────────────────────────────────
test('open escrows exactly the listing price and records the job', async () => {
  const before = await bal(gate);
  const job = await openJob();
  assert.equal((await bal(gate)) - before, PRICE);
  const e = w.ev(job.r, 'JobOpened')[0].args;
  assert.equal(e.listingId, L);
  assert.equal(e.buyerAgentId, 1n);
  assert.equal(e.amount, PRICE);
  assert.equal(e.sourcesRoot, sourcesRoot(DOCS));
  assert.equal(e.deadline, job.deadline);
  const j = await w.read(gate, 'FulfilmentGate', 'getJob', [job.id]);
  assert.equal(j.workerAgentId, 2n);
  assert.equal(j.validator, addr.validator);
  assert.equal(j.buyer, addr.alice);
  assert.equal(j.questionHash, questionHash(Q));
  assert.equal(j.state, 1);
});

test('verifier PASS + verbatim re-check releases the escrow to the worker\'s agentWallet', async () => {
  const job = await passed();
  const before = await bal(addr.bob);
  const r = await w.ok(release(job, GOOD));
  assert.equal((await bal(addr.bob)) - before, PRICE);
  const e = w.ev(r, 'Released')[0].args;
  assert.equal(e.jobId, job.id);
  assert.equal(e.to, addr.bob);
  assert.equal(e.amount, PRICE);
  assert.equal(e.claims, 1n);
  assert.equal(await state(job), 3);
  await w.reverts(release(job, GOOD), 'BadState');
});

test('two claims from two documents, joined by one space, release', async () => {
  const a = 'Late fees apply.';
  const d = { answer: `${a} ${ANSWER}`, claims: [claimOf(0, a), claimOf(1, ANSWER)] };
  const job = await passed(d);
  await w.ok(release(job, d));
});

test('the views hash exactly as the SDK does', async () => {
  const job = await openJob();
  const dh = deliverableHash(Q, GOOD.answer, GOOD.claims);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'deliverableHashOf', [questionHash(Q), stringToHex(GOOD.answer), GOOD.claims]), dh);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'requestHashOf', [job.id, dh]), requestHash(w.chain.chainId, gate, job.id, dh));
});

// ── openJob guards ──────────────────────────────────────────────────────────
test('openJob refuses a listing that is not live', async () => {
  await w.reverts(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [999n, 1n, questionHash(Q), sourcesRoot(DOCS), (await w.chain.time()) + 100n], { allowRevert: true }), 'ListingNotLive');
  const l2 = await list();
  await w.ok(w.send(K.bob, market, 'Fallmarket', 'delist', [l2]));
  await w.reverts(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [l2, 1n, questionHash(Q), sourcesRoot(DOCS), (await w.chain.time()) + 100n], { allowRevert: true }), 'ListingNotLive');
});

test('openJob must come from the buyer agent\'s ERC-8004 agentWallet', async () => {
  await w.reverts(w.send(K.carol, gate, 'FulfilmentGate', 'openJob', [L, 1n, questionHash(Q), sourcesRoot(DOCS), (await w.chain.time()) + 100n], { allowRevert: true }), 'NotAgentWallet');
});

test('openJob refuses an empty question hash or an empty sources root', async () => {
  const t = (await w.chain.time()) + 100n;
  await w.reverts(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [L, 1n, ZERO32, sourcesRoot(DOCS), t], { allowRevert: true }), 'EmptyHash');
  await w.reverts(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [L, 1n, questionHash(Q), ZERO32, t], { allowRevert: true }), 'EmptyHash');
});

test('openJob deadline: now is refused, now + 7 days is the inclusive limit', async () => {
  const MAX = await w.read(gate, 'FulfilmentGate', 'MAX_DURATION');
  assert.equal(MAX, 7n * 86400n);
  const now = await w.chain.time();
  await w.reverts(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [L, 1n, questionHash(Q), sourcesRoot(DOCS), now], { allowRevert: true }), 'BadDeadline');
  const now2 = await w.chain.time();
  await w.reverts(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [L, 1n, questionHash(Q), sourcesRoot(DOCS), now2 + MAX + 1n], { allowRevert: true }), 'BadDeadline');
  const now3 = await w.chain.time();
  await w.ok(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [L, 1n, questionHash(Q), sourcesRoot(DOCS), now3 + MAX]));
  const now4 = await w.chain.time();
  await w.ok(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [L, 1n, questionHash(Q), sourcesRoot(DOCS), now4 + 1n]));
});

test('openJob refuses a token that returns false, or one that skims a fee', async () => {
  for (const mode of [1, 2]) {
    await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [mode]));
    try {
      await w.reverts(w.send(K.alice, gate, 'FulfilmentGate', 'openJob', [L, 1n, questionHash(Q), sourcesRoot(DOCS), (await w.chain.time()) + 100n], { allowRevert: true }), 'TransferFailed');
    } finally {
      await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [0]));
    }
  }
});

// ── submit guards ───────────────────────────────────────────────────────────
test('submit: only the worker agent\'s owner or operator; resubmission allowed; empty hash refused', async () => {
  const job = await openJob();
  const dh = deliverableHash(Q, GOOD.answer, GOOD.claims);
  await w.reverts(w.send(K.carol, gate, 'FulfilmentGate', 'submit', [job.id, dh, 'x'], { allowRevert: true }), 'NotAuthorized');
  await w.reverts(w.send(K.bob, gate, 'FulfilmentGate', 'submit', [job.id, ZERO32, 'x'], { allowRevert: true }), 'EmptyHash');
  const r = await w.ok(w.send(K.bob, gate, 'FulfilmentGate', 'submit', [job.id, dh, 'data:first']));
  const e = w.ev(r, 'DeliverableSubmitted')[0].args;
  assert.equal(e.deliverableHash, dh);
  assert.equal(e.requestHash, requestHash(w.chain.chainId, gate, job.id, dh));
  assert.equal(e.deliverableURI, 'data:first');
  assert.equal(await state(job), 2);
  await w.ok(w.send(K.bob, gate, 'FulfilmentGate', 'submit', [job.id, dh, 'data:second']));
  assert.equal(await state(job), 2);
});

test('submit: allowed at the deadline, refused after it; unknown job refused', async () => {
  const job = await openJob({ deadlineIn: 10n });
  const dh = deliverableHash(Q, GOOD.answer, GOOD.claims);
  await w.chain.advance(Number(job.deadline - (await w.chain.time())));
  await w.ok(w.send(K.bob, gate, 'FulfilmentGate', 'submit', [job.id, dh, 'x']));
  await w.reverts(w.send(K.bob, gate, 'FulfilmentGate', 'submit', [job.id, dh, 'x'], { allowRevert: true }), 'PastDeadline');
  await w.reverts(w.send(K.bob, gate, 'FulfilmentGate', 'submit', [999n, dh, 'x'], { allowRevert: true }), 'NoSuchJob');
});

test('submit after release or refund is refused', async () => {
  const job = await passed();
  await w.ok(release(job, GOOD));
  await w.reverts(w.send(K.bob, gate, 'FulfilmentGate', 'submit', [job.id, deliverableHash(Q, 'x', []), 'x'], { allowRevert: true }), 'BadState');
});

// ── release: the verifier's signature ───────────────────────────────────────
test('release without any validation, or with a request nobody answered, is NotValidated(0)', async () => {
  const job = await openJob();
  await w.reverts(release(job, GOOD), 'BadState'); // nothing submitted yet
  const rh = await submit(job, GOOD);
  await w.reverts(release(job, GOOD), 'NotValidated', [0]);
  await validate(rh, 0, { respond: false });
  await w.reverts(release(job, GOOD), 'NotValidated', [0]);
});

test('a verdict of 99 is not a pass; 100 is', async () => {
  const job = await openJob();
  const rh = await submit(job, GOOD);
  await validate(rh, 99);
  await w.reverts(release(job, GOOD), 'NotValidated', [99]);
  await w.ok(w.send(K.validator, validation, 'ValidationRegistry', 'validationResponse', [rh, 100, '', ZERO32, 't']));
  await w.ok(release(job, GOOD));
});

test('a PASS from someone other than the listing\'s validator does not count', async () => {
  const job = await openJob();
  const rh = await submit(job, GOOD);
  await validate(rh, 100, { validator: K.carol });
  await w.reverts(release(job, GOOD), 'NotValidated', [100]);
});

test('a front-runner\'s agent claiming the request hash cannot get the job paid (and cannot be paid)', async () => {
  const job = await openJob();
  const rh = await submit(job, GOOD);
  await validate(rh, 100, { requester: K.carol, agentId: 3n }); // carol's agent #3 claims bob's hash first
  await w.reverts(release(job, GOOD), 'NotValidated', [100]);
});

// ── release: the chain's own verbatim re-check ──────────────────────────────
test('sources must hash to the committed root; 0 or 17 documents are refused', async () => {
  const job = await passed();
  await w.reverts(release(job, GOOD, [DOCS[0], DOCS[1] + ' ']), 'SourcesMismatch');
  await w.reverts(release(job, GOOD, []), 'BadSources');
  await w.reverts(release(job, GOOD, Array(17).fill(DOCS[1])), 'BadSources');
  await w.reverts(release(job, GOOD, [DOCS[1], DOCS[0]]), 'SourcesMismatch');
});

test('16 documents is the inclusive limit', async () => {
  const docs = Array.from({ length: 16 }, (_, i) => `Document ${i}: the agentURI MUST resolve to the registration file.`);
  const phrase = 'the agentURI MUST resolve to the registration file.';
  const d = { answer: phrase, claims: [claimOf(15, phrase, docs)] };
  const job = await passed(d, { docs });
  await w.ok(release(job, d));
});

test('the answer and claims must be exactly the ones committed', async () => {
  const job = await passed();
  await w.reverts(release(job, { answer: ANSWER + ' ', claims: GOOD.claims }), 'DeliverableMismatch');
  await w.reverts(release(job, { answer: ANSWER, claims: [{ ...GOOD.claims[0], end: GOOD.claims[0].end - 1 }] }), 'DeliverableMismatch');
});

test('a reworded answer is refused on-chain even if a verifier wrongly signed PASS', async () => {
  const d = { answer: 'The agentURI has to resolve to the registration file.', claims: GOOD.claims };
  const job = await passed(d);
  await w.reverts(release(job, d), 'NotVerbatim');
});

test('a leading or doubled space between claims is not verbatim', async () => {
  const a = 'Late fees apply.';
  const d = { answer: `${a}  ${ANSWER}`, claims: [claimOf(0, a), claimOf(1, ANSWER)] };
  const job = await passed(d);
  await w.reverts(release(job, d), 'NotVerbatim');
});

test('no claims, or more than 8, cannot be paid even with a PASS; 8 can', async () => {
  const none = { answer: '', claims: [] };
  await w.reverts(release(await passed(none), none), 'NoClaims');
  const a = 'Late fees apply.';
  const c = claimOf(0, a);
  const nine = { answer: Array(9).fill(a).join(' '), claims: Array(9).fill(c) };
  await w.reverts(release(await passed(nine), nine), 'NoClaims');
  const eight = { answer: Array(8).fill(a).join(' '), claims: Array(8).fill(c) };
  await w.ok(release(await passed(eight), eight));
});

test('claim ranges: no such document, empty, past the end are BadClaim(i); ending exactly at the end is fine', async () => {
  const len = Buffer.byteLength(DOCS[1]);
  const cases = [
    [{ doc: 2, start: 0, end: 4 }, 0],
    [{ doc: 1, start: 4, end: 4 }, 0],
    [{ doc: 1, start: 5, end: 4 }, 0],
    [{ doc: 1, start: 0, end: len + 1 }, 0],
  ];
  for (const [c, i] of cases) {
    const d = { answer: 'x', claims: [c] };
    await w.reverts(release(await passed(d), d), 'BadClaim', [BigInt(i)]);
  }
  const second = { answer: 'x', claims: [GOOD.claims[0], { doc: 1, start: 0, end: len + 1 }] };
  await w.reverts(release(await passed(second), second), 'BadClaim', [1n]);
  const whole = { answer: DOCS[1], claims: [{ doc: 1, start: 0, end: len }] };
  await w.ok(release(await passed(whole), whole));
});

test('release refuses when the worker agent has no wallet set', async () => {
  const job = await passed();
  await w.ok(w.send(K.bob, identity, 'AgentIdentityRegistry', 'unsetAgentWallet', [2n]));
  try {
    await w.reverts(release(job, GOOD), 'WorkerWalletUnset');
  } finally {
    const dl = (await w.chain.time()) + 60n;
    await w.ok(w.send(K.bob, identity, 'AgentIdentityRegistry', 'setAgentWallet', [2n, addr.bob, dl, await walletSig(w, identity, 2n, addr.bob, acct.bob, dl)]));
  }
});

test('release refuses a token that will not pay out', async () => {
  const job = await passed();
  await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [1]));
  try {
    await w.reverts(release(job, GOOD), 'TransferFailed');
  } finally {
    await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [0]));
  }
});

// ── refund ──────────────────────────────────────────────────────────────────
test('a FAIL verdict refunds the buyer at once; a refunded job is closed', async () => {
  const job = await openJob();
  await validate(await submit(job, GOOD), 0);
  const before = await bal(addr.alice);
  const r = await w.ok(refund(job));
  assert.equal((await bal(addr.alice)) - before, PRICE);
  const e = w.ev(r, 'Refunded')[0].args;
  assert.equal(e.reason, 'failed-validation');
  assert.equal(e.to, addr.alice);
  assert.equal(e.amount, PRICE);
  assert.equal(await state(job), 4);
  await w.reverts(refund(job), 'BadState');
  await w.reverts(release(job, GOOD), 'BadState');
});

test('99 is a fail and refunds; 100 and an unanswered request do not', async () => {
  const j99 = await openJob();
  await validate(await submit(j99, GOOD), 99);
  await w.ok(refund(j99));
  const j100 = await openJob();
  await validate(await submit(j100, GOOD), 100);
  await w.reverts(refund(j100), 'NotRefundable');
  const jNone = await openJob();
  await validate(await submit(jNone, GOOD), 0, { respond: false });
  await w.reverts(refund(jNone), 'NotRefundable');
  const jOther = await openJob();
  await validate(await submit(jOther, GOOD), 0, { validator: K.carol });
  await w.reverts(refund(jOther), 'NotRefundable');
});

test('an open job refunds only after its deadline (not at it); a submitted one too', async () => {
  const open = await openJob({ deadlineIn: 20n });
  await w.reverts(refund(open), 'NotRefundable');
  await w.chain.advance(Number(open.deadline - (await w.chain.time())));
  await w.reverts(refund(open), 'NotRefundable');
  const r = await w.ok(refund(open));
  assert.equal(w.ev(r, 'Refunded')[0].args.reason, 'deadline');
  const sub = await openJob({ deadlineIn: 20n });
  await submit(sub, GOOD);
  await w.chain.advance(30);
  assert.equal(w.ev(await w.ok(refund(sub)), 'Refunded')[0].args.reason, 'deadline');
});

test('a released job cannot be refunded; an unknown job cannot be refunded', async () => {
  const job = await passed();
  await w.ok(release(job, GOOD));
  await w.reverts(refund(job), 'BadState');
  await w.reverts(w.send(K.carol, gate, 'FulfilmentGate', 'refund', [999n], { allowRevert: true }), 'NoSuchJob');
});

test('refund refuses a token that will not pay out', async () => {
  const job = await openJob();
  await validate(await submit(job, GOOD), 0);
  await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [1]));
  try {
    await w.reverts(refund(job), 'TransferFailed');
  } finally {
    await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [0]));
  }
});

// ── constructor ─────────────────────────────────────────────────────────────
test('the gate refuses a zero address for any of its four dependencies', async () => {
  const deps = [token, identity, validation, market];
  for (let i = 0; i < 4; i++) {
    const args = deps.slice();
    args[i] = ZERO;
    await assert.rejects(w.chain.deploy(K.owner, w.art.FulfilmentGate, args), /ZeroAddress/);
  }
  assert.equal(await w.read(gate, 'FulfilmentGate', 'token'), token);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'identity'), identity);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'validation'), validation);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'market'), market);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'PASS'), 100);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'MAX_DOCS'), 16n);
  assert.equal(await w.read(gate, 'FulfilmentGate', 'MAX_CLAIMS'), 8n);
});
