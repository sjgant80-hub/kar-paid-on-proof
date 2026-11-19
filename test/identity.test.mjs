// AgentIdentityRegistry (ERC-8004 identity): ERC-721 core, agent URI, metadata, the agentWallet binding.
import { test, before } from 'node:test';
import { stringToHex, keccak256, toHex } from 'viem';
import { world, K, addr, acct, assert, walletSig } from './helpers.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
let w, id, account, receiver, token;
const R = (from, fn, args, opts) => w.send(K[from], id, 'AgentIdentityRegistry', fn, args, { allowRevert: true, ...opts });
const get = (fn, args = []) => w.read(id, 'AgentIdentityRegistry', fn, args);

before(async () => {
  w = await world();
  id = await w.deploy('AgentIdentityRegistry');
  token = await w.deploy('MockUSD8');
  account = await w.deploy('AgentAccount', [addr.alice, token]);
  receiver = await w.deploy('MockReceiver');
});

async function newAgent(from = 'alice', uri = 'ipfs://a') {
  const r = await w.ok(R(from, 'register', [uri]));
  return w.ev(r, 'Registered')[0].args.agentId;
}

test('register(uri) mints the next id to the caller, sets the wallet, and emits Transfer, MetadataSet, Registered', async () => {
  const before = await get('agentCount');
  const r = await w.ok(R('alice', 'register', ['ipfs://alice']));
  const idn = before + 1n;
  assert.deepEqual(r.events.map((e) => e.name), ['Transfer', 'MetadataSet', 'Registered']);
  assert.equal(w.ev(r, 'Transfer')[0].args.to, addr.alice);
  assert.equal(w.ev(r, 'MetadataSet')[0].args.metadataKey, 'agentWallet');
  assert.equal(w.ev(r, 'MetadataSet')[0].args.metadataValue.toLowerCase(), addr.alice.toLowerCase());
  assert.equal(w.ev(r, 'Registered')[0].args.agentURI, 'ipfs://alice');
  assert.equal(await get('ownerOf', [idn]), addr.alice);
  assert.equal(await get('tokenURI', [idn]), 'ipfs://alice');
  assert.equal(await get('getAgentWallet', [idn]), addr.alice);
  assert.equal((await get('getMetadata', [idn, 'agentWallet'])).toLowerCase(), addr.alice.toLowerCase());
  assert.equal(await get('agentCount'), idn);
});

test('register() and register(uri, metadata) work; the reserved agentWallet key is refused in metadata', async () => {
  const r0 = await w.ok(R('bob', 'register', []));
  assert.equal(await get('tokenURI', [w.ev(r0, 'Registered')[0].args.agentId]), '');
  const md = [{ metadataKey: 'skill', metadataValue: stringToHex('copy-only') }, { metadataKey: 'tier', metadataValue: '0x01' }];
  const r = await w.ok(R('bob', 'register', ['ipfs://b', md]));
  const n = w.ev(r, 'Registered')[0].args.agentId;
  assert.equal(w.ev(r, 'MetadataSet').length, 3);
  assert.equal(await get('getMetadata', [n, 'skill']), stringToHex('copy-only'));
  assert.equal(await get('getMetadata', [n, 'tier']), '0x01');
  await w.reverts(R('bob', 'register', ['ipfs://b', [{ metadataKey: 'agentWallet', metadataValue: '0x01' }]]), 'ReservedKey');
  await w.reverts(R('bob', 'register', ['ipfs://b', [md[0], { metadataKey: 'agentWallet', metadataValue: '0x01' }]]), 'ReservedKey');
});

test('setAgentURI and setMetadata: owner, operator and approved address may; strangers may not; reserved key refused', async () => {
  const n = await newAgent('alice');
  const r = await w.ok(R('alice', 'setAgentURI', [n, 'ipfs://new']));
  assert.equal(w.ev(r, 'URIUpdated')[0].args.updatedBy, addr.alice);
  assert.equal(await get('tokenURI', [n]), 'ipfs://new');
  await w.reverts(R('stranger', 'setAgentURI', [n, 'x']), 'NotAuthorized');
  await w.ok(R('alice', 'setMetadata', [n, 'k', '0xaa']));
  assert.equal(await get('getMetadata', [n, 'k']), '0xaa');
  await w.reverts(R('alice', 'setMetadata', [n, 'agentWallet', '0xaa']), 'ReservedKey');
  await w.reverts(R('stranger', 'setMetadata', [n, 'k', '0xbb']), 'NotAuthorized');
  // operator
  await w.ok(R('alice', 'setApprovalForAll', [addr.carol, true]));
  assert.equal(await get('isApprovedForAll', [addr.alice, addr.carol]), true);
  await w.ok(R('carol', 'setAgentURI', [n, 'ipfs://by-operator']));
  await w.ok(R('alice', 'setApprovalForAll', [addr.carol, false]));
  await w.reverts(R('carol', 'setAgentURI', [n, 'x']), 'NotAuthorized');
  // single-token approval
  await w.ok(R('alice', 'approve', [addr.bob, n]));
  assert.equal(await get('getApproved', [n]), addr.bob);
  await w.ok(R('bob', 'setAgentURI', [n, 'ipfs://by-approved']));
  await w.reverts(R('stranger', 'setAgentURI', [n, 'x']), 'NotAuthorized');
});

