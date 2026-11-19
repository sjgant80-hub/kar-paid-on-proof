// reader.mjs — the worker's copy-only reader, as a pure kernel (no I/O, no deps, never throws).
//
// Given a question and source documents, it picks the single sentence that best covers the question's
// content terms and COPIES it, with its byte offsets. It cannot write a word that is not in a source:
// the deliverable it returns is, by construction, made of cited spans. Ties go to the earlier document,
// then the earlier sentence, so the same input always gives the same deliverable.
// If no sentence shares a content term with the question, it refuses (no claims).

import { terms, utf8 } from './verify.mjs';

// Sentences of `doc` as { text, start, end } with BYTE offsets. A sentence ends at . ! ? or a blank line;
// leading whitespace and markdown list/heading markers are trimmed off the span, never rewritten.
export function sentences(doc) {
  if (typeof doc !== 'string') return [];
  const out = [];
  const re = /[^.!?\n]+(?:[.!?]+|(?=\n)|$)/g;
  let m;
  while ((m = re.exec(doc)) !== null) {
    let s = m[0];
    let at = m.index;
    const lead = s.match(/^[\s#>*\-|]+/);
    if (lead) {
      at += lead[0].length;
      s = s.slice(lead[0].length);
    }
    s = s.replace(/\s+$/, '');
    if (s.length < 12) continue;
    const start = utf8(doc.slice(0, at)).length;
    out.push({ text: s, start, end: start + utf8(s).length });
  }
  return out;
}

export function readAnswer(question, sources) {
  try {
    // No question terms means no sentence can score a hit, so it falls through to the refusal below.
    // A non-array `sources` has no .entries() and lands in the catch. Neither needs its own guard.
    const q = terms(question);
    let best = null;
    for (const [d, doc] of sources.entries()) {
      for (const s of sentences(doc)) {
        const have = new Set(terms(s.text));
        let hit = 0;
        for (const t of q) {
          if (have.has(t)) hit += 1;
        }
        if (hit > 0 && (best === null || hit > best.hit)) best = { hit, doc: d, s };
      }
    }
    if (best === null) return { answer: '', claims: [], score: 0 };
    return {
      answer: best.s.text,
      claims: [{ doc: best.doc, start: best.s.start, end: best.s.end }],
      score: best.hit / q.length,
    };
  } catch {
    return { answer: '', claims: [], score: 0 };
  }
}
