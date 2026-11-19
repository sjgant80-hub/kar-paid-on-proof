// gate-summary.mjs — one line for the page from the mutation receipts in receipts/ (written by mutation-gate.mjs).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const parts = [];
let clean = true;
for (const f of readdirSync('receipts').filter((x) => /^mutation-.*\.json$/.test(x) && x !== 'mutation-summary.json').sort()) {
  const r = JSON.parse(readFileSync(`receipts/${f}`, 'utf8'));
  for (const e of r.files) {
    const w = e.witness || {};
    const s = e.solidity;
    const k = (w.killed ?? 0) + (s ? s.killed : 0);
    const t = (w.total ?? 0) + (s ? s.total : 0);
    parts.push(`${e.file.split('/').pop()} ${k}/${t}`);
  }
  clean = clean && r.clean;
}
const text = `Last gate receipts: ${parts.join(' · ')} mutants killed${clean ? '; every kernel never throws under fuzz; CLEAN' : '; NOT CLEAN'}.`;
writeFileSync('receipts/mutation-summary.json', JSON.stringify({ text, clean, generated: new Date().toISOString() }, null, 1) + '\n');
console.log(text);
