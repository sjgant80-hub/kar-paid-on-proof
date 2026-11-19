// The testnet pipeline, proven before the testnet run exists: receipts re-read from a chain (a stub here; the
// live node in `tools/aevum-go.mjs --rehearse`), the record filled from them, and the page flipped to Aevum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyTrail } from '../lib/aevum-verify.mjs';
import { fillClaims, fillReadme, p12Text, standIn } from '../lib/record-fill.mjs';
import { buildPage, loadPageData, bake } from '../tools/build-page.mjs';

const local = JSON.parse(readFileSync('runs/local.json', 'utf8'));
const aevum = standIn(local);
const noWait = { retries: 1, wait: async () => {} };

function stubChain(trail, { chainId = 44005, edit = () => {} } = {}) {
  const receipts = new Map(trail.steps.map((s) => [s.hash, { status: s.status, blockNumber: BigInt(s.block), contractAddress: s.contract ?? null }]));
  edit(receipts);
  return {
    getChainId: async () => chainId,
    getTransactionReceipt: async ({ hash }) => {
      if (!receipts.has(hash)) throw new Error('TransactionReceiptNotFoundError');
      return receipts.get(hash);
    },
  };
}
const allMatch = (t) => ({ ok: true, matched: t.steps.length, total: t.steps.length, mismatches: [] });

test('every step matching its receipt verifies', async () => {
  const v = await verifyTrail(stubChain(aevum), aevum, null, noWait);
  assert.equal(v.ok, true);
  assert.equal(v.matched, aevum.steps.length);
  assert.deepEqual(v.mismatches, []);
});

test('a missing receipt, a wrong status, a wrong block, a wrong contract and a wrong chain are each caught', async () => {
  const [s0, , s2] = aevum.steps;
  const refused = aevum.steps.find((s) => s.status === 'reverted');
  const v = await verifyTrail(stubChain(aevum, { chainId: 1, edit: (m) => {
    m.delete(s0.hash);
    m.get(s2.hash).contractAddress = '0x0000000000000000000000000000000000000009';
    m.get(refused.hash).status = 'success';
    m.get(aevum.steps.at(-1).hash).blockNumber = 999999n;
  } }), aevum, null, noWait);
  assert.equal(v.ok, false);
  const what = v.mismatches.map((m) => m.what).join(' | ');
  assert.match(what, /chainId|no receipt on the chain/);
  assert.ok(v.mismatches.some((m) => m.what === 'chainId'));
  assert.ok(v.mismatches.some((m) => m.hash === s0.hash && m.what === 'no receipt on the chain'));
  assert.ok(v.mismatches.some((m) => m.hash === s2.hash && /contract/.test(m.what)));
  assert.ok(v.mismatches.some((m) => m.hash === refused.hash && /status reverted recorded, success on chain/.test(m.what)));
  assert.ok(v.mismatches.some((m) => /block \d+ recorded, 999999 on chain/.test(m.what)));
  assert.equal(v.matched, aevum.steps.length - 4);
});

test('the prediction is scored against where the contracts landed; a miss is named', async () => {
  const predicted = { AgentIdentityRegistry: aevum.contracts.AgentIdentityRegistry, FulfilmentGate: '0x00000000000000000000000000000000000000ff' };
  const v = await verifyTrail(stubChain(aevum), aevum, { predicted, deployerNonce: 0 }, noWait);
  assert.equal(v.predicted.total, 2);
  assert.equal(v.predicted.matched, 1);
  assert.deepEqual(v.predicted.misses.map((m) => m.contract), ['FulfilmentGate']);
});

