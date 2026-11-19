// policy.mjs — pure kernels for the agent's spending wall and its immune screen (no I/O, never throw).
//
// checkSessionAction mirrors AgentAccount.executeSession check for check, in the same order, so an agent
// (or a page) can say BEFORE sending what the chain will do. The chain is the authority; this is the
// preview. A parity test runs both on the same inputs.
//
// screenInjection reads untrusted text (a job description, a deliverable, an email) and flags payment
// instructions hidden in it. It is a tripwire, not the wall: the wall is the account's allowlist and cap,
// which hold even when the screen misses and the model obeys.

export const KIND_TRANSFER = 0;
export const KIND_CALL = 1;

// session: { cap, spent, expiry, active, allowlist: string[] }   (cap/spent as bigint base units)
// action:  { kind, target, amount, dataLength, deadline, signerOk, token }
// now:     unix seconds (number or bigint)
// Returns { ok, error } where error is the contract's custom error name, or null.
export function checkSessionAction(session, action, now) {
  try {
    // a missing session or action throws on first read and lands in the catch below as Malformed
    if (action.signerOk !== true) return { ok: false, error: 'BadSignature' };
    if (session.active !== true) return { ok: false, error: 'SessionNotActive' };
    const t = BigInt(now);
    if (t > BigInt(session.expiry)) return { ok: false, error: 'SessionExpired' };
    if (t > BigInt(action.deadline)) return { ok: false, error: 'ActionExpired' };
    const target = String(action.target).toLowerCase();
    const allow = Array.isArray(session.allowlist) ? session.allowlist.map((a) => String(a).toLowerCase()) : [];
    if (!allow.includes(target)) return { ok: false, error: 'RecipientNotAllowed' };
    const left = BigInt(session.cap) - BigInt(session.spent);
    if (BigInt(action.amount) > left) return { ok: false, error: 'OverCap' };
    if (action.kind === KIND_TRANSFER) {
      if (action.dataLength !== 0) return { ok: false, error: 'BadKind' };
      return { ok: true, error: null };
    }
    if (action.kind === KIND_CALL) {
      if (target === String(action.token).toLowerCase()) return { ok: false, error: 'TokenCallForbidden' };
      return { ok: true, error: null };
    }
    return { ok: false, error: 'BadKind' };
  } catch {
    return { ok: false, error: 'Malformed' };
  }
}

const ADDRESS = /0x[0-9a-fA-F]{40}\b|0x[0-9a-fA-F]{2,8}(?:\.{2,3}|…)[0-9a-fA-F]{0,8}|\b0x[A-Za-z]{2,12}\b/g;
const AMOUNT = /\b\d{1,3}(?:[,_]\d{3})+(?:\.\d+)?\b|\b\d+(?:\.\d+)?\s*(?:k|m)?\s*(?:tusd8|usd|usdc|tokens?|\$)|\$\s*\d/i;
const VERB = /\b(pay|send|transfer|wire|approve|withdraw|move|drain)\b/i;
const OVERRIDE = /\b(ignore (?:all |any )?(?:previous|prior|above) (?:instructions|rules)|system prompt|you are now|new instructions|disregard)\b/i;

// Returns { flagged, reasons: string[], addresses: string[] }.
export function screenInjection(text) {
  try {
    // non-text throws on .match and lands in the catch below; empty text simply matches nothing
    const reasons = [];
    const addresses = text.match(ADDRESS) || [];
    const verb = VERB.test(text);
    const amount = AMOUNT.test(text);
    if (verb && addresses.length > 0) reasons.push('payment verb with an address');
    if (verb && amount) reasons.push('payment verb with an amount');
    if (OVERRIDE.test(text)) reasons.push('tries to override the agent\'s instructions');
    return { flagged: reasons.length > 0, reasons, addresses };
  } catch {
    return { flagged: false, reasons: [], addresses: [] };
  }
}