test('isAuthorizedOrOwner: owner, operator, approved; never a stranger, never address(0)', async () => {
  const n = await newAgent('alice');
  assert.equal(await get('isAuthorizedOrOwner', [addr.alice, n]), true);
  assert.equal(await get('isAuthorizedOrOwner', [addr.stranger, n]), false);
  assert.equal(await get('isAuthorizedOrOwner', [ZERO, n]), false);
  await w.ok(R('alice', 'approve', [addr.bob, n]));
  assert.equal(await get('isAuthorizedOrOwner', [addr.bob, n]), true);
  assert.equal(await get('isAuthorizedOrOwner', [addr.stranger, n]), false);
  await w.ok(R('alice', 'setApprovalForAll', [addr.carol, true]));
  assert.equal(await get('isAuthorizedOrOwner', [addr.carol, n]), true);
  await w.ok(R('alice', 'setApprovalForAll', [addr.carol, false]));
});

test('approve: owner or operator only', async () => {
  const n = await newAgent('alice');
  await w.reverts(R('stranger', 'approve', [addr.stranger, n]), 'NotAuthorized');
  await w.ok(R('alice', 'setApprovalForAll', [addr.carol, true]));
  const r = await w.ok(R('carol', 'approve', [addr.bob, n]));
  assert.equal(w.ev(r, 'Approval')[0].args.approved, addr.bob);
  await w.ok(R('alice', 'setApprovalForAll', [addr.carol, false]));
});

test('agentWallet: an EOA proves control with an EIP-712 signature; deadline window is [now, now + 5 min]', async () => {
  const n = await newAgent('alice');
  const t = await w.chain.time();
  const sig = await walletSig(w, id, n, addr.bob, acct.alice, t, acct.bob);
  const r = await w.ok(R('alice', 'setAgentWallet', [n, addr.bob, t, sig]));
  assert.equal(w.ev(r, 'MetadataSet')[0].args.metadataValue.toLowerCase(), addr.bob.toLowerCase());
  assert.equal(await get('getAgentWallet', [n]), addr.bob);
  const t2 = await w.chain.time();
  const far = t2 + 300n;
  await w.ok(R('alice', 'setAgentWallet', [n, addr.carol, far, await walletSig(w, id, n, addr.carol, acct.alice, far, acct.carol)]));
  const t3 = await w.chain.time();
  const tooFar = t3 + 301n;
  await w.reverts(R('alice', 'setAgentWallet', [n, addr.carol, tooFar, await walletSig(w, id, n, addr.carol, acct.alice, tooFar, acct.carol)]), 'DeadlineTooFar');
  const past = (await w.chain.time()) - 1n;
  await w.reverts(R('alice', 'setAgentWallet', [n, addr.carol, past, await walletSig(w, id, n, addr.carol, acct.alice, past, acct.carol)]), 'DeadlineExpired');
});

test('agentWallet: wrong signer, short signature, zero wallet and strangers are refused', async () => {
  const n = await newAgent('alice');
  const t = (await w.chain.time()) + 60n;
  await w.reverts(R('alice', 'setAgentWallet', [n, addr.bob, t, await walletSig(w, id, n, addr.bob, acct.alice, t, acct.stranger)]), 'BadSignature');
  await w.reverts(R('alice', 'setAgentWallet', [n, addr.bob, t, '0x' + '11'.repeat(64)]), 'BadSignature');
  await w.reverts(R('alice', 'setAgentWallet', [n, ZERO, t, '0x']), 'ZeroAddress');
  await w.reverts(R('stranger', 'setAgentWallet', [n, addr.bob, t, '0x']), 'NotAuthorized');
});

test('agentWallet: a smart account proves control with ERC-1271 (its owner signs)', async () => {
  const n = await newAgent('alice');
  const t = (await w.chain.time()) + 60n;
  const good = await walletSig(w, id, n, account, acct.alice, t, acct.alice); // account's owner is alice
  await w.ok(R('alice', 'setAgentWallet', [n, account, t, good]));
  assert.equal(await get('getAgentWallet', [n]), account);
  const bad = await walletSig(w, id, n, account, acct.alice, t, acct.stranger);
  await w.reverts(R('alice', 'setAgentWallet', [n, account, t, bad]), 'BadSignature');
  // a contract with no isValidSignature at all
  await w.reverts(R('alice', 'setAgentWallet', [n, receiver, t, good]), 'BadSignature');
});

