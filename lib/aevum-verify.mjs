// aevum-verify.mjs — after a testnet run, do not trust our own log: ask the chain for every transaction's
// receipt and compare. A step counts only if Aevum has a receipt for its hash with the same status and block
// (and, for a deployment, the same contract address). The predicted addresses (receipts/aevum-dryrun.json,
// made before the run) are compared with where the contracts actually landed. Misses are listed, never dropped.
//   pub: anything with getChainId() and getTransactionReceipt({ hash }) (a viem public client, or a stub in tests)
export async function verifyTrail(pub, trail, dryrun = null, { retries = 4, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const out = { at: new Date().toISOString(), chainId: Number(await pub.getChainId()), total: trail.steps.length, matched: 0, mismatches: [] };
  if (out.chainId !== trail.chainId) out.mismatches.push({ what: 'chainId', recorded: trail.chainId, chain: out.chainId });
  for (const s of trail.steps) {
    let r = null;
    for (let i = 0; i <= retries && !r; i++) {
      try {
        r = await pub.getTransactionReceipt({ hash: s.hash });
      } catch {
        if (i < retries) await wait(1500 * (i + 1));
      }
    }
    if (!r) {
      out.mismatches.push({ step: s.step, label: s.label, hash: s.hash, what: 'no receipt on the chain' });
      continue;
    }
    const status = r.status === 'success' ? 'success' : 'reverted';
    const diffs = [];
    if (status !== s.status) diffs.push(`status ${s.status} recorded, ${status} on chain`);
    if (Number(r.blockNumber) !== Number(s.block)) diffs.push(`block ${s.block} recorded, ${Number(r.blockNumber)} on chain`);
    if (s.contract && String(r.contractAddress || '').toLowerCase() !== String(s.contract).toLowerCase()) diffs.push(`contract ${s.contract} recorded, ${r.contractAddress} on chain`);
    if (diffs.length) out.mismatches.push({ step: s.step, label: s.label, hash: s.hash, what: diffs.join('; ') });
    else out.matched++;
  }
  if (dryrun && dryrun.predicted) {
    const names = Object.keys(dryrun.predicted);
    const misses = names.filter((n) => String(trail.contracts[n] || '').toLowerCase() !== dryrun.predicted[n].toLowerCase());
    out.predicted = { total: names.length, matched: names.length - misses.length, deployerNonce: dryrun.deployerNonce, misses: misses.map((n) => ({ contract: n, predicted: dryrun.predicted[n], actual: trail.contracts[n] || null })) };
  }
  out.ok = out.mismatches.length === 0 && out.matched === out.total;
  return out;
}
