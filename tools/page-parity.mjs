// page-parity.mjs — the live page runs the gated kernels, not a copy that drifted.
// 1. index.html must equal a fresh build from page/template.html + the kernels.
// 2. each kernel's body (imports dropped, `export ` stripped) must appear in index.html verbatim.
// 3. the inlined code must actually run: evaluate it and replay the verifier on the job fixture.
import { readFileSync } from 'node:fs';
import { buildPage, inlineBody, KERNELS } from './build-page.mjs';

const page = readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
let bad = 0;
if (page !== buildPage()) {
  console.error('✗ index.html is stale: run node tools/build-page.mjs');
  bad++;
}
for (const k of KERNELS) {
  if (!page.includes(inlineBody(readFileSync(k, 'utf8')))) {
    console.error(`✗ ${k} is not inlined byte for byte`);
    bad++;
  }
}
const script = KERNELS.map((k) => inlineBody(readFileSync(k, 'utf8'))).join('\n');
const run = new Function(`${script}; return { verifyDeliverable, readAnswer, checkSessionAction, screenInjection, staffTime };`)();
const job = JSON.parse(readFileSync('fixtures/job.json', 'utf8'));
const sources = job.sources.map((s) => s.text);
const d = run.readAnswer(job.question, sources);
const v = run.verifyDeliverable({ question: job.question, sources, deliverable: d });
if (v.verdict !== 'PASS') {
  console.error('✗ the inlined verifier does not pass the fixture answer');
  bad++;
}
if (!run.screenInjection(job.injection).flagged) {
  console.error('✗ the inlined screen misses the fixture injection');
  bad++;
}
if (bad) process.exit(1);
console.log(`✓ page parity: ${KERNELS.length} kernels inlined byte for byte; the inlined verifier passes the fixture (${d.answer.slice(0, 40)}…)`);
