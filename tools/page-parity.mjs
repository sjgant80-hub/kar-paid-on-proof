// page-parity.mjs — the live page runs the gated kernels, not a copy that drifted, and shows the recorded run.
// 1. index.html must equal a fresh build from page/template.html + the committed run + the kernels.
// 2. each kernel's and the renderer's body (imports dropped, `export ` stripped) must appear in index.html verbatim.
// 3. the inlined code must actually run: evaluate it, replay the verifier on the job fixture, and re-render the
//    run with the inlined renderer: it must produce the exact timeline baked into the page.
// 4. no placeholder survives the bake: no {{marker}}, no "Loading…", no empty verdict.
import { readFileSync } from 'node:fs';
import { buildPage, inlineBody, INLINED, loadPageData } from './build-page.mjs';

const page = readFileSync('index.html', 'utf8').replace(/\r\n/g, '\n');
const data = loadPageData();
let bad = 0;
const fail = (m) => { console.error('✗ ' + m); bad++; };
if (page !== buildPage(data)) fail('index.html is stale: run node tools/build-page.mjs');
for (const k of INLINED) if (!page.includes(inlineBody(readFileSync(k, 'utf8')))) fail(`${k} is not inlined byte for byte`);

const script = INLINED.map((k) => inlineBody(readFileSync(k, 'utf8'))).join('\n');
const run = new Function(`${script}; return { verifyDeliverable, readAnswer, checkSessionAction, screenInjection, staffTime, runView };`)();
const job = data.job;
const sources = job.sources.map((s) => s.text);
const d = run.readAnswer(job.question, sources);
const v = run.verifyDeliverable({ question: job.question, sources, deliverable: d });
if (v.verdict !== 'PASS') fail('the inlined verifier does not pass the fixture answer');
if (!run.screenInjection(job.injection).flagged) fail('the inlined screen misses the fixture injection');
const tl = run.runView(data.trail, { dryrun: data.dryrun, verify: data.verify }).timeline;
if (!page.includes(`<ul class="tl" id="timeline">${tl}</ul>`)) fail('the inlined renderer does not reproduce the baked timeline');
for (const s of data.trail.steps) if (!page.includes(s.hash.slice(0, 10))) fail(`step ${s.step} hash ${s.hash} is not on the page`);

const html = page.slice(0, page.indexOf('<script type="module">'));
if (/\{\{[\w.-]+\}\}/.test(page)) fail('a {{marker}} survived the bake');
if (/Loading…|loading the run/.test(html)) fail('a loading placeholder survived the bake');
if (/>…</.test(html)) fail('an empty "…" placeholder survived the bake');
for (const id of ['vout', 'wout', 'iout']) if (!new RegExp(`class="verdict (PASS|FAIL|REFUSE)" id="${id}"`).test(html)) fail(`#${id} has no baked verdict`);

if (bad) process.exit(1);
console.log(`✓ page parity: ${INLINED.length} files inlined byte for byte; baked from runs/${data.onAevum ? 'aevum' : 'local'}.json (${data.trail.steps.length} transactions, every hash on the page); the inlined verifier passes the fixture and the inlined renderer reproduces the baked timeline; no placeholder left`);
