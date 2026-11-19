// aevum-dryrun.mjs — before spending anything: ask QDay Aevum's own EVM to SIMULATE each deployment
// (eth_estimateGas + eth_call of the creation code). Read-only, no keys, no funds, nothing is sent.
// Proves the committed bytecode executes on Aevum (Shanghai) and returns runtime code; for a contract with
// no immutables the returned code must equal artifacts/<Name>.json deployedBytecode byte for byte.
// With --deployer <address> it also PREDICTS where the run's five contracts will land: lib/flow.mjs deploys
// them first, in this order, from that address, so their addresses follow from its current nonce (CREATE).
// The prediction is checked against the chain after the run (tools/aevum-go.mjs); a miss stays in the record.
//   node tools/aevum-dryrun.mjs [--deployer 0x…]   -> prints a table and writes receipts/aevum-dryrun.json
import { writeFileSync, mkdirSync } from 'node:fs';
import { createPublicClient, http, encodeDeployData, getContractAddress, getAddress, formatUnits } from 'viem';
import { AEVUM, TUSD8 } from '../sdk/index.mjs';
import { loadArtifacts } from '../lib/setup.mjs';

export const DEPLOY_ORDER = ['AgentIdentityRegistry', 'ValidationRegistry', 'Fallmarket', 'FulfilmentGate', 'AgentAccount'];

const art = loadArtifacts();
const pub = createPublicClient({ chain: AEVUM, transport: http(process.env.AEVUM_RPC_URL || AEVUM.rpcUrls.default.http[0], { timeout: 60_000, retryCount: 5 }) });
const argDeployer = process.argv.find((a, i) => process.argv[i - 1] === '--deployer');
const FROM = '0x000000000000000000000000000000000000dEaD'; // an address nobody signs for; nothing is sent
const P = '0x00000000000000000000000000000000000000A1'; // placeholder dependency addresses for the simulation
const args = {
  AgentIdentityRegistry: [[], true],
  ValidationRegistry: [[P], false],
  Fallmarket: [[P, P], false],
  FulfilmentGate: [[TUSD8, P, P, P], false],
  AgentAccount: [[FROM, TUSD8], false],
};
const rows = [];
let ok = true;
const block = await pub.getBlockNumber();
for (const name of DEPLOY_ORDER) {
  const [a, exact] = args[name];
  const data = encodeDeployData({ abi: art[name].abi, bytecode: art[name].bytecode, args: a });
  const row = { contract: name };
  try {
    row.gas = (await pub.estimateGas({ account: FROM, data, blockNumber: block })).toString();
    const { data: code } = await pub.call({ account: FROM, data, blockNumber: block });
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
const gasPrice = await pub.getGasPrice();
const deployGas = rows.reduce((s, r) => s + BigInt(r.gas || 0), 0n);
const receipt = {
  network: 'QDay Aevum testnet', chainId: await pub.getChainId(), block: block.toString(), at: new Date().toISOString(),
  simulatedOnly: true, ok, rows,
  deployGas: deployGas.toString(),
  gasPriceWei: gasPrice.toString(),
  deployCostTQDAY: formatUnits(deployGas * gasPrice, 18),
};
if (argDeployer) {
  const deployer = getAddress(argDeployer);
  const nonce = await pub.getTransactionCount({ address: deployer, blockNumber: block });
  receipt.deployer = deployer;
  receipt.deployerNonce = nonce;
  receipt.predicted = Object.fromEntries(DEPLOY_ORDER.map((n, i) => [n, getContractAddress({ from: deployer, nonce: BigInt(nonce + i) })]));
}
mkdirSync('receipts', { recursive: true });
writeFileSync('receipts/aevum-dryrun.json', JSON.stringify(receipt, null, 1) + '\n');
console.table(rows);
console.log(`deploy gas ${deployGas} at ${formatUnits(gasPrice, 9)} gwei = ${receipt.deployCostTQDAY} tQDAY`);
if (receipt.predicted) console.log(`deployer ${receipt.deployer} nonce ${receipt.deployerNonce}; predicted:`, receipt.predicted);
console.log(ok ? `every contract deploys on Aevum's EVM (simulated at block ${block}); nothing was sent` : 'DRY RUN FOUND A PROBLEM');
process.exit(ok ? 0 : 1);
