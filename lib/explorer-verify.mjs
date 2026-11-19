// explorer-verify.mjs — after the testnet run, try to publish each contract's source on explorer-test.qday.info
// (Blockscout's standard-JSON verification), so a judge can read the code on the explorer. QDay's starter kit
// reports the verifier as not working; the result is recorded either way (receipts/aevum-verify.json), never assumed.
import { encodeAbiParameters } from 'viem';

// the exact compiler input tools/compile.mjs used: one file per compile, keyed by its basename
export function standardInput(art, sourceText) {
  const name = art.source.split('/').pop();
  return { language: 'Solidity', sources: { [name]: { content: sourceText } }, settings: art.settings };
}

export function constructorArgs(art, args) {
  const ctor = art.abi.find((x) => x.type === 'constructor');
  if (!ctor || !ctor.inputs.length) return '';
  return encodeAbiParameters(ctor.inputs, args).slice(2);
}

export async function verifyOnExplorer({ explorer, address, contract, art, sourceText, args = [], compilerVersion, fetchImpl = fetch, wait = (ms) => new Promise((r) => setTimeout(r, ms)), polls = 10 }) {
  const out = { contract, address, ok: false };
  try {
    const form = new FormData();
    form.append('compiler_version', compilerVersion);
    form.append('license_type', 'mit');
    const ca = constructorArgs(art, args);
    if (ca) form.append('constructor_args', ca);
    else form.append('autodetect_constructor_args', 'true');
    form.append('files[0]', new Blob([JSON.stringify(standardInput(art, sourceText))], { type: 'application/json' }), `${contract}.input.json`);
    const r = await fetchImpl(`${explorer}/api/v2/smart-contracts/${address}/verification/via/standard-input`, { method: 'POST', body: form });
    const body = await r.text();
    if (!r.ok) {
      out.detail = `the explorer refused the submission: HTTP ${r.status} ${body.slice(0, 160)}`;
      return out;
    }
    for (let i = 0; i < polls; i++) {
      await wait(6000);
      const s = await fetchImpl(`${explorer}/api/v2/smart-contracts/${address}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (s && s.is_verified) {
        out.ok = true;
        out.detail = 'source verified on the explorer';
        out.url = `${explorer}/address/${address}?tab=contract`;
        return out;
      }
    }
    out.detail = `submitted (${body.slice(0, 80)}), but not shown as verified after ${polls * 6} s`;
  } catch (e) {
    out.detail = `could not submit: ${String(e.message || e).slice(0, 160)}`;
  }
  return out;
}
