// aevum-dryrun.mjs — before spending anything: ask QDay Aevum's own EVM to SIMULATE each deployment
// (eth_estimateGas + eth_call of the creation code). Read-only, no keys, no funds, nothing is sent.
// Proves the committed bytecode executes on Aevum (Shanghai) and returns runtime code; for a contract with
// no immutables the returned code must equal artifacts/<Name>.json deployedBytecode byte for byte.
//   node tools/aevum-dryrun.mjs   -> prints a table and writes receipts/aevum-dryrun.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, http, encodeDeployData } from 'viem';
import { AEVUM, TUSD8 } from '../sdk/index.mjs';
import { loadArtifacts } from '../lib/setup.mjs';

const art = loadArtifacts();
const pub = createPublicClient({ chain: AEVUM, transport: http(process.env.AEVUM_RPC_URL || AEVUM.rpcUrls.default.http[0], { timeout: 60_000, retryCount: 5 }) });
const FROM = '0x000000000000000000000000000000000000dEaD'; // an address nobody signs for; nothing is sent
const P = '0x00000000000000000000000000000000000000A1'; // placeholder dependency addresses for the simulation
const plan = [
  ['AgentIdentityRegistry', [], true],
  ['ValidationRegistry', [P], false],
  ['Fallmarket', [P, P], false],
  ['FulfilmentGate', [TUSD8, P, P, P], false],
  ['AgentAccount', [FROM, TUSD8], false],
];
const rows = [];
let ok = true;
const block = await pub.getBlockNumber();
for (const [name, args, exact] of plan) {
  const data = encodeDeployData({ abi: art[name].abi, bytecode: art[name].bytecode, args });
  const row = { contract: name };
  try {
    row.gas = (await pub.estimateGas({ account: FROM, data })).toString();
    const { data: code } = await pub.call({ account: FROM, data });
    row.runtimeBytes = code ? (code.length - 2) / 2 : 0;
    row.artifactBytes = (art[name].deployedBytecode.length - 2) / 2;
    row.sizeMatches = row.runtimeBytes === row.artifactBytes;
    if (exact) row.exactMatch = code === art[name].deployedBytecode;
    if (!row.sizeMatches || row.exactMatch === false) ok = false;
  } catch (e) {
    row.error = String(e.shortMessage || e.message).slice(0, 160);
    ok = false;
  }
  rows.push(row);
}
const receipt = { network: 'QDay Aevum testnet', chainId: await pub.getChainId(), block: block.toString(), at: new Date().toISOString(), simulatedOnly: true, ok, rows };
mkdirSync('receipts', { recursive: true });
writeFileSync('receipts/aevum-dryrun.json', JSON.stringify(receipt, null, 1) + '\n');
console.table(rows);
console.log(ok ? `every contract deploys on Aevum's EVM (simulated at block ${block}); nothing was sent` : 'DRY RUN FOUND A PROBLEM');
process.exit(ok ? 0 : 1);
