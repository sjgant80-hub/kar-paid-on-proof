// AgentAccount: the session key's wall. Cap, expiry, allowlist, signature, nonce, revoke: each on both sides.
import { test, before } from 'node:test';
import { encodeFunctionData, keccak256 } from 'viem';
import { world, K, addr, acct, assert, units } from './helpers.mjs';
import { sessionActionTypedData, checkSessionAction, KIND_CALL, KIND_TRANSFER } from '../sdk/index.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const BAD = '0xBAD000000000000000000000000000000000BaD0';
let w, token, account, sink, keyN = 0;

before(async () => {
  w = await world();
  token = await w.deploy('MockUSD8');
  account = await w.deploy('AgentAccount', [addr.owner, token]);
  sink = await w.deploy('MockReceiver'); // any contract with code, used as an allowlisted call target
  await w.ok(w.send(K.owner, token, 'MockUSD8', 'mint', [account, units(100)]));
});

// A fresh session key per test: one key, one session, forever.
async function grant({ cap = units(2), ttl = 3600n, allow = [addr.bob] } = {}) {
  keyN += 1;
  const { privateKeyToAccount } = await import('viem/accounts');
  const k = keccak256(new TextEncoder().encode(`session ${keyN}`));
  const a = privateKeyToAccount(k);
  const expiry = (await w.chain.time()) + ttl;
  const r = await w.ok(w.send(K.owner, account, 'AgentAccount', 'grantSession', [a.address, cap, expiry, allow]));
  return { k, a, expiry, r };
}
async function act(s, { kind = KIND_TRANSFER, target = addr.bob, amount = units(1), data = '0x', deadlineIn = 600n, signer, nonce, key, sig } = {}) {
  const sess = await w.read(account, 'AgentAccount', 'sessions', [s.a.address]);
  const deadline = (await w.chain.time()) + deadlineIn;
  const td = sessionActionTypedData({ chainId: w.chain.chainId, account, kind, target, amount, data, nonce: nonce ?? sess[3], deadline });
  const signature = sig ?? (await (signer ?? s.a).signTypedData(td));
  return w.send(K.carol, account, 'AgentAccount', 'executeSession', [key ?? s.a.address, kind, target, amount, data, deadline, signature], { allowRevert: true });
}
const bal = (a) => w.read(token, 'MockUSD8', 'balanceOf', [a]);

test('a scoped transfer moves exactly the amount and counts it against the cap', async () => {
  const s = await grant();
  const before = await bal(addr.bob);
  const r = await w.ok(act(s, { amount: units(1.5) }));
  assert.equal((await bal(addr.bob)) - before, units(1.5));
  const e = w.ev(r, 'SessionSpent')[0].args;
  assert.equal(e.key, s.a.address);
  assert.equal(e.amount, units(1.5));
  assert.equal(e.spentTotal, units(1.5));
  assert.equal(e.nonce, 1n);
  assert.equal(await w.read(account, 'AgentAccount', 'remaining', [s.a.address]), units(0.5));
  const sess = await w.read(account, 'AgentAccount', 'sessions', [s.a.address]);
  assert.equal(sess[1], units(1.5));
  assert.equal(sess[3], 1n);
});

test('the injection: paying an address off the allowlist is refused, whatever the amount', async () => {
  const s = await grant();
  await w.reverts(act(s, { target: BAD, amount: units(10000) }), 'RecipientNotAllowed', [BAD]);
  await w.reverts(act(s, { target: BAD, amount: 1n }), 'RecipientNotAllowed', [BAD]);
  assert.equal(await bal(BAD), 0n);
});

test('the cap: spending exactly what is left is fine; one unit more is OverCap(left, asked)', async () => {
  const s = await grant({ cap: units(2) });
  await w.ok(act(s, { amount: units(1) }));
  await w.reverts(act(s, { amount: units(1) + 1n }), 'OverCap', [units(1), units(1) + 1n]);
  await w.ok(act(s, { amount: units(1) }));
  await w.reverts(act(s, { amount: 1n }), 'OverCap', [0n, 1n]);
  assert.equal(await w.read(account, 'AgentAccount', 'remaining', [s.a.address]), 0n);
});

test('expiry: an action at the expiry second is allowed, one after is SessionExpired', async () => {
  const s = await grant({ ttl: 20n });
  await w.chain.advance(Number(s.expiry - (await w.chain.time())));
  assert.equal(await w.read(account, 'AgentAccount', 'remaining', [s.a.address]), units(2));
  await w.ok(act(s, { amount: 1n }));
  await w.reverts(act(s, { amount: 1n }), 'SessionExpired');
  assert.equal(await w.read(account, 'AgentAccount', 'remaining', [s.a.address]), 0n);
});

