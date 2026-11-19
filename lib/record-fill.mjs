// record-fill.mjs — write the testnet run into CLAIMS.md and README.md from runs/aevum.json and the chain's own
// receipts (receipts/aevum-verify.json), between fixed markers. Pure text in, text out: nobody types a hash.
// A run that does not verify is written as what it is: P12 says FAIL and lists every mismatch.

const between = (text, tag, body) => {
  const a = `<!--${tag}-->`;
  const b = `<!--/${tag}-->`;
  const i = text.indexOf(a);
  const j = text.indexOf(b);
  if (i < 0 || j < i) throw new Error(`marker ${a}…${b} not found`);
  return text.slice(0, i + a.length) + body + text.slice(j);
};
const tx = (ex, h) => `[${h.slice(0, 10)}…](${ex}/tx/${h})`;
const ad = (ex, a) => `[\`${a}\`](${ex}/address/${a})`;
const day = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function p12Text(trail, verify) {
  const ex = trail.explorer;
  const refused = trail.steps.filter((s) => s.status === 'reverted');
  const passed = trail.checks.filter((c) => c.ok).length;
  const find = (pred) => trail.steps.find(pred);
  const rel = find((s) => s.step === 'S8' && s.status === 'success');
  const ref = find((s) => s.step === 'S9' && s.status === 'success' && /refund/i.test(s.label));
  const inj = refused.filter((s) => s.step === 'S5');
  const rev = find((s) => s.step === 'S11' && s.status === 'reverted');
  const ok = verify && verify.ok && passed === trail.checks.length;
  const head = ok ? 'PASS' : 'FAIL';
  const parts = [
    `${head} on QDay Aevum testnet, ${day(trail.started)} (\`runs/aevum.json\`, commit ${(trail.commit || '').slice(0, 7)}): ${trail.steps.length} transactions, ${refused.length} refused on-chain as designed, ${passed}/${trail.checks.length} checks`,
    verify ? `every hash re-read from Aevum's own receipts: ${verify.matched}/${verify.total} match on status and block${verify.mismatches.length ? ` (mismatches: ${verify.mismatches.map((m) => `${m.step ?? ''} ${m.what}`.trim()).join('; ')})` : ''}` : 'hashes not yet re-read from the chain',
  ];
  if (verify && verify.predicted) parts.push(`contract addresses predicted before the run from the deployer's nonce: ${verify.predicted.matched}/${verify.predicted.total} matched${verify.predicted.misses.length ? ` (missed: ${verify.predicted.misses.map((m) => m.contract).join(', ')})` : ''}`);
  const links = [];
  if (inj.length) links.push(`injection refused ${inj.map((s) => `${tx(ex, s.hash)} \`${s.error?.name}\``).join(', ')}`);
  if (rel) links.push(`release on proof ${tx(ex, rel.hash)}`);
  const nov = refused.find((s) => s.step === 'S9');
  if (nov) links.push(`release without a PASS refused ${tx(ex, nov.hash)} \`${nov.error?.name}\``);
  if (ref) links.push(`refund on FAIL ${tx(ex, ref.hash)}`);
  if (rev) links.push(`revoked key refused ${tx(ex, rev.hash)}`);
  if (links.length) parts.push(links.join('; '));
  return parts.join('; ') + '.';
}

export function fillClaims(md, trail, verify) {
  const rows = trail.steps.map((s) => `| ${s.step} | ${s.label.replace(/\|/g, '\\|')} | ${s.status === 'success' ? 'ok' : `refused: \`${s.error?.name}\``} | ${tx(trail.explorer, s.hash)} | ${s.block} |`).join('\n');
  const results = `\n**QDay Aevum testnet, ${day(trail.started)}** (\`node flow.mjs --network aevum\`, [\`runs/aevum.json\`](runs/aevum.json), re-read from the chain in [\`receipts/aevum-verify.json\`](receipts/aevum-verify.json)):\n\n| Step | What | Result | Transaction | Block |\n|---|---|---|---|---|\n${rows}\n`;
  return between(between(md, 'P12', p12Text(trail, verify)), 'AEVUM-RESULTS', results);
}

export function fillReadme(md, trail, verify) {
  const ex = trail.explorer;
  const names = ['AgentIdentityRegistry', 'ValidationRegistry', 'Fallmarket', 'FulfilmentGate', 'AgentAccount'];
  const table = `\n**Deployed on QDay Aevum testnet, ${day(trail.started)}**, from commit \`${(trail.commit || '').slice(0, 7)}\` by ${ad(ex, trail.roles.principal)}; ${trail.steps.length} transactions, ${verify ? `${verify.matched}/${verify.total} re-read from the chain's receipts` : 'not yet re-read'}:\n\n| Contract | Address |\n|---|---|\n${names.map((n) => `| ${n} | ${ad(ex, trail.contracts[n])} |`).join('\n')}\n| tUSD8 (QDay) | ${ad(ex, trail.contracts.tUSD8)} |\n`;
  return between(md, 'AEVUM-ADDRESSES', table);
}

// a stand-in for runs/aevum.json made from the recorded local run: used only in memory, by the rehearsal and the
// tests, to prove the page flip and the record fill before a real Aevum run exists. Never written to runs/.
export function standIn(local) {
  return { ...local, network: 'aevum', chainId: 44005, explorer: 'https://explorer-test.qday.info', contracts: { ...local.contracts, tUSD8: '0x456569838f1d43009A91ebA4263147Afd7233483' } };
}
