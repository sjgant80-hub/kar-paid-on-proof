#!/usr/bin/env node
// mutation-gate.mjs — the whole gate in one command, and the receipt it leaves.
//   1. witness mutate   every gated file (kernels AND contracts) against that file's own suite
//   2. sol-mutate        every contract, with the Solidity operators witness does not flip
//   3. witness fuzz      every pure kernel: hostile input must never throw
// CLEAN means: no live survivor anywhere, every fuzzed function never throws, and each baselined
// (equivalent) mutant carries a written reason. Writes receipts/mutation-gate.json.
//
//   node tools/mutation-gate.mjs [--only <file>] [--skip-sol] [--witness <dir>]
// witness is taken from --witness, $WITNESS_DIR, ./.witness (CI clones the pinned tag there) or ../witness.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run as solRun } from './sol-mutate.mjs';

export const MAP = [
  { file: 'sdk/verify.mjs', tests: ['test/kernels.test.mjs'], fuzz: ['verifyDeliverable', 'terms', 'coverage', 'locate'] },
  { file: 'sdk/reader.mjs', tests: ['test/kernels.test.mjs'], fuzz: ['readAnswer', 'sentences'] },
  { file: 'sdk/policy.mjs', tests: ['test/kernels.test.mjs'], fuzz: ['checkSessionAction', 'screenInjection'] },
  { file: 'sdk/cost.mjs', tests: ['test/cost.test.mjs'], fuzz: ['staffTime'] },
  { file: 'contracts/FulfilmentGate.sol', tests: ['test/gate.test.mjs'], sol: true },
  { file: 'contracts/AgentAccount.sol', tests: ['test/account.test.mjs'], sol: true },
  { file: 'contracts/AgentIdentityRegistry.sol', tests: ['test/identity.test.mjs'], sol: true },
  { file: 'contracts/ValidationRegistry.sol', tests: ['test/validation.test.mjs'], sol: true },
  { file: 'contracts/Fallmarket.sol', tests: ['test/validation.test.mjs'], sol: true },
];

function witnessDir(argDir) {
  for (const d of [argDir, process.env.WITNESS_DIR, '.witness', '../witness']) {
    if (d && existsSync(join(d, 'witness.mjs'))) return resolve(d);
  }
  throw new Error('witness not found: clone github.com/sjgant80-hub/witness (pinned tag) into ./.witness');
}

function lastJson(text) {
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return null;
  }
}

const args = process.argv.slice(2);
const opt = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const only = opt('--only');
const W = witnessDir(opt('--witness'));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const receipt = { gate: 'kar-paid-on-proof mutation gate', started: new Date().toISOString(), witness: W.replace(/\\/g, '/').split('/').pop(), files: [] };
let clean = true;

for (const g of MAP) {
  if (only && g.file !== only) continue;
  const entry = { file: g.file, tests: g.tests };
  const w = spawnSync(process.execPath, [join(W, 'witness.mjs'), 'mutate', g.file, '--cap', '5000', '--timeout', '900000', '--test', process.execPath, '--test', '--test-concurrency=1', ...g.tests],
    { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  const wr = lastJson(w.stdout || '');
  entry.witness = wr ? { total: wr.total, killed: wr.killed, survived: wr.survived, ignored: wr.ignored, score: wr.score, clean: wr.clean } : { error: (w.stderr || '').slice(-800) };
  if (!wr || !wr.clean) clean = false;
  console.error(`witness ${g.file}: ${wr ? `${wr.killed}/${wr.total} killed${wr.clean ? '' : `, ${wr.survived.length} SURVIVED`}` : 'DID NOT RUN'}`);

  if (g.sol && !args.includes('--skip-sol')) {
    const sr = solRun(g.file, g.tests);
    entry.solidity = sr;
    if (!sr.clean) clean = false;
    console.error(`sol-mutate ${g.file}: ${sr.killed}/${sr.total} killed${sr.clean ? '' : `, ${sr.survived.filter((s) => !s.baselined).length} SURVIVED`}`);
  }
  if (g.fuzz) {
    entry.fuzz = {};
    for (const fn of g.fuzz) {
      const f = spawnSync(process.execPath, [join(W, 'witness.mjs'), 'fuzz', g.file, fn], { encoding: 'utf8', env });
      const fr = lastJson(f.stdout || '');
      entry.fuzz[fn] = fr ? fr.neverThrows : false;
      if (!fr || !fr.neverThrows) clean = false;
    }
    console.error(`fuzz ${g.file}: ${Object.entries(entry.fuzz).map(([k, v]) => `${k} ${v ? 'never throws' : 'THROWS'}`).join(', ')}`);
  }
  receipt.files.push(entry);
}

receipt.finished = new Date().toISOString();
receipt.clean = clean;
const baseline = existsSync('mutation.baseline.json') ? JSON.parse(readFileSync('mutation.baseline.json', 'utf8')) : {};
receipt.baselineReasons = baseline;
mkdirSync('receipts', { recursive: true });
const out = only ? `receipts/mutation-${only.replace(/[\\/]/g, '_')}.json` : 'receipts/mutation-gate.json';
writeFileSync(out, JSON.stringify(receipt, null, 1) + '\n');
console.error(`\n${clean ? 'CLEAN' : 'NOT CLEAN'} -> ${out}`);
process.exit(clean ? 0 : 1);
