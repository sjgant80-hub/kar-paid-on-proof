// build-page.mjs — index.html = page/template.html, baked and inlined:
//   1. every {{marker}} is replaced with what page/render.mjs renders from the recorded run (runs/aevum.json
//      when runs/index.json says it exists, else runs/local.json), the Aevum dry run, the mutation receipt and
//      the job fixture, so the page is complete before any script runs (and to readers that never run one);
//   2. the gated kernels and page/render.mjs are inlined byte for byte (import lines dropped, the `export `
//      keyword stripped; nothing else changes), so the page's playgrounds run the same code.
// page-parity.mjs proves both. A marker with no value, or a value with no marker, fails the build.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runView, verifyView, wallView, screenView, costView, claimsText, esc } from '../page/render.mjs';

export const KERNELS = ['sdk/verify.mjs', 'sdk/reader.mjs', 'sdk/policy.mjs', 'sdk/cost.mjs'];
export const RENDER = 'page/render.mjs';
export const INLINED = [...KERNELS, RENDER];

export function inlineBody(src) {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^import\s/.test(l))
    .join('\n')
    .replace(/^export /gm, '');
}

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const optJSON = (p) => (existsSync(p) ? readJSON(p) : null);

// everything the page is rendered from, all of it committed files
export function loadPageData() {
  const index = optJSON('runs/index.json') || {};
  return {
    onAevum: Boolean(index.aevum),
    trail: readJSON(index.aevum ? 'runs/aevum.json' : 'runs/local.json'),
    job: readJSON('fixtures/job.json'),
    dryrun: optJSON('receipts/aevum-dryrun.json'),
    verify: index.aevum ? optJSON('receipts/aevum-verify.json') : null,
    gate: optJSON('receipts/mutation-summary.json'),
  };
}

// the default value of an <input id="…" value="…"> in the template, so the baked worked example is always
// computed from the very defaults a visitor sees
export function inputDefault(tpl, id) {
  const m = tpl.match(new RegExp(`<input id="${id}"[^>]*\\svalue="([^"]*)"`));
  if (!m) throw new Error(`template has no default value for #${id}`);
  return m[1];
}

export function bakeValues(tpl, d) {
  const p = d.trail.deliverables.job1;
  const vv = verifyView(p.question, d.job.sources, p.answer, claimsText(p.claims));
  const w = wallView({ to: 'gate', amount: inputDefault(tpl, 'wa'), spent: inputDefault(tpl, 'ws'), revoked: false }, d.trail.contracts.FulfilmentGate);
  const s = screenView(d.job.injection);
  const c = costView({ jobs: inputDefault(tpl, 'cj'), minutes: inputDefault(tpl, 'cm'), rate: inputDefault(tpl, 'cr') });
  const pageData = { job: d.job, trail: { deliverables: d.trail.deliverables, contracts: { FulfilmentGate: d.trail.contracts.FulfilmentGate } } };
  return {
    ...runView(d.trail, { dryrun: d.dryrun, verify: d.verify }),
    vq: esc(p.question), va: esc(p.answer), vc: esc(claimsText(p.claims)),
    vout: esc(vv.text), 'vout.cls': vv.cls, vwhy: vv.why, srcs: vv.srcs,
    wout: esc(w.text), 'wout.cls': w.cls,
    it: esc(d.job.injection), iout: esc(s.text), 'iout.cls': s.cls,
    cy: esc(c.kpi), ch: esc(c.text), csrc: esc(c.src),
    gateNote: d.gate ? esc(d.gate.text) : '',
    pageData: JSON.stringify(pageData).replace(/</g, '\\u003c'),
  };
}

export function bake(tpl, values) {
  const used = new Set();
  const out = tpl.replace(/\{\{([\w.-]+)\}\}/g, (m, k) => {
    if (!(k in values)) throw new Error(`template marker {{${k}}} has no value`);
    used.add(k);
    return values[k];
  });
  const unused = Object.keys(values).filter((k) => !used.has(k));
  if (unused.length) throw new Error(`values with no marker in the template: ${unused.join(', ')}`);
  return out;
}

export function buildPage(data = loadPageData()) {
  const tpl = readFileSync('page/template.html', 'utf8').replace(/\r\n/g, '\n');
  if (!tpl.includes('/*KERNELS*/')) throw new Error('template has no /*KERNELS*/ marker');
  const baked = bake(tpl, bakeValues(tpl, data));
  const bodies = INLINED.map((k) => `// ── ${k} (inlined from ${k === RENDER ? 'the page renderer' : 'the gated kernel'}; CI checks it is byte-identical) ──\n` + inlineBody(readFileSync(k, 'utf8')));
  return baked.replace('/*KERNELS*/', () => bodies.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const d = loadPageData();
  writeFileSync('index.html', buildPage(d));
  console.log(`index.html built from runs/${d.onAevum ? 'aevum' : 'local'}.json with`, INLINED.join(', '));
}