test('action deadline: at the deadline is allowed, after it is ActionExpired', async () => {
  const s = await grant();
  await w.ok(act(s, { amount: 1n, deadlineIn: 0n }));
  await w.reverts(act(s, { amount: 1n, deadlineIn: -2n }), 'ActionExpired');
});

test('signatures: wrong signer, wrong length, replayed nonce and a key with no session are refused', async () => {
  const s = await grant();
  await w.reverts(act(s, { signer: acct.stranger }), 'BadSignature');
  await w.reverts(act(s, { sig: '0x' + '11'.repeat(64) }), 'BadSignature');
  await w.ok(act(s, { amount: 1n }));
  await w.reverts(act(s, { amount: 1n, nonce: 0n }), 'BadSignature');
  // a junk signature recovers address(0); naming key 0 gets past the signature check, but key 0 is never granted
  await w.reverts(act(s, { key: ZERO, sig: '0x' + '00'.repeat(65) }), 'SessionNotActive');
  // a real signature from a key that was never granted: refused because there is no session
  await w.reverts(act(s, { key: addr.stranger, signer: acct.stranger, nonce: 0n }), 'SessionNotActive');
});

test('revoke: the key is dead at once and remaining() reads 0', async () => {
  const s = await grant();
  const r = await w.ok(w.send(K.owner, account, 'AgentAccount', 'revokeSession', [s.a.address]));
  assert.equal(w.ev(r, 'SessionRevoked')[0].args.key, s.a.address);
  await w.reverts(act(s, { amount: 1n }), 'SessionNotActive');
  assert.equal(await w.read(account, 'AgentAccount', 'remaining', [s.a.address]), 0n);
});

test('a CALL approves exactly the amount for the target, calls it, then clears the approval', async () => {
  const s = await grant({ allow: [sink] });
  const data = encodeFunctionData({ abi: w.art.MockReceiver.abi, functionName: 'set', args: ['0x12345678', false] });
  await w.ok(act(s, { kind: KIND_CALL, target: sink, amount: units(1), data }));
  assert.equal(await w.read(sink, 'MockReceiver', 'answer'), '0x12345678');
  assert.equal(await w.read(token, 'MockUSD8', 'allowance', [account, sink]), 0n);
  assert.equal(await w.read(account, 'AgentAccount', 'remaining', [s.a.address]), units(1));
});

test('a CALL whose target reverts bubbles up as CallFailed; the spend does not stick', async () => {
  const s = await grant({ allow: [sink] });
  const bad = encodeFunctionData({ abi: w.art.MockUSD8.abi, functionName: 'mint', args: [addr.bob, 1n] }); // MockReceiver has no mint
  await w.reverts(act(s, { kind: KIND_CALL, target: sink, amount: units(1), data: bad }), 'CallFailed');
  assert.equal(await w.read(account, 'AgentAccount', 'remaining', [s.a.address]), units(2));
});

test('kinds: a transfer with data, a call to the token itself, and an unknown kind are refused', async () => {
  const s = await grant({ allow: [addr.bob, token] });
  await w.reverts(act(s, { data: '0x1234' }), 'BadKind');
  const steal = encodeFunctionData({ abi: w.art.MockUSD8.abi, functionName: 'transfer', args: [BAD, units(1)] });
  await w.reverts(act(s, { kind: KIND_CALL, target: token, data: steal }), 'TokenCallForbidden');
  await w.reverts(act(s, { kind: 2 }), 'BadKind');
});

test('a token that returns false is refused with TransferFailed', async () => {
  const s = await grant();
  await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [1]));
  try {
    await w.reverts(act(s, { amount: 1n }), 'TransferFailed');
  } finally {
    await w.ok(w.send(K.owner, token, 'MockUSD8', 'setMode', [0]));
  }
});

