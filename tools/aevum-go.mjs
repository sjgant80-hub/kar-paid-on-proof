// aevum-go.mjs — the whole testnet path in one command, so nothing is done by hand when the test gas lands:
//   1. the deployer holds enough test gas and tUSD8 (else stop: exit 3, nothing sent)
//   2. the read-only dry run (re-run only if the deployer's nonce moved since the committed one)
//   3. node flow.mjs --network aevum           -> runs/aevum.json + runs/index.json (a failed run keeps its partial trail)
//   4. every hash re-read from Aevum's receipts -> receipts/aevum-verify.json (mismatches listed, never dropped)
//   5. CLAIMS.md P12 + results table, README addresses, written from those files
//   6. index.html rebuilt from runs/aevum.json, and the page parity check
// It commits nothing: the files it lists are reviewed, then committed and pushed.
//
//   node tools/aevum-go.mjs              the real run (TEST keys from the env or .env.aevum; keys are never printed)
//   node tools/aevum-go.mjs --rehearse   read-only: dry run + the receipt checker against Aevum's live node + the page
//                                        flip and record fill on a stand-in trail, in memory. Sends nothing, needs no keys.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createPublicClient, http, parseAbi, formatUnits, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AEVUM, TUSD8 } from '../sdk/index.mjs';
import solc from 'solc';
import { verifyTrail } from '../lib/aevum-verify.mjs';
import { verifyOnExplorer } from '../lib/explorer-verify.mjs';
import { loadArtifacts } from '../lib/setup.mjs';
import { fillClaims, fillReadme, standIn } from '../lib/record-fill.mjs';
import { buildPage, loadPageData } from './build-page.mjs';

export const MIN_TQDAY = 0.1; // 0.04 goes to the worker and validator as gas; deploys + ~25 calls ≈ 0.015 at ~1.2 gwei
export const MIN_TUSD8 = 2; // the session cap: two jobs at 1.00

const rehearse = process.argv.includes('--rehearse');
const pub = createPublicClient({ chain: AEVUM, transport: http(process.env.AEVUM_RPC_URL || AEVUM.rpcUrls.default.http[0], { timeout: 60_000, retryCount: 5 }) });
const node = (args) => spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env }).status;
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

function principalAddress() {
  const env = { ...process.env };
  const file = process.env.KAR_KEYS_FILE || '.env.aevum';
  if (!env.KAR_PRINCIPAL_KEY && existsSync(file)) {
    const m = readFileSync(file, 'utf8').match(/^\s*KAR_PRINCIPAL_KEY\s*=\s*(0x[0-9a-fA-F]{64})\s*$/m);
    if (m) env.KAR_PRINCIPAL_KEY = m[1];
  }
  if (!env.KAR_PRINCIPAL_KEY) return null;
  return privateKeyToAccount(env.KAR_PRINCIPAL_KEY).address; // the address only; the key goes nowhere
}

async function balances(addr) {
  const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
  const gas = Number(formatUnits(await pub.getBalance({ address: addr }), 18));
  const usd = Number(formatUnits(await pub.readContract({ address: TUSD8, abi, functionName: 'balanceOf', args: [addr] }), 6));
  return { gas, usd };
}