test('the wallet digest is the ERC-8004 EIP-712 AgentWalletSet over the registry\'s domain', async () => {
  const n = await newAgent('alice');
  const { hashTypedData } = await import('viem');
  const { agentWalletTypedData } = await import('../sdk/index.mjs');
  const t = 12345n;
  assert.equal(await get('walletDigest', [n, addr.bob, t]),
    hashTypedData(agentWalletTypedData({ chainId: w.chain.chainId, registry: id, agentId: n, newWallet: addr.bob, owner: addr.alice, deadline: t })));
});

test('unsetAgentWallet clears it (owner only)', async () => {
  const n = await newAgent('alice');
  await w.reverts(R('stranger', 'unsetAgentWallet', [n]), 'NotAuthorized');
  const r = await w.ok(R('alice', 'unsetAgentWallet', [n]));
  assert.equal(w.ev(r, 'MetadataSet')[0].args.metadataValue, '0x');
  assert.equal(await get('getAgentWallet', [n]), ZERO);
});

test('transfer moves ownership and balances, clears approval AND the agent wallet (ERC-8004)', async () => {
  const n = await newAgent('alice');
  const ba = await get('balanceOf', [addr.alice]);
  const bb = await get('balanceOf', [addr.bob]);
  await w.ok(R('alice', 'approve', [addr.carol, n]));
  const r = await w.ok(R('carol', 'transferFrom', [addr.alice, addr.bob, n]));
  assert.deepEqual(r.events.map((e) => e.name), ['Transfer', 'MetadataSet']);
  assert.equal(await get('ownerOf', [n]), addr.bob);
  assert.equal(await get('balanceOf', [addr.alice]), ba - 1n);
  assert.equal(await get('balanceOf', [addr.bob]), bb + 1n);
  assert.equal(await get('getApproved', [n]), ZERO);
  assert.equal(await get('getAgentWallet', [n]), ZERO);
  await w.reverts(R('carol', 'transferFrom', [addr.bob, addr.carol, n]), 'NotAuthorized');
});

test('transfer guards: wrong from, zero to, stranger', async () => {
  const n = await newAgent('alice');
  await w.reverts(R('alice', 'transferFrom', [addr.bob, addr.carol, n]), 'WrongFrom');
  await w.reverts(R('alice', 'transferFrom', [addr.alice, ZERO, n]), 'ZeroAddress');
  await w.reverts(R('stranger', 'transferFrom', [addr.alice, addr.stranger, n]), 'NotAuthorized');
});

test('safeTransferFrom: to an EOA works; to a contract it must answer the ERC-721 selector', async () => {
  const n = await newAgent('alice');
  await w.ok(R('alice', 'safeTransferFrom', [addr.alice, addr.bob, n]));
  assert.equal(await get('ownerOf', [n]), addr.bob);
  await w.ok(R('bob', 'safeTransferFrom', [addr.bob, receiver, n, '0x']));
  assert.equal(await get('ownerOf', [n]), receiver);
  const m = await newAgent('alice');
  await w.ok(w.send(K.owner, receiver, 'MockReceiver', 'set', ['0xdeadbeef', false]));
  await w.reverts(R('alice', 'safeTransferFrom', [addr.alice, receiver, m]), 'UnsafeRecipient');
  await w.ok(w.send(K.owner, receiver, 'MockReceiver', 'set', ['0x150b7a02', true]));
  await w.reverts(R('alice', 'safeTransferFrom', [addr.alice, receiver, m]), 'UnsafeRecipient');
  await w.reverts(R('alice', 'safeTransferFrom', [addr.alice, token, m]), 'UnsafeRecipient');
  await w.ok(w.send(K.owner, receiver, 'MockReceiver', 'set', ['0x150b7a02', false]));
});

test('unknown agents and the zero owner are refused by every read', async () => {
  await assert.rejects(get('ownerOf', [999n]), /reverted/);
  await assert.rejects(get('tokenURI', [999n]), /reverted/);
  await assert.rejects(get('getAgentWallet', [999n]), /reverted/);
  await assert.rejects(get('getMetadata', [999n, 'k']), /reverted/);
  await assert.rejects(get('getApproved', [999n]), /reverted/);
  await assert.rejects(get('balanceOf', [ZERO]), /reverted/);
  await w.reverts(R('alice', 'setAgentURI', [999n, 'x']), 'NoSuchAgent');
});

test('ERC-165 answers for ERC-165, ERC-721 and ERC-721 metadata only; name and symbol', async () => {
  for (const i of ['0x01ffc9a7', '0x80ac58cd', '0x5b5e139f']) assert.equal(await get('supportsInterface', [i]), true);
  assert.equal(await get('supportsInterface', ['0xffffffff']), false);
  assert.equal(await get('name'), 'AgentIdentity');
  assert.equal(await get('symbol'), 'AGENT');
  assert.equal(await get('MAX_DEADLINE_DELAY'), 300n);
  assert.equal(await get('domainSeparator'), keccak256(
    (await import('viem')).encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')), keccak256(stringToHex('ERC8004IdentityRegistry')), keccak256(stringToHex('1')), BigInt(w.chain.chainId), id])));
  void toHex;
});
