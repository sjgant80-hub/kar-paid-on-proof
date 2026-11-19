// The whole spine, end to end, on the in-process Shanghai EVM: the same code that runs on Aevum.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runFlow, ATTACKER, paraphrase } from '../lib/flow.mjs';
import { createLocalChain } from '../lib/chain-local.mjs';
import { LOCAL_KEYS, loadJob } from '../lib/setup.mjs';
import { artifacts } from './helpers.mjs';
import { compileAll, cancunOpcodes, stripMetadata, DEPLOYABLE } from '../tools/compile.mjs';

test('the full flow runs end to end and every check holds', async () => {
  const art = await artifacts();
  const chain = await createLocalChain({ abis: Object.values(art).map((a) => a.abi), fund: [LOCAL_KEYS.principal] });
  const trail = await runFlow(chain, { keys: LOCAL_KEYS, art, job: loadJob() });
  assert.ok(trail.checks.length >= 20);
  assert.ok(trail.checks.every((c) => c.ok));
  const refused = trail.steps.filter((s) => s.status === 'reverted').map((s) => s.error.name);
  assert.deepEqual(refused, ['RecipientNotAllowed', 'OverCap', 'NotValidated', 'SessionNotActive']);
  assert.equal(trail.final.balances.attacker, '0.00');
  assert.equal(trail.final.balances.gate, '0.00');
  assert.equal(trail.final.balances.worker, '1.00');
  assert.equal(trail.final.balances.agentAccount, '1.00');
  assert.deepEqual(trail.final.session, { cap: '2.00', spent: '2.00', active: false });
  assert.deepEqual(trail.final.workerValidations, { count: 2, average: 50 });
  assert.equal(trail.final.listingLive, false);
  assert.deepEqual(trail.final.jobs, { job1: 3, job2: 4 });
  assert.equal(trail.screen.flagged, true);
  assert.equal(trail.roles.attacker, ATTACKER);
  for (const s of trail.steps) assert.match(s.hash, /^0x[0-9a-f]{64}$/);
});

test('paraphrase always changes the words', () => {
  assert.notEqual(paraphrase({ answer: 'The x MUST y.', claims: [] }).answer, 'The x MUST y.');
  assert.notEqual(paraphrase({ answer: 'No modal verb here.', claims: [] }).answer, 'No modal verb here.');
});

test('the committed artifacts are exactly what the current sources compile to (no drift)', async () => {
  const fresh = await compileAll();
  for (const name of DEPLOYABLE) {
    const committed = JSON.parse(readFileSync(new URL(`../artifacts/${name}.json`, import.meta.url), 'utf8'));
    assert.equal(committed.bytecode, fresh[name].bytecode, `${name} artifact is stale: run npm run build`);
    assert.equal(committed.settings.evmVersion, 'shanghai');
  }
});

test('the Shanghai check catches Cancun opcodes, skips PUSH data, and strips the metadata trailer', () => {
  assert.deepEqual(cancunOpcodes('0x5e', false), ['MCOPY']);
  assert.deepEqual(cancunOpcodes('0x5c5d4a49', false), ['TLOAD', 'TSTORE', 'BLOBBASEFEE', 'BLOBHASH']);
  assert.deepEqual(cancunOpcodes('0x605e', false), []); // PUSH1 0x5e is data
  assert.deepEqual(cancunOpcodes('0x7f' + '5e'.repeat(32) + '00', false), []);
  // code 0x00 + trailer [0x5e] + length 0x0001: the 0x5e lives in the trailer and is ignored
  assert.deepEqual(cancunOpcodes('0x005e0001'), []);
  assert.deepEqual([...stripMetadata(Buffer.from('005e0001', 'hex'))], [0]);
  assert.deepEqual([...stripMetadata(Buffer.from('00', 'hex'))], [0]);
  assert.deepEqual([...stripMetadata(Buffer.from('00ff00', 'hex'))], [0, 0xff, 0]);
});