test('grant: owner only, no zero key, no re-grant of a used key, expiry must be in the future', async () => {
  const s = await grant({ allow: [addr.bob, addr.carol] });
  const e = w.ev(s.r, 'SessionGranted')[0].args;
  assert.deepEqual(e.recipients, [addr.bob, addr.carol]);
  assert.equal(await w.read(account, 'AgentAccount', 'isAllowed', [s.a.address, addr.carol]), true);
  assert.equal(await w.read(account, 'AgentAccount', 'isAllowed', [s.a.address, BAD]), false);
  const t = (await w.chain.time()) + 100n;
  await w.reverts(w.send(K.stranger, account, 'AgentAccount', 'grantSession', [addr.stranger, 1n, t, []], { allowRevert: true }), 'NotOwner');
  await w.reverts(w.send(K.owner, account, 'AgentAccount', 'grantSession', [ZERO, 1n, t, []], { allowRevert: true }), 'ZeroAddress');
  await w.reverts(w.send(K.owner, account, 'AgentAccount', 'grantSession', [s.a.address, 1n, t, []], { allowRevert: true }), 'KeyAlreadyUsed');
  await w.ok(w.send(K.owner, account, 'AgentAccount', 'revokeSession', [s.a.address]));
  await w.reverts(w.send(K.owner, account, 'AgentAccount', 'grantSession', [s.a.address, 1n, t + 999n, []], { allowRevert: true }), 'KeyAlreadyUsed');
  const now = await w.chain.time();
  await w.reverts(w.send(K.owner, account, 'AgentAccount', 'grantSession', [addr.alice, 1n, now, []], { allowRevert: true }), 'BadExpiry');
  const now2 = await w.chain.time();
  await w.ok(w.send(K.owner, account, 'AgentAccount', 'grantSession', [addr.alice, 1n, now2 + 1n, []]));
  await w.reverts(w.send(K.stranger, account, 'AgentAccount', 'revokeSession', [addr.alice], { allowRevert: true }), 'NotOwner');
});

test('owner execute: runs any call, refuses strangers, bubbles a failing call', async () => {
  const data = encodeFunctionData({ abi: w.art.MockUSD8.abi, functionName: 'transfer', args: [addr.carol, 5n] });
  const before = await bal(addr.carol);
  const r = await w.ok(w.send(K.owner, account, 'AgentAccount', 'execute', [token, 0n, data]));
  assert.equal((await bal(addr.carol)) - before, 5n);
  assert.equal(w.ev(r, 'OwnerExecuted')[0].args.dataHash, keccak256(data));
  await w.reverts(w.send(K.stranger, account, 'AgentAccount', 'execute', [token, 0n, data], { allowRevert: true }), 'NotOwner');
  const tooMuch = encodeFunctionData({ abi: w.art.MockUSD8.abi, functionName: 'transfer', args: [addr.carol, units(10 ** 6)] });
  await w.reverts(w.send(K.owner, account, 'AgentAccount', 'execute', [token, 0n, tooMuch], { allowRevert: true }), 'CallFailed');
});

test('ERC-1271: signs as its owner, and only its owner', async () => {
  const hash = keccak256('0x1234');
  const good = await acct.owner.sign({ hash });
  const bad = await acct.stranger.sign({ hash });
  assert.equal(await w.read(account, 'AgentAccount', 'isValidSignature', [hash, good]), '0x1626ba7e');
  assert.equal(await w.read(account, 'AgentAccount', 'isValidSignature', [hash, bad]), '0xffffffff');
  assert.equal(await w.read(account, 'AgentAccount', 'isValidSignature', [hash, '0x1234']), '0xffffffff');
});

test('the account refuses a zero owner or token, and exposes both', async () => {
  await assert.rejects(w.chain.deploy(K.owner, w.art.AgentAccount, [ZERO, token]), /ZeroAddress/);
  await assert.rejects(w.chain.deploy(K.owner, w.art.AgentAccount, [addr.owner, ZERO]), /ZeroAddress/);
  assert.equal(await w.read(account, 'AgentAccount', 'owner'), addr.owner);
  assert.equal(await w.read(account, 'AgentAccount', 'token'), token);
  assert.equal(await w.read(account, 'AgentAccount', 'KIND_TRANSFER'), 0);
  assert.equal(await w.read(account, 'AgentAccount', 'KIND_CALL'), 1);
});

test('the SDK preview agrees with the chain on every refusal above', async () => {
  const s = await grant({ cap: units(1) });
  const sess = await w.read(account, 'AgentAccount', 'sessions', [s.a.address]);
  const now = await w.chain.time();
  const view = { cap: sess[0], spent: sess[1], expiry: sess[2], active: sess[4], allowlist: [addr.bob] };
  const cases = [
    [{ kind: KIND_TRANSFER, target: BAD, amount: units(10000) }, 'RecipientNotAllowed'],
    [{ kind: KIND_TRANSFER, target: addr.bob, amount: units(2) }, 'OverCap'],
    [{ kind: KIND_TRANSFER, target: addr.bob, amount: units(1) }, null],
  ];
  for (const [a, expected] of cases) {
    const p = checkSessionAction(view, { ...a, dataLength: 0, deadline: now + 600n, signerOk: true, token }, now);
    assert.equal(p.error, expected);
    const r = await act(s, a);
    assert.equal(r.error?.name ?? null, expected);
  }
});

test('the account can receive native gas', async () => {
  await w.ok(w.chain.sendValue(K.owner, account, 1000n));
  assert.equal(await w.chain.balance(account), 1000n);
});
