// chain-rpc.mjs — the QDay Aevum testnet adapter (viem over HTTPS; Aevum has no WebSocket RPC).
// Legacy (type 0) transactions, as the official starter kit and QDay's faucet send them.
//
// A transaction we EXPECT to be refused (the injection, the over-cap spend, the revoked key) is still
// sent, with a fixed gas limit instead of an estimate, so the refusal is a real reverted transaction on
// the explorer rather than an error that never left this machine. Its revert reason is read back by
// replaying the call against the parent block.

import { createPublicClient, createWalletClient, http, encodeDeployData, encodeFunctionData, decodeFunctionResult } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AEVUM } from '../sdk/index.mjs';
import { decodeLogs, decodeRevert } from './chain-local.mjs';

export function createRpcChain({ rpcUrl = AEVUM.rpcUrls.default.http[0], abis = [], chain = AEVUM } = {}) {
  const transport = http(rpcUrl, { timeout: 60_000, retryCount: 6, retryDelay: 1500 });
  const pub = createPublicClient({ chain, transport });
  const allAbi = abis.flat();
  const wallets = new Map();
  // Reads are pinned to the newest block a receipt has proven, so a load-balanced node that is a block
  // behind cannot answer a check with state from before the transaction it is checking.
  let seenBlock = 0n;
  const atSeen = () => (seenBlock > 0n ? { blockNumber: seenBlock } : {});
  async function retry(fn, tries = 6) {
    for (let i = 0; ; i++) {
      try {
        return await fn();
      } catch (e) {
        if (i >= tries - 1) throw e;
        await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
      }
    }
  }
  const wallet = (key) => {
    if (!wallets.has(key)) wallets.set(key, createWalletClient({ account: privateKeyToAccount(key), chain, transport }));
    return wallets.get(key);
  };

  async function gasPrice() {
    const p = await pub.getGasPrice();
    const floor = 1_000_000_000n;
    return ((p > floor ? p : floor) * 12n) / 10n;
  }

  async function revertReason(from, to, data, blockNumber) {
    try {
      await pub.call({ account: from, to, data, blockNumber: blockNumber - 1n });
      return { name: 'UnknownRevert', args: ['replay succeeded at parent block'] };
    } catch (e) {
      const raw = findRevertData(e);
      return raw ? decodeRevert(allAbi, raw) : { name: 'UnknownRevert', args: [String(e.shortMessage || e.message).slice(0, 160)] };
    }
  }

  async function submit(key, to, data, { value = 0n, allowRevert = false } = {}) {
    const w = wallet(key);
    const from = w.account.address;
    let gas;
    let predicted = null;
    // a network hiccup (no revert data) is retried; a real revert is not
    const estimate = async () => {
      for (let i = 0; ; i++) {
        try {
          return await pub.estimateGas({ account: from, to: to ?? undefined, data, value });
        } catch (e) {
          if (findRevertData(e) || i >= 4) throw e;
          await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
        }
      }
    };
    try {
      gas = ((await estimate()) * 13n) / 10n;
    } catch (e) {
      if (!allowRevert) {
        const raw = findRevertData(e);
        throw new Error(`estimate failed (would revert): ${raw ? decodeRevert(allAbi, raw).name : e.shortMessage || e.message}`);
      }
      predicted = findRevertData(e);
      gas = 400_000n;
    }
    const hash = await w.sendTransaction({ to: to ?? undefined, data, value, gas, gasPrice: await gasPrice(), type: 'legacy' });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 240_000, pollingInterval: 2_000 });
    if (receipt.blockNumber > seenBlock) seenBlock = receipt.blockNumber;
    const out = {
      hash,
      block: Number(receipt.blockNumber),
      gasUsed: receipt.gasUsed,
      gasPrice: receipt.effectiveGasPrice ?? null, // what Aevum actually charged, per unit of gas
      status: receipt.status === 'success' ? 'success' : 'reverted',
      events: [],
      error: null,
      createdAddress: receipt.contractAddress ?? null,
    };
    if (out.status === 'success') out.events = decodeLogs(allAbi, receipt.logs);
    else out.error = predicted ? decodeRevert(allAbi, predicted) : await revertReason(from, to, data, receipt.blockNumber);
    if (out.status !== 'success' && !allowRevert) throw new Error(`tx ${hash} reverted: ${out.error?.name}`);
    return out;
  }

  return {
    name: 'aevum',
    chainId: chain.id,
    gasSymbol: 'tQDAY',
    gasFloat: 20_000_000_000_000_000n, // 0.02 tQDAY: hundreds of calls at ~1 gwei
    explorer: chain.blockExplorers.default.url,
    async deploy(key, artifact, args = []) {
      const r = await submit(key, null, encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args }));
      return { ...r, address: r.createdAddress };
    },
    async send(key, to, abi, functionName, args = [], { allowRevert = false } = {}) {
      return submit(key, to, encodeFunctionData({ abi, functionName, args }), { allowRevert });
    },
    async sendValue(key, to, value) {
      return submit(key, to, '0x', { value });
    },
    async read(to, abi, functionName, args = []) {
      const { data } = await retry(() => pub.call({ to, data: encodeFunctionData({ abi, functionName, args }), ...atSeen() }));
      return decodeFunctionResult({ abi, functionName, data });
    },
    async time() {
      const b = await retry(() => pub.getBlock({ blockTag: 'latest' }));
      return b.timestamp > 0n ? b.timestamp : 0n;
    },
    async advance() {
      throw new Error('cannot move time on a public testnet');
    },
    async balance(addr) {
      return retry(() => pub.getBalance({ address: addr, ...atSeen() }));
    },
    async code(addr) {
      return pub.getCode({ address: addr });
    },
    pub,
  };
}

// viem nests the revert bytes in different places depending on the node's error shape.
export function findRevertData(e) {
  let cur = e;
  for (let i = 0; i < 8 && cur; i++) {
    const d = cur.data?.data ?? cur.data;
    if (typeof d === 'string' && d.startsWith('0x') && d.length >= 10) return d;
    cur = cur.cause;
  }
  const m = String(e?.message || '').match(/0x[0-9a-fA-F]{8,}/);
  return m ? m[0] : null;
}
