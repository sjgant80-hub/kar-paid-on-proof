// Test harness: compile the CURRENT contract sources (so a mutation run tests the mutant, never a stale
// artifact), start a fresh in-process Shanghai EVM, and give each test named accounts.
import assert from 'node:assert/strict';
import { keccak256, stringToBytes, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { compileAll } from '../tools/compile.mjs';
import { createLocalChain } from '../lib/chain-local.mjs';
import { units, agentWalletTypedData } from '../sdk/index.mjs';

export { assert, units, stringToHex };

let artPromise = null;
export function artifacts() {
  if (!artPromise) artPromise = compileAll();
  return artPromise;
}

export const key = (label) => keccak256(stringToBytes(`kar-trust-layer test: ${label}`));
export const K = {
  owner: key('owner'), alice: key('alice'), bob: key('bob'), carol: key('carol'),
  validator: key('validator'), session: key('session'), stranger: key('stranger'),
};
export const addr = Object.fromEntries(Object.entries(K).map(([n, k]) => [n, privateKeyToAccount(k).address]));
export const acct = Object.fromEntries(Object.entries(K).map(([n, k]) => [n, privateKeyToAccount(k)]));

export async function world() {
  const art = await artifacts();
  const abis = Object.values(art).map((a) => a.abi);
  const chain = await createLocalChain({ abis, fund: Object.values(K) });
  const deploy = async (name, args = [], from = K.owner) => (await chain.deploy(from, art[name], args)).address;
  const send = (from, to, name, fn, args = [], opts) => chain.send(from, to, art[name].abi, fn, args, opts);
  const read = (to, name, fn, args = []) => chain.read(to, art[name].abi, fn, args);
  // expect a revert with this custom error name (and optionally these args)
  const reverts = async (p, errName, args) => {
    const r = await p;
    assert.equal(r.status, 'reverted', `expected revert ${errName}, got success`);
    assert.equal(r.error?.name, errName, `expected ${errName}, got ${r.error?.name} ${JSON.stringify(r.error?.args, (k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
    if (args) assert.deepEqual(r.error.args, args);
    return r;
  };
  const ok = async (p) => {
    const r = await p;
    assert.equal(r.status, 'success', `expected success, got ${r.error?.name}`);
    return r;
  };
  const ev = (r, name) => r.events.filter((e) => e.name === name);
  return { art, chain, deploy, send, read, reverts, ok, ev };
}

// Identity + validation registries with three agents: alice (#1), bob (#2), carol (#3).
export async function registries(w) {
  const identity = await w.deploy('AgentIdentityRegistry');
  const validation = await w.deploy('ValidationRegistry', [identity]);
  for (const who of ['alice', 'bob', 'carol']) await w.ok(w.send(K[who], identity, 'AgentIdentityRegistry', 'register', [`ipfs://${who}`]));
  return { identity, validation };
}

export async function walletSig(w, identity, agentId, newWallet, ownerAcct, deadline, signer = ownerAcct) {
  return signer.signTypedData(agentWalletTypedData({ chainId: w.chain.chainId, registry: identity, agentId, newWallet, owner: ownerAcct.address, deadline }));
}
