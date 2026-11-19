#!/usr/bin/env node
// sol-mutate.mjs — the Solidity half of the mutation gate. witness (the estate's gate) flips the operators
// it knows (>, >=, <, <=, ==, &&, ||, return true/false, +1/-1). Solidity guards lean on operators witness
// does not flip, so this adds them, one single-point mutant at a time:
//   != -> ==      += <-> -=      ++ -> --      revert X(...);  -> {}      if (!x) -> if (x)      true <-> false
// Each mutant is written into the file, the file's own test suite runs, and the original is restored.
// A mutant the tests do not catch SURVIVES and fails the gate, unless it is listed in
// mutation.baseline.json with a written reason (an equivalent mutant: no test can tell it apart).
//
//   node tools/sol-mutate.mjs <file.sol> <test files...> [--timeout ms]
//
// Crash-safe like witness: the true original is kept in <file>.orig until the run ends, and restored
// from there on the next run if a previous run was killed mid-mutant.

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const OPS = [
  { name: '!= -> ==', re: / != /g, to: ' == ' },
  { name: '+= -> -=', re: / \+= /g, to: ' -= ' },
  { name: '-= -> +=', re: / -= /g, to: ' += ' },
  { name: '++ -> --', re: /\+\+/g, to: '--' },
  { name: 'delete revert', re: /revert [A-Z]\w*\([^;]*\);/g, to: '{}' },
  { name: 'drop !', re: /\(!(?=[\w_])/g, to: '(' },
  { name: 'true -> false', re: /(?<![\w.])true(?![\w])/g, to: 'false', skip: /return true/ },
  { name: 'false -> true', re: /(?<![\w.])false(?![\w])/g, to: 'true', skip: /return false/ },
];

// Mask comments and string literals: a mutant there is not a mutant.
export function codeMask(src) {
  const mask = new Uint8Array(src.length);
  let i = 0;
  while (i < src.length) {
    if (src.startsWith('//', i)) {
      while (i < src.length && src[i] !== '\n') mask[i++] = 1;
    } else if (src.startsWith('/*', i)) {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      while (i < stop) mask[i++] = 1;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      mask[i++] = 1;
      while (i < src.length && src[i] !== q) {
        if (src[i] === '\\') mask[i++] = 1;
        mask[i++] = 1;
      }
      if (i < src.length) mask[i++] = 1;
    } else {
      i++;
    }
  }
  return mask;
}

export function solMutants(src) {
  const mask = codeMask(src);
  const out = [];
  for (const op of OPS) {
    op.re.lastIndex = 0;
    let m;
    while ((m = op.re.exec(src)) !== null) {
      const at = m.index;
      if (mask[at]) continue;
      const lineStart = src.lastIndexOf('\n', at) + 1;
      const lineEnd = src.indexOf('\n', at);
      const lineText = src.slice(lineStart, lineEnd < 0 ? src.length : lineEnd);
      if (op.skip && op.skip.test(lineText)) continue;
      if (/^\s*pragma|^\s*import/.test(lineText)) continue;
      const line = src.slice(0, at).split('\n').length;
      out.push({ op: op.name, line, snippet: lineText.trim(), source: src.slice(0, at) + op.to + src.slice(at + m[0].length) });
    }
  }
  return out;
}

function loadBaseline(file) {
  const p = 'mutation.baseline.json';
  if (!existsSync(p)) return [];
  return (JSON.parse(readFileSync(p, 'utf8')).solidity || []).filter((b) => b.file === file);
}

export function run(file, tests, { timeout = 600000 } = {}) {
  const backup = file + '.orig';
  if (existsSync(backup)) writeFileSync(file, readFileSync(backup)); // heal from a killed run
  const original = readFileSync(file, 'utf8');
  writeFileSync(backup, original);
  const cmd = [process.execPath, ['--test', '--test-concurrency=1', ...tests]];
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    const base = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout, env });
    if (base.status !== 0) throw new Error(`the suite is not green on the original ${file}; fix that first\n${(base.stdout || '').slice(-2000)}`);
    const mutants = solMutants(original);
    const baseline = loadBaseline(file);
    const survived = [];
    let killed = 0;
    mutants.forEach((m, i) => {
      writeFileSync(file, m.source);
      const r = spawnSync(cmd[0], cmd[1], { encoding: 'utf8', timeout, env });
      if (r.status === 0) {
        const known = baseline.find((b) => b.line === m.line && b.op === m.op);
        survived.push({ line: m.line, op: m.op, snippet: m.snippet, baselined: Boolean(known), reason: known?.reason });
      } else {
        killed += 1;
      }
      process.stderr.write(`  [${i + 1}/${mutants.length}] ${r.status === 0 ? 'SURVIVED' : 'killed  '} ${file}:${m.line} ${m.op}\n`);
    });
    const live = survived.filter((s) => !s.baselined);
    return { file, total: mutants.length, killed, survived, score: mutants.length ? killed / mutants.length : 1, clean: live.length === 0 };
  } finally {
    writeFileSync(file, original);
    unlinkSync(backup);
  }
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/sol-mutate.mjs')) {
  const args = process.argv.slice(2);
  const ti = args.indexOf('--timeout');
  const timeout = ti >= 0 ? Number(args.splice(ti, 2)[1]) : undefined;
  const [file, ...tests] = args;
  const res = run(file, tests, { timeout });
  console.log(JSON.stringify(res, null, 1));
  process.exit(res.clean ? 0 : 1);
}
