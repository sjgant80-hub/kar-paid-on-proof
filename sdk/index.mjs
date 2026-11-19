// Sovereign Agent Payments SDK — the open-source surface of the Kar trust layer.
//
// Pure kernels (no deps):  verify.mjs (DocDec verifier rule), reader.mjs (copy-only worker),
//                          policy.mjs (session-key wall preview + injection screen)
// Chain glue (viem):       hashes that match the contracts byte for byte, EIP-712 typed data for the
//                          session key and the ERC-8004 agent wallet, the ERC-8004 registration file,
//                          and the Aevum testnet network config.

import { keccak256, encodeAbiParameters, stringToBytes, toHex } from 'viem';

export * from './verify.mjs';
export * from './reader.mjs';
export * from './policy.mjs';

export const AEVUM = {
  id: 44005,
  name: 'QDay Aevum Testnet',
  nativeCurrency: { name: 'tQDAY', symbol: 'tQDAY', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc-test.qday.info'] } },
  blockExplorers: { default: { name: 'Aevum explorer', url: 'https://explorer-test.qday.info' } },
  testnet: true,
};
export const TUSD8 = '0x456569838f1d43009A91ebA4263147Afd7233483';
export const TUSD8_DECIMALS = 6;
export const explorerTx = (hash) => `${AEVUM.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (addr) => `${AEVUM.blockExplorers.default.url}/address/${addr}`;

const CLAIMS = {
  type: 'tuple[]',
  components: [
    { name: 'doc', type: 'uint32' },
    { name: 'start', type: 'uint32' },
    { name: 'end', type: 'uint32' },
  ],
};

export const docHash = (text) => keccak256(stringToBytes(text));
export const questionHash = (question) => keccak256(stringToBytes(question));

// FulfilmentGate: keccak256(abi.encode(bytes32[] docHashes))
export function sourcesRoot(texts) {
  return keccak256(encodeAbiParameters([{ type: 'bytes32[]' }], [texts.map(docHash)]));
}

// FulfilmentGate.deliverableHashOf: keccak256(abi.encode(questionHash, keccak256(answer), claims))
export function deliverableHash(question, answer, claims) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, CLAIMS],
      [questionHash(question), keccak256(stringToBytes(answer)), claims.map((c) => ({ doc: c.doc, start: c.start, end: c.end }))],
    ),
  );
}

// FulfilmentGate.requestHashOf: keccak256(abi.encode(chainid, gate, jobId, deliverableHash))
export function requestHash(chainId, gate, jobId, dHash) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [BigInt(chainId), gate, BigInt(jobId), dHash],
    ),
  );
}

// The verifier's report, hashed into the Validation Registry as responseHash.
export function reportHash(report) {
  return keccak256(stringToBytes(JSON.stringify(report)));
}

export function sessionActionTypedData({ chainId, account, kind, target, amount, data = '0x', nonce, deadline }) {
  return {
    domain: { name: 'KarAgentAccount', version: '1', chainId: Number(chainId), verifyingContract: account },
    types: {
      SessionAction: [
        { name: 'kind', type: 'uint8' },
        { name: 'target', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'dataHash', type: 'bytes32' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'SessionAction',
    message: { kind, target, amount: BigInt(amount), dataHash: keccak256(data), nonce: BigInt(nonce), deadline: BigInt(deadline) },
  };
}

export function agentWalletTypedData({ chainId, registry, agentId, newWallet, owner, deadline }) {
  return {
    domain: { name: 'ERC8004IdentityRegistry', version: '1', chainId: Number(chainId), verifyingContract: registry },
    types: {
      AgentWalletSet: [
        { name: 'agentId', type: 'uint256' },
        { name: 'newWallet', type: 'address' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'AgentWalletSet',
    message: { agentId: BigInt(agentId), newWallet, owner, deadline: BigInt(deadline) },
  };
}

// ERC-8004 registration-v1 file. `registrations` names the agent's own (registry, id), so a reader can
// check the file and the chain agree.
export function registrationFile({ name, description, services = [], agentId, chainId, registry, supportedTrust = ['validation'] }) {
  const file = {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name,
    description,
    image: '',
    services,
    x402Support: false,
    active: true,
    registrations: agentId == null ? [] : [{ agentId: Number(agentId), agentRegistry: `eip155:${chainId}:${registry}` }],
    supportedTrust,
  };
  return file;
}

export function dataURI(json) {
  const b64 = typeof Buffer !== 'undefined'
    ? Buffer.from(JSON.stringify(json), 'utf8').toString('base64')
    : btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(json))));
  return 'data:application/json;base64,' + b64;
}

export const units = (n) => BigInt(Math.round(Number(n) * 10 ** TUSD8_DECIMALS));
export const fmt = (v) => (Number(v) / 10 ** TUSD8_DECIMALS).toFixed(2);
export { toHex };
