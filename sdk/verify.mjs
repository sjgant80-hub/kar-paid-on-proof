// verify.mjs — the DocDec verifier rule for a deliverable, as a pure kernel (no I/O, no deps, never throws).
//
// A deliverable is an answer plus claims. Each claim cites a byte range [start, end) of one source document.
// PASS needs all of:
//   1. at least one claim (an empty answer is a REFUSAL: honest, but nothing to pay for),
//   2. every claim inside its document, ranges well-formed, at most MAX_CLAIMS claims and MAX_DOCS documents,
//   3. VERBATIM: the answer is exactly the cited byte ranges joined by single spaces (the reader may only copy),
//   4. ON-QUESTION: the copied words cover at least `minCoverage` of the question's content terms.
// Rules 1 to 3 are the same rules FulfilmentGate re-runs on-chain before it releases money. Rule 4 is the
// verifier's judgement, which the chain cannot re-run; the verifier signs it into the ERC-8004 Validation
// Registry and the gate waits for that signature.
// Offsets are UTF-8 BYTE offsets, because that is what the chain slices.

export const MAX_DOCS = 16;
export const MAX_CLAIMS = 8;
export const DEFAULT_MIN_COVERAGE = 0.5;
export const TAG = 'docdec-verbatim-v1';

const STOP = new Set(('a an and are as at be by can do does for from has have how in is it its of on or ' +
  'that the this to was what when where which who why will with must should may would could shall ' +
  'there their they them then than these those into onto about any each every also only not no yes').split(' '));

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8', { fatal: false });

export function utf8(text) {
  return typeof text === 'string' ? enc.encode(text) : new Uint8Array(0);
}

export function bytesEqual(a, b) {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// Content terms: lowercase alphanumeric runs of 3+ characters that are not stopwords.
export function terms(text) {
  if (typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
  }
  return out;
}

// Share of the question's content terms that appear in the copied text. No question terms -> 0.
export function coverage(question, copied) {
  const q = terms(question);
  if (q.length === 0) return 0;
  const have = new Set(terms(copied));
  let hit = 0;
  for (const t of q) {
    if (have.has(t)) hit += 1;
  }
  return hit / q.length;
}

function isIndex(n) {
  return Number.isInteger(n) && n >= 0 && n <= 0xffffffff;
}

// Join byte ranges with single spaces, exactly as the gate does on-chain.
export function joinSpans(spans) {
  let total = 0;
  for (let i = 0; i < spans.length; i++) total += spans[i].length + (i > 0 ? 1 : 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i < spans.length; i++) {
    if (i > 0) {
      out[at] = 32;
      at += 1;
    }
    out.set(spans[i], at);
    at += spans[i].length;
  }
  return out;
}

// The first exact occurrence of `phrase` in `doc`, as byte offsets, or null. This is all a copy-only
// reader is allowed to do: find words that are really there.
export function locate(doc, phrase) {
  if (typeof doc !== 'string' || typeof phrase !== 'string' || phrase.length === 0) return null;
  const at = doc.indexOf(phrase);
  if (at < 0) return null;
  const start = utf8(doc.slice(0, at)).length;
  return { start, end: start + utf8(phrase).length };
}

function fail(reason, extra) {
  return { verdict: 'FAIL', response: 0, pass: false, reason, ...extra };
}

// input: { question: string, sources: string[], deliverable: { answer: string, claims: [{doc,start,end}] } }
export function verifyDeliverable(input, opts) {
  try {
    const minCoverage = opts && typeof opts.minCoverage === 'number' ? opts.minCoverage : DEFAULT_MIN_COVERAGE;
    if (!input || typeof input !== 'object') return fail('malformed: no input');
    const { question, sources, deliverable } = input;
    if (typeof question !== 'string' || question.length === 0) return fail('malformed: no question');
    if (!Array.isArray(sources) || sources.length === 0) return fail('malformed: no sources');
    if (sources.length > MAX_DOCS) return fail('too many sources');
    for (const s of sources) {
      if (typeof s !== 'string') return fail('malformed: a source is not text');
    }
    if (!deliverable || typeof deliverable !== 'object') return fail('malformed: no deliverable');
    const { answer, claims } = deliverable;
    if (typeof answer !== 'string') return fail('malformed: no answer');
    if (!Array.isArray(claims)) return fail('malformed: claims is not a list');
    if (claims.length === 0) {
      return { verdict: 'REFUSE', response: 0, pass: false, reason: 'no claim: the worker refused, nothing grounded to pay for', claims: [] };
    }
    if (claims.length > MAX_CLAIMS) return fail('too many claims');

    const docs = sources.map(utf8);
    const spans = [];
    const checked = [];
    for (let i = 0; i < claims.length; i++) {
      const c = claims[i];
      if (!c || typeof c !== 'object' || !isIndex(c.doc) || !isIndex(c.start) || !isIndex(c.end)) {
        return fail(`claim ${i}: malformed`, { claims: checked });
      }
      if (c.doc >= docs.length) return fail(`claim ${i}: no such source`, { claims: checked });
      if (c.start >= c.end) return fail(`claim ${i}: empty or reversed range`, { claims: checked });
      if (c.end > docs[c.doc].length) return fail(`claim ${i}: range runs past the end of source ${c.doc}`, { claims: checked });
      const span = docs[c.doc].subarray(c.start, c.end);
      spans.push(span);
      checked.push({ index: i, doc: c.doc, start: c.start, end: c.end, quote: dec.decode(span) });
    }

    const rebuilt = joinSpans(spans);
    if (!bytesEqual(rebuilt, utf8(answer))) {
      return fail('not verbatim: the answer is not the cited words', { claims: checked, rebuilt: dec.decode(rebuilt) });
    }

    const cov = coverage(question, answer);
    if (cov < minCoverage) {
      return fail(`off the question: the copied words cover ${Math.round(cov * 100)}% of the question's terms (needs ${Math.round(minCoverage * 100)}%)`,
        { claims: checked, coverage: cov });
    }
    return { verdict: 'PASS', response: 100, pass: true, reason: 'every word of the answer sits at its cited offsets, and it addresses the question', claims: checked, coverage: cov };
  } catch {
    return fail('malformed: unreadable input');
  }
}
