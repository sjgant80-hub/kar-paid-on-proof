import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runView, verifyView, wallView, screenView, costView, claimsText, esc, DEPLOY_ORDER } from '../page/render.mjs';
import { staffTime } from '../sdk/cost.mjs';
import { standIn } from '../lib/record-fill.mjs';

const local = JSON.parse(readFileSync('runs/local.json', 'utf8'));
const job = JSON.parse(readFileSync('fixtures/job.json', 'utf8'));
const dry = {
  block: '3580561', deployGas: '6492844', gasPriceWei: '1000000000', deployCostTQDAY: '0.006492844', deployer: '0x622bfb7Ff057cE06DC50f38715d8Dd8291cdfCfa', deployerNonce: 0,
  rows: DEPLOY_ORDER.map((n, i) => ({ contract: n, gas: String(100000 + i), runtimeBytes: 1000 + i })),
  predicted: Object.fromEntries(DEPLOY_ORDER.map((n, i) => [n, '0x' + String(i + 1).padStart(40, '0')])),
};

test('the local run renders as local: pending Aevum panel, no explorer links, every hash shown', () => {
  const v = runView(local, { dryrun: dry });
  assert.match(v.badges, /SIMULATED local run · the testnet run is pending/);
  assert.match(v.badges, /32 transactions/);
  assert.match(v.badges, /4 refused on-chain/);
  assert.match(v.badges, /23\/23 checks/);
  assert.match(v.aevum, /pill warn">pending/);
  assert.match(v.aevum, /block 3580561/);
  assert.match(v.aevum, /6,492,844/);
  assert.doesNotMatch(v.timeline + v.contracts, /explorer-test\.qday\.info\/tx/);
  for (const s of local.steps) assert.ok(v.timeline.includes(s.hash.slice(0, 10)), s.label);
  assert.equal((v.timeline.match(/pill bad">refused/g) || []).length, 4);
});

test('the contracts table carries size, simulated gas, local address and the labelled Aevum prediction', () => {
  const v = runView(local, { dryrun: dry });
  assert.match(v.contracts, /predicted, not deployed yet/);
  for (const [i, n] of DEPLOY_ORDER.entries()) {
    assert.ok(v.contracts.includes(`<td>${n}</td><td class="num">${(1000 + i).toLocaleString('en-GB')}</td>`), n);
    assert.ok(v.contracts.includes(dry.predicted[n]), n + ' prediction');
    assert.ok(v.contracts.includes(local.contracts[n]), n + ' local address');
  }
  assert.match(v.contracts, /MockUSD8 \(local stand-in for tUSD8\)/);
});

test('without a dry run receipt nothing is invented: no prediction column, no simulated gas', () => {
  const v = runView(local, {});
  assert.doesNotMatch(v.contracts, /predicted/);
  assert.doesNotMatch(v.aevum, /simulated/);
  assert.doesNotMatch(v.cgas, /simulated/);
});

test('an Aevum run renders as recorded, with an explorer link for every hash and no prediction column', () => {
  const a = standIn(local);
  const v = runView(a, { dryrun: dry, verify: { matched: 32, total: 32, mismatches: [], predicted: { matched: 5, total: 5, misses: [] } } });
  assert.match(v.aevum, /pill ok">recorded/);
  assert.match(v.aevum, /32\/32 hashes checked against Aevum&#39;s own receipts/);
  assert.match(v.aevum, /5\/5 matched/);
  for (const s of a.steps) assert.ok(v.timeline.includes(`https://explorer-test.qday.info/tx/${s.hash}`), s.label);
  assert.doesNotMatch(v.contracts, /predicted/);
  assert.match(v.contracts, /tUSD8 \(QDay's test dollar\)/);
  assert.match(v.badges, /QDay Aevum testnet · chain 44005/);
  assert.match(v.boardTail, /running on QDay Aevum testnet/);
});

test('the verifier view: the paid answer passes, one changed word fails, unreadable claims refuse', () => {
  const p = local.deliverables.job1;
  assert.equal(verifyView(p.question, job.sources, p.answer, claimsText(p.claims)).cls, 'PASS');
  const bad = verifyView(p.question, job.sources, p.answer.replace('owner', 'banana'), claimsText(p.claims));
  assert.equal(bad.cls, 'FAIL');
  assert.match(bad.why, /The cited bytes actually say/);
  assert.notEqual(verifyView(p.question, job.sources, p.answer, '{not json').cls, 'PASS');
  assert.match(verifyView(p.question, job.sources, p.answer, claimsText(p.claims)).srcs, /<mark>/);
});

test('the wall view refuses exactly as the account does', () => {
  const gate = local.contracts.FulfilmentGate;
  assert.match(wallView({ to: 'bad', amount: '10000', spent: '1', revoked: false }, gate).text, /RecipientNotAllowed/);
  assert.match(wallView({ to: 'gate', amount: '10000', spent: '1', revoked: false }, gate).text, /OverCap/);
  assert.match(wallView({ to: 'token', amount: '1', spent: '0', revoked: false }, gate).text, /TokenCallForbidden/);
  assert.match(wallView({ to: 'gate', amount: '1', spent: '0', revoked: true }, gate).text, /SessionNotActive/);
  assert.equal(wallView({ to: 'gate', amount: '1', spent: '0', revoked: false }, gate).cls, 'PASS');
});

test('the screen view flags the fixture injection and passes plain text', () => {
  assert.equal(screenView(job.injection).cls, 'FAIL');
  assert.equal(screenView('The agentURI resolves to the registration file.').cls, 'PASS');
});

test('the cost view is the gated kernel, formatted; bad input shows a dash, not a number', () => {
  const r = staffTime({ jobsPerMonth: '2000', minutesPerCheck: '4', hourlyRate: '12.71' });
  const c = costView({ jobs: '2000', minutes: '4', rate: '12.71' });
  assert.equal(c.kpi, '£' + r.perYear.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  assert.match(c.text, /hours a month/);
  assert.equal(costView({ jobs: '-1', minutes: '4', rate: '' }).kpi, '—');
});

test('the hero is the testnet proof: pending says so plainly; recorded links the key transactions', () => {
  const p = runView(local, { dryrun: dry });
  assert.match(p.heroProof, /pill warn">pending/);
  assert.match(p.heroProof, /The testnet proof: not recorded yet/);
  assert.match(p.heroProof, /SIMULATED/);
  assert.match(p.runTitle, /SIMULATED/);
  assert.doesNotMatch(p.heroProof, /explorer-test\.qday\.info\/tx/);
  const a = standIn(local);
  const r = runView(a, { dryrun: dry, verify: { matched: 32, total: 32, mismatches: [] } });
  assert.match(r.heroProof, /on QDay Aevum testnet/);
  assert.doesNotMatch(r.heroProof + r.runTitle, /SIMULATED/);
  for (const name of ['RecipientNotAllowed', 'OverCap', 'NotValidated', 'SessionNotActive']) {
    const s = a.steps.find((x) => x.error?.name === name);
    assert.ok(r.heroProof.includes(`https://explorer-test.qday.info/tx/${s.hash}`), name);
  }
  assert.ok(r.heroProof.includes(a.steps.find((s) => s.step === 'S8').hash), 'release');
});

test('state changes: one row per snapshot, with block and every party; old runs say they have none', () => {
  const states = [
    { after: 'before', step: 'S0', block: 9, hash: local.steps[0].hash, balances: { principal: '10.00', agentAccount: '0.00', gate: '0.00', worker: '0.00', attacker: '0.00' } },
    { after: 'escrowed', step: 'S4', block: 17, hash: local.steps[16].hash, balances: { principal: '8.00', agentAccount: '1.00', gate: '1.00', worker: '0.00', attacker: '0.00' } },
  ];
  const v = runView({ ...local, states }, { dryrun: dry });
  assert.equal((v.states.match(/<tr>/g) || []).length, 3);
  assert.match(v.states, /escrowed/);
  assert.match(v.states, /<td class="num">1\.00<\/td><td class="num">1\.00<\/td>/);
  assert.match(runView({ ...standIn(local), states }, {}).states, /explorer-test\.qday\.info\/block\/17/);
  assert.match(runView({ ...local, states: undefined }, {}).states, /predates the balance snapshots/);
});

test('gas per step adds up to the whole run, priced as charged on Aevum or at the dry-run price, labelled', () => {
  const v = runView(local, { dryrun: dry });
  const total = local.steps.reduce((a, s) => a + Number(s.gasUsed), 0);
  assert.ok(v.gasSteps.includes(`<b>${total.toLocaleString('en-GB')}</b>`));
  assert.ok(v.gasSteps.includes(`<b>${((total * 1e9) / 1e18).toFixed(6)}</b>`));
  assert.match(v.gasNote, /SIMULATED/);
  const a = standIn(local);
  a.steps = a.steps.map((s) => ({ ...s, gasPrice: '1200000000' }));
  const r = runView(a, { dryrun: dry });
  assert.match(r.gasSteps, /as charged/);
  assert.ok(r.gasSteps.includes(`<b>${((total * 1.2e9) / 1e18).toFixed(6)}</b>`));
  assert.doesNotMatch(r.gasNote, /SIMULATED/);
});

test('the comparison carries per-unit numbers from the run and the calculator defaults', () => {
  const v = runView(local, { dryrun: dry, cost: { minutes: '4', rate: '12.71' } });
  assert.match(v.compare, /4 minutes a deliverable = £0\.85 at £12\.71 an hour/);
  assert.match(v.compare, /gas for one paid job end to end/);
  assert.match(v.compare, /0\.00 paid of 10,000 asked; 2 reverted transactions/);
  assert.match(v.compare, /32 public transactions/);
});

test('the explorer note says what the verifier attempt did, and only after an Aevum run', () => {
  assert.match(runView(local, {}).explorerNote, /starter kit reports/);
  const a = standIn(local);
  const ok = runView(a, { verify: { matched: 32, total: 32, mismatches: [], explorer: { results: [{ contract: 'FulfilmentGate', ok: true, url: 'https://explorer-test.qday.info/address/0x1?tab=contract' }, { contract: 'Fallmarket', ok: false, detail: 'HTTP 500' }] } } });
  assert.match(ok.explorerNote, /Source verified on explorer-test\.qday\.info for <a/);
  assert.match(ok.explorerNote, /not for Fallmarket \(HTTP 500\)/);
  const no = runView(a, { verify: { matched: 32, total: 32, mismatches: [], explorer: { results: [{ contract: 'FulfilmentGate', ok: false, detail: 'HTTP 404' }] } } });
  assert.match(no.explorerNote, /did not verify the source \(HTTP 404\)/);
});

test('esc escapes every HTML-significant character', () => {
  assert.equal(esc(`<a href="x">'&'</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
});