if (rehearse) {
  const report = { at: new Date().toISOString(), rehearsal: true, sent: 'nothing', steps: [] };
  const say = (ok, what) => { report.steps.push({ ok, what }); console.log(`${ok ? '✓' : '✗'} ${what}`); };
  const dry = existsSync('receipts/aevum-dryrun.json') ? readJSON('receipts/aevum-dryrun.json') : null;
  const deployer = principalAddress() || dry?.deployer || null;
  say(node(['tools/aevum-dryrun.mjs', ...(deployer ? ['--deployer', deployer] : [])]) === 0, 'read-only dry run on Aevum: every contract deploys in simulation');
  // the receipt checker against Aevum's live node: one real transaction from the newest block must match,
  // and a hash that does not exist must be reported as missing
  let head = await pub.getBlock({ blockTag: 'latest', includeTransactions: true });
  for (let n = head.number; head.transactions.length === 0 && n > head.number - 200n; n--) head = await pub.getBlock({ blockNumber: n - 1n, includeTransactions: true });
  const real = head.transactions[0];
  const raw = await (await fetch(AEVUM.rpcUrls.default.http[0], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionReceipt', params: [real.hash] }) })).json();
  const probe = { chainId: 44005, steps: [
    { step: 'probe', label: 'a real Aevum transaction', hash: real.hash, block: Number(head.number), status: raw.result.status === '0x1' ? 'success' : 'reverted' },
    { step: 'probe', label: 'a hash that does not exist', hash: '0x' + '00'.repeat(31) + '01', block: 1, status: 'success' },
  ] };
  const v = await verifyTrail(pub, probe, null, { retries: 1 });
  say(v.chainId === 44005, `the node answers as chain ${v.chainId}`);
  say(v.matched === 1 && v.mismatches.length === 1 && v.mismatches[0].what === 'no receipt on the chain', `receipt checker on the live node: the real transaction ${real.hash.slice(0, 10)}… (block ${head.number}) matches; the made-up hash is reported missing`);
  // the page flip and the record fill, in memory, on a stand-in trail
  const data = loadPageData();
  const fake = standIn(data.trail);
  const page = buildPage({ ...data, onAevum: true, trail: fake, verify: { ok: true, matched: fake.steps.length, total: fake.steps.length, mismatches: [] } });
  const linked = fake.steps.filter((s) => page.includes(`${fake.explorer}/tx/${s.hash}`)).length;
  say(linked === fake.steps.length && page.includes('<span class="pill ok">recorded</span>'), `page flip: rebuilt from an Aevum trail, ${linked}/${fake.steps.length} hashes link to the explorer and the Aevum panel says recorded`);
  const claims = fillClaims(readFileSync('CLAIMS.md', 'utf8'), fake, { ok: true, matched: fake.steps.length, total: fake.steps.length, mismatches: [] });
  const readme = fillReadme(readFileSync('README.md', 'utf8'), fake, { matched: fake.steps.length, total: fake.steps.length });
  say(/<!--P12-->PASS on QDay Aevum testnet/.test(claims) && fake.steps.every((s) => claims.includes(s.hash)), 'record fill: P12 written as PASS with every hash in the results table (in memory only)');
  say(fake.contracts.FulfilmentGate && readme.includes(`${fake.explorer}/address/${fake.contracts.FulfilmentGate}`), 'README addresses written with explorer links (in memory only)');
  report.ok = report.steps.every((s) => s.ok);
  writeFileSync('receipts/aevum-rehearsal.json', JSON.stringify(report, null, 1) + '\n');
  console.log(report.ok ? '\nREHEARSAL CLEAN: when the deployer is funded, `node tools/aevum-go.mjs` does the rest (nothing was sent)' : '\nREHEARSAL FOUND A PROBLEM');
  process.exit(report.ok ? 0 : 1);
}

// ── the real run ─────────────────────────────────────────────────────────────
const P = principalAddress();
if (!P) {
  console.error('no KAR_PRINCIPAL_KEY in the env or the keys file: nothing to run');
  process.exit(2);
}
const b = await balances(P);
console.log(`deployer ${P}: ${b.gas} tQDAY · ${b.usd} tUSD8`);
if (b.gas < MIN_TQDAY || b.usd < MIN_TUSD8) {
  console.error(`NOT FUNDED: needs at least ${MIN_TQDAY} tQDAY and ${MIN_TUSD8} tUSD8. Nothing was sent.`);
  process.exit(3);
}
let dry = existsSync('receipts/aevum-dryrun.json') ? readJSON('receipts/aevum-dryrun.json') : null;
const nonce = await pub.getTransactionCount({ address: P });
if (!dry || !dry.deployer || getAddress(dry.deployer) !== getAddress(P) || dry.deployerNonce !== nonce) {
  if (node(['tools/aevum-dryrun.mjs', '--deployer', P]) !== 0) {
    console.error('the dry run failed: not sending anything');
    process.exit(1);
  }
  dry = readJSON('receipts/aevum-dryrun.json');
}
if (node(['flow.mjs', '--network', 'aevum']) !== 0) {
  console.error('THE TESTNET RUN FAILED. Its partial trail (if any) is in runs/aevum-failed-*.json; keep it in the record.');
  process.exit(1);
}
const trail = readJSON('runs/aevum.json');
const verify = await verifyTrail(pub, trail, dry);
// best effort: publish each contract's source on the explorer; the result is recorded either way
{
  const art = loadArtifacts();
  const c = trail.contracts;
  const ctorArgs = {
    AgentIdentityRegistry: [], ValidationRegistry: [c.AgentIdentityRegistry], Fallmarket: [c.AgentIdentityRegistry, c.ValidationRegistry],
    FulfilmentGate: [c.tUSD8, c.AgentIdentityRegistry, c.ValidationRegistry, c.Fallmarket], AgentAccount: [trail.roles.principal, c.tUSD8],
  };
  const compilerVersion = 'v' + solc.version().replace(/\.Emscripten.*$/, '');
  const results = [];
  for (const n of Object.keys(ctorArgs)) {
    const r = await verifyOnExplorer({ explorer: trail.explorer, address: c[n], contract: n, art: art[n], sourceText: readFileSync(art[n].source, 'utf8'), args: ctorArgs[n], compilerVersion });
    console.log(`explorer source verification, ${n}: ${r.ok ? 'verified' : r.detail}`);
    results.push(r);
  }
  verify.explorer = { attempted: new Date().toISOString(), compilerVersion, results };
}
writeFileSync('receipts/aevum-verify.json', JSON.stringify(verify, null, 1) + '\n');
console.log(`re-read from Aevum: ${verify.matched}/${verify.total} match${verify.predicted ? `; predicted addresses ${verify.predicted.matched}/${verify.predicted.total}` : ''}${verify.mismatches.length ? '; MISMATCHES: ' + JSON.stringify(verify.mismatches) : ''}`);
writeFileSync('CLAIMS.md', fillClaims(readFileSync('CLAIMS.md', 'utf8'), trail, verify));
writeFileSync('README.md', fillReadme(readFileSync('README.md', 'utf8'), trail, verify));
writeFileSync('index.html', buildPage());
const parity = node(['tools/page-parity.mjs']);
console.log(`\n${verify.ok && parity === 0 ? 'DONE' : 'DONE WITH PROBLEMS (see above)'}: review, then commit runs/aevum.json runs/index.json receipts/aevum-dryrun.json receipts/aevum-verify.json CLAIMS.md README.md index.html`);
process.exit(verify.ok && parity === 0 ? 0 : 1);
