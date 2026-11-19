// chain-local.mjs — an in-process Shanghai EVM (ethereumjs, the reference JS implementation) that speaks
// the same adapter interface as the Aevum RPC adapter. Real signed legacy transactions, real receipts,
// real logs, real reverts. Each transaction gets its own block 2 s after the last, so time moves on.
// Used by the tests, the Docker image's default run, and (bundled) the in-browser run on the live page.

import { Chain, Common, Hardfork } from '@ethereumjs/common';
import { LegacyTransaction } from '@ethereumjs/tx';
import { Account, Address, hexToBytes, bytesToHex } from '@ethereumjs/util';
import { Block } from '@ethereumjs/block';
import { VM } from '@ethereumjs/vm';
import { encodeDeployData, encodeFunctionData, decodeFunctionResult, decodeErrorResult, parseEventLogs, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const GAS_PRICE = 1_000_000_000n;
const BLOCK_GAS = 30_000_000n;

export async function createLocalChain({ chainId = 31337, abis = [], fund = [], startTime } = {}) {
  const common = Common.custom({ chainId, networkId: chainId, name: 'kar-local' }, { baseChain: Chain.Mainnet, hardfork: Hardfork.Shanghai });
  const vm = await VM.create({ common });
  for (const key of fund) {
    const addr = Address.fromString(privateKeyToAccount(key).address);
    await vm.stateManager.putAccount(addr, new Account(0n, 10n ** 21n));
  }
  const allAbi = abis.flat();
  let number = 1n;
  let timestamp = BigInt(startTime ?? Math.floor(Date.now() / 1000));

  const block = () => Block.fromBlockData(
    { header: { number, timestamp, gasLimit: BLOCK_GAS, baseFeePerGas: 7n, coinbase: '0x' + '00'.repeat(19) + 'c0' }, withdrawals: [] },
    { common, skipConsensusFormatValidation: true },
  );

  async function nonceOf(addr) {
    const acc = await vm.stateManager.getAccount(Address.fromString(addr));
    return acc ? acc.nonce : 0n;
  }

  async function run(key, to, data, value = 0n) {
    const from = privateKeyToAccount(key).address;
    const tx = LegacyTransaction.fromTxData(
      { nonce: await nonceOf(from), gasPrice: GAS_PRICE, gasLimit: 10_000_000n, to: to ?? undefined, value, data: hexToBytes(data) },
      { common },
    ).sign(hexToBytes(key));
    const b = block();
    const res = await vm.runTx({ tx, block: b, skipBlockGasLimitValidation: true });
    const out = {
      hash: bytesToHex(tx.hash()),
      block: Number(number),
      gasUsed: res.totalGasSpent,
      status: res.execResult.exceptionError ? 'reverted' : 'success',
      events: [],
      error: null,
      createdAddress: res.createdAddress ? getAddress(res.createdAddress.toString()) : null,
    };
    number += 1n;
    timestamp += 2n;
    if (out.status === 'success') {
      const logs = res.receipt.logs.map(([address, topics, d]) => ({ address: bytesToHex(address), topics: topics.map(bytesToHex), data: bytesToHex(d) }));
      out.events = decodeLogs(allAbi, logs);
    } else {
      out.error = decodeRevert(allAbi, bytesToHex(res.execResult.returnValue));
    }
    return out;
  }

  return {
    name: 'local',
    chainId,
    gasSymbol: 'ETH (local)',
    gasFloat: 10n ** 17n,
    explorer: null,
    async deploy(key, artifact, args = []) {
      const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
      const r = await run(key, null, data);
      if (r.status !== 'success') throw new Error(`deploy failed: ${JSON.stringify(r.error)}`);
      return { ...r, address: r.createdAddress };
    },
    async send(key, to, abi, functionName, args = [], { allowRevert = false } = {}) {
      const r = await run(key, to, encodeFunctionData({ abi, functionName, args }));
      if (r.status !== 'success' && !allowRevert) throw new Error(`${functionName} reverted: ${r.error?.name} ${JSON.stringify(r.error?.args ?? [], replacer)}`);
      return r;
    },
    async sendValue(key, to, value) {
      return run(key, to, '0x', value);
    },
    async read(to, abi, functionName, args = []) {
      const res = await vm.evm.runCall({ to: Address.fromString(to), caller: Address.zero(), data: hexToBytes(encodeFunctionData({ abi, functionName, args })), block: block() });
      const ret = bytesToHex(res.execResult.returnValue);
      if (res.execResult.exceptionError) throw Object.assign(new Error(`read ${functionName} reverted`), { revert: decodeRevert(allAbi, ret) });
      return decodeFunctionResult({ abi, functionName, data: ret });
    },
    async time() {
      return timestamp;
    },
    async advance(seconds) {
      timestamp += BigInt(seconds);
    },
    async balance(addr) {
      const acc = await vm.stateManager.getAccount(Address.fromString(addr));
      return acc ? acc.balance : 0n;
    },
    async code(addr) {
      return bytesToHex(await vm.stateManager.getContractCode(Address.fromString(addr)));
    },
  };
}

export function decodeLogs(abi, logs) {
  try {
    return parseEventLogs({ abi, logs, strict: false }).map((l) => ({ name: l.eventName, address: l.address, args: l.args }));
  } catch {
    return [];
  }
}

export function decodeRevert(abi, data) {
  if (!data || data === '0x') return { name: 'EmptyRevert', args: [] };
  try {
    const e = decodeErrorResult({ abi, data });
    return { name: e.errorName, args: e.args ?? [] };
  } catch {
    return { name: 'UnknownRevert', args: [data] };
  }
}

export function replacer(_k, v) {
  return typeof v === 'bigint' ? v.toString() : v;
}
