// browser-run.mjs — bundled into app/evm.js for the live page. It runs the SAME flow (lib/flow.mjs) on the
// SAME bytecode (artifacts/*.json, the exact bytes deployed on Aevum) inside an in-browser Shanghai EVM.
// Nothing leaves the visitor's machine: no wallet, no keys of theirs, no network.
import { createLocalChain } from '../lib/chain-local.mjs';
import { runFlow } from '../lib/flow.mjs';
import { LOCAL_KEYS } from '../lib/keys.mjs';

export async function runInBrowser({ art, job, onLog = () => {} }) {
  const chain = await createLocalChain({ abis: Object.values(art).map((a) => a.abi), fund: [LOCAL_KEYS.principal] });
  return runFlow(chain, { keys: LOCAL_KEYS, art, job, log: onLog });
}
