// wait-funded.mjs — watch an Aevum address until it holds enough tQDAY and tUSD8 for the run, then exit 0.
//   node tools/wait-funded.mjs <address> [minTQDAY=0.05] [minTUSD8=2] [maxMinutes=720]
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { AEVUM, TUSD8 } from '../sdk/index.mjs';

const [addr, minGas = '0.05', minUsd = '2', maxMin = '720'] = process.argv.slice(2);
const pub = createPublicClient({ chain: AEVUM, transport: http(AEVUM.rpcUrls.default.http[0], { timeout: 60_000, retryCount: 3 }) });
const abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const deadline = Date.now() + Number(maxMin) * 60_000;
let last = '';
for (;;) {
  try {
    const gas = Number(formatUnits(await pub.getBalance({ address: addr }), 18));
    const usd = Number(formatUnits(await pub.readContract({ address: TUSD8, abi, functionName: 'balanceOf', args: [addr] }), 6));
    const line = `tQDAY ${gas} · tUSD8 ${usd}`;
    if (line !== last) console.log(new Date().toISOString(), line);
    last = line;
    if (gas >= Number(minGas) && usd >= Number(minUsd)) {
      console.log('FUNDED');
      process.exit(0);
    }
  } catch (e) {
    console.log('rpc error (will retry):', String(e.shortMessage || e.message).slice(0, 80));
  }
  if (Date.now() > deadline) {
    console.log('TIMED OUT waiting for funds');
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 60_000));
}