test('P12 is written PASS only when every hash re-read matches and every check passed; otherwise FAIL with the reasons', () => {
  assert.match(p12Text(aevum, allMatch(aevum)), /^PASS on QDay Aevum testnet/);
  const bad = { ok: false, matched: 31, total: 32, mismatches: [{ step: 'S8', what: 'no receipt on the chain' }] };
  const t = p12Text(aevum, bad);
  assert.match(t, /^FAIL/);
  assert.match(t, /31\/32/);
  assert.match(t, /S8 no receipt on the chain/);
  const failedCheck = { ...aevum, checks: [...aevum.checks.slice(1), { name: 'x', ok: false }] };
  assert.match(p12Text(failedCheck, allMatch(aevum)), /^FAIL/);
  assert.match(p12Text(aevum, null), /^FAIL.*not yet re-read/);
});

test('P12 links the injection refusals, the release, the unproven release, the refund and the revoked key', () => {
  const t = p12Text(aevum, allMatch(aevum));
  for (const s of aevum.steps.filter((x) => x.status === 'reverted')) assert.ok(t.includes(s.hash), s.label);
  assert.ok(t.includes(aevum.steps.find((s) => s.step === 'S8').hash));
  assert.match(t, /RecipientNotAllowed/);
  assert.match(t, /OverCap/);
  assert.match(t, /NotValidated/);
});

test('CLAIMS.md and README.md are filled between their markers and nowhere else', () => {
  const claims = readFileSync('CLAIMS.md', 'utf8');
  const readme = readFileSync('README.md', 'utf8');
  const c = fillClaims(claims, aevum, allMatch(aevum));
  const r = fillReadme(readme, aevum, allMatch(aevum));
  for (const s of aevum.steps) assert.ok(c.includes(`https://explorer-test.qday.info/tx/${s.hash}`), s.label);
  assert.match(c, /<!--P12-->PASS on QDay Aevum testnet/);
  assert.equal(c.slice(0, c.indexOf('<!--P12-->')), claims.slice(0, claims.indexOf('<!--P12-->')));
  assert.equal(c.slice(c.indexOf('<!--/AEVUM-RESULTS-->')), claims.slice(claims.indexOf('<!--/AEVUM-RESULTS-->')));
  for (const n of ['AgentIdentityRegistry', 'ValidationRegistry', 'Fallmarket', 'FulfilmentGate', 'AgentAccount']) assert.ok(r.includes(`/address/${aevum.contracts[n]}`), n);
  assert.equal(r.slice(r.indexOf('<!--/AEVUM-ADDRESSES-->')), readme.slice(readme.indexOf('<!--/AEVUM-ADDRESSES-->')));
  assert.throws(() => fillClaims('no markers here', aevum, allMatch(aevum)), /marker/);
});

test('the page flips to Aevum from the trail alone: recorded panel, explorer links, no pending text', () => {
  const data = loadPageData();
  const page = buildPage({ ...data, onAevum: true, trail: aevum, verify: allMatch(aevum) });
  for (const s of aevum.steps) assert.ok(page.includes(`https://explorer-test.qday.info/tx/${s.hash}`), s.label);
  assert.match(page, /<span class="pill ok">recorded<\/span>/);
  assert.doesNotMatch(page.slice(0, page.indexOf('<script type="module">')), /pill warn">pending/);
  assert.doesNotMatch(page, /\{\{[\w.-]+\}\}/);
});

test('the committed page is the local run today, with the pending Aevum panel', () => {
  const page = readFileSync('index.html', 'utf8');
  const index = JSON.parse(readFileSync('runs/index.json', 'utf8'));
  if (index.aevum) return; // after the testnet run this is covered by page-parity instead
  assert.match(page, /pill warn">pending<\/span> <b>On QDay Aevum testnet: the run is not recorded yet/);
  assert.doesNotMatch(page, /explorer-test\.qday\.info\/tx\//);
});

test('the bake refuses a marker with no value and a value with no marker', () => {
  assert.throws(() => bake('<p>{{nope}}</p>', {}), /has no value/);
  assert.throws(() => bake('<p></p>', { extra: 'x' }), /no marker/);
  assert.equal(bake('<p>{{a}}</p>', { a: '$&' }), '<p>$&</p>');
});
