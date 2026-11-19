// build-page.mjs — index.html = page/template.html with the gated kernels inlined byte for byte
// (import lines dropped, the `export ` keyword stripped; nothing else changes). page-parity.mjs proves it.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const KERNELS = ['sdk/verify.mjs', 'sdk/reader.mjs', 'sdk/policy.mjs', 'sdk/cost.mjs'];

export function inlineBody(src) {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((l) => !/^import\s/.test(l))
    .join('\n')
    .replace(/^export /gm, '');
}

export function buildPage() {
  const tpl = readFileSync('page/template.html', 'utf8').replace(/\r\n/g, '\n');
  const bodies = KERNELS.map((k) => `// ── ${k} (inlined from the gated kernel; CI checks it is byte-identical) ──\n` + inlineBody(readFileSync(k, 'utf8')));
  if (!tpl.includes('/*KERNELS*/')) throw new Error('template has no /*KERNELS*/ marker');
  return tpl.replace('/*KERNELS*/', () => bodies.join('\n'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync('index.html', buildPage());
  console.log('index.html built with', KERNELS.join(', '));
}
