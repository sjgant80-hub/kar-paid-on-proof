// ValidationRegistry (ERC-8004 validation) and Fallmarket (listings + self-cleaning).
import { test, before } from 'node:test';
import { keccak256, stringToHex } from 'viem';
import { world, K, addr, assert, units, registries } from './helpers.mjs';

const ZERO = '0x0000000000000000000000000000000000000000';
const ZERO32 = '0x' + '00'.repeat(32);
let w, identity, validation, market, n = 0;
const h = () => keccak256(stringToHex(`request ${++n}`));
const V = (from, fn, args) => w.send(K[from], validation, 'ValidationRegistry', fn, args, { allowRevert: true });
const M = (from, fn, args) => w.send(K[from], market, 'Fallmarket', fn, args, { allowRevert: true });
const vget = (fn, args = []) => w.read(validation, 'ValidationRegistry', fn, args);
const mget = (fn, args = []) => w.read(market, 'Fallmarket', fn, args);

before(async () => {
  w = await world();
  ({ identity, validation } = await registries(w)); // alice #1, bob #2, carol #3
  market = await w.deploy('Fallmarket', [identity, validation]);
});

// ── ValidationRegistry ─────────────────────────────────────────────────────
test('request then response: stored, queryable, events carry every field', async () => {
  const rh = h();
  const r1 = await w.ok(V('bob', 'validationRequest', [addr.validator, 2n, 'data:req', rh]));
  const e1 = w.ev(r1, 'ValidationRequest')[0].args;
  assert.deepEqual([e1.validatorAddress, e1.agentId, e1.requestURI, e1.requestHash], [addr.validator, 2n, 'data:req', rh]);
  let s = await vget('getValidationStatus', [rh]);
  assert.deepEqual([s[0], s[1], s[2], s[5]], [addr.validator, 2n, 0, 0n]);
  const rep = keccak256('0xabcd');
  const r2 = await w.ok(V('validator', 'validationResponse', [rh, 100, 'data:report', rep, 'docdec-verbatim-v1']));
  const e2 = w.ev(r2, 'ValidationResponse')[0].args;
  assert.deepEqual([e2.validatorAddress, e2.agentId, e2.response, e2.responseURI, e2.responseHash, e2.tag], [addr.validator, 2n, 100, 'data:report', rep, 'docdec-verbatim-v1']);
  s = await vget('getValidationStatus', [rh]);
  assert.equal(s[2], 100);
  assert.equal(s[3], rep);
  assert.equal(s[4], 'docdec-verbatim-v1');
  assert.ok(s[5] > 0n);
  assert.ok((await vget('getAgentValidations', [2n])).includes(rh));
  assert.ok((await vget('getValidatorRequests', [addr.validator])).includes(rh));
  assert.equal(await vget('getIdentityRegistry'), identity);
});

test('only the agent\'s owner or operator may request; a hash is claimed once; zero values refused', async () => {
  const rh = h();
  await w.reverts(V('stranger', 'validationRequest', [addr.validator, 2n, '', rh]), 'NotAuthorized');
  await w.reverts(V('bob', 'validationRequest', [ZERO, 2n, '', rh]), 'ZeroAddress');
  await w.reverts(V('bob', 'validationRequest', [addr.validator, 2n, '', ZERO32]), 'EmptyHash');
  await w.ok(V('bob', 'validationRequest', [addr.validator, 2n, '', rh]));
  await w.reverts(V('bob', 'validationRequest', [addr.carol, 2n, '', rh]), 'AlreadyRequested');
  await w.ok(w.send(K.bob, identity, 'AgentIdentityRegistry', 'setApprovalForAll', [addr.carol, true]));
  await w.ok(V('carol', 'validationRequest', [addr.validator, 2n, '', h()]));
  await w.ok(w.send(K.bob, identity, 'AgentIdentityRegistry', 'setApprovalForAll', [addr.carol, false]));
});

test('only the named validator may answer, 0..100, and may update its answer', async () => {
  const rh = h();
  await w.reverts(V('validator', 'validationResponse', [rh, 100, '', ZERO32, '']), 'UnknownRequest');
  await w.ok(V('bob', 'validationRequest', [addr.validator, 2n, '', rh]));
  await w.reverts(V('carol', 'validationResponse', [rh, 100, '', ZERO32, '']), 'NotValidator');
  await w.reverts(V('validator', 'validationResponse', [rh, 101, '', ZERO32, '']), 'ResponseOutOfRange');
  await w.ok(V('validator', 'validationResponse', [rh, 0, '', ZERO32, 'soft']));
  await w.ok(V('validator', 'validationResponse', [rh, 100, '', ZERO32, 'hard']));
  const s = await vget('getValidationStatus', [rh]);
  assert.equal(s[2], 100);
  assert.equal(s[4], 'hard');
});

test('getSummary counts answered validations only, with validator and tag filters', async () => {
  const agent = 1n; // alice's agent, fresh in this file
  const answer = async (validator, response, tag) => {
    const rh = h();
    await w.ok(V('alice', 'validationRequest', [addr[validator], agent, '', rh]));
    if (response !== null) await w.ok(V(validator, 'validationResponse', [rh, response, '', ZERO32, tag]));
  };
  assert.deepEqual(await vget('getSummary', [agent, [], '']), [0n, 0]);
  await answer('validator', 100, 'a');
  await answer('validator', 50, 'b');
  await answer('carol', 0, 'a');
  await answer('validator', null, 'a'); // asked, never answered: not counted
  assert.deepEqual(await vget('getSummary', [agent, [], '']), [3n, 50]);
  assert.deepEqual(await vget('getSummary', [agent, [addr.validator], '']), [2n, 75]);
  assert.deepEqual(await vget('getSummary', [agent, [addr.carol], '']), [1n, 0]);
  assert.deepEqual(await vget('getSummary', [agent, [addr.stranger, addr.carol], '']), [1n, 0]);
  assert.deepEqual(await vget('getSummary', [agent, [], 'a']), [2n, 50]);
  assert.deepEqual(await vget('getSummary', [agent, [addr.validator], 'a']), [1n, 100]);
  assert.deepEqual(await vget('getSummary', [agent, [], 'zzz']), [0n, 0]);
});

test('the registry refuses a zero identity registry', async () => {
  await assert.rejects(w.chain.deploy(K.owner, w.art.ValidationRegistry, [ZERO]), /ZeroAddress/);
});

// ── Fallmarket ──────────────────────────────────────────────────────────────
async function listing({ who = 'bob', agent = 2n, price = units(1), ttl = 3600n, validator = addr.validator } = {}) {
  const expiry = (await w.chain.time()) + ttl;
  const r = await w.ok(M(who, 'list', [agent, validator, price, expiry, 'data:terms']));
  return { id: w.ev(r, 'Listed')[0].args.listingId, expiry, r };
}

test('a worker agent lists a job; the listing reads back exactly', async () => {
  const l = await listing();
  const e = w.ev(l.r, 'Listed')[0].args;
  assert.deepEqual([e.workerAgentId, e.validator, e.price, e.expiry, e.termsURI], [2n, addr.validator, units(1), l.expiry, 'data:terms']);
  const g = await mget('getListing', [l.id]);
  assert.deepEqual(g, [2n, addr.validator, units(1), l.expiry, true, 'data:terms']);
  assert.equal(await mget('isLive', [l.id]), true);
  assert.equal(await mget('listingCount'), l.id);
  assert.equal(await mget('identity'), identity);
  assert.equal(await mget('validation'), validation);
});

test('list guards: owner/operator only, validator set, price > 0, expiry strictly in the future', async () => {
  const t = (await w.chain.time()) + 100n;
  await w.reverts(M('stranger', 'list', [2n, addr.validator, 1n, t, '']), 'NotAuthorized');
  await w.reverts(M('bob', 'list', [2n, ZERO, 1n, t, '']), 'ZeroAddress');
  await w.reverts(M('bob', 'list', [2n, addr.validator, 0n, t, '']), 'ZeroPrice');
  const now = await w.chain.time();
  await w.reverts(M('bob', 'list', [2n, addr.validator, 1n, now, '']), 'BadExpiry');
  const now2 = await w.chain.time();
  await w.ok(M('bob', 'list', [2n, addr.validator, 1n, now2 + 1n, '']));
});

test('delist: owner only, once; an unknown listing is refused', async () => {
  const l = await listing();
  await w.reverts(M('stranger', 'delist', [l.id]), 'NotAuthorized');
  const r = await w.ok(M('bob', 'delist', [l.id]));
  assert.equal(w.ev(r, 'Delisted')[0].args.reason, 'owner');
  assert.equal(await mget('isLive', [l.id]), false);
  await w.reverts(M('bob', 'delist', [l.id]), 'NotActive');
  await w.reverts(M('bob', 'delist', [999n]), 'NoSuchListing');
  await assert.rejects(mget('getListing', [999n]), /reverted/);
  assert.equal(await mget('isLive', [999n]), false);
});

test('expiry: live at the expiry second, prunable one second after, by anyone', async () => {
  const l = await listing({ ttl: 20n });
  await w.chain.advance(Number(l.expiry - (await w.chain.time())));
  assert.equal(await mget('isLive', [l.id]), true);
  await w.reverts(M('stranger', 'prune', [l.id]), 'NothingToPrune');
  const r = await w.ok(M('stranger', 'prune', [l.id]));
  const e = w.ev(r, 'Delisted')[0].args;
  assert.equal(e.reason, 'expired');
  assert.equal(e.by, addr.stranger);
  assert.equal(await mget('isLive', [l.id]), false);
  await w.reverts(M('stranger', 'prune', [l.id]), 'NotActive');
  await w.reverts(M('stranger', 'prune', [999n]), 'NoSuchListing');
});

test('metabolism: pruned only with >= 2 answered validations averaging < 60 from the listing\'s validator', async () => {
  assert.equal(await mget('MIN_SAMPLES'), 2n);
  assert.equal(await mget('MIN_AVERAGE'), 60);
  const l = await listing({ who: 'carol', agent: 3n, ttl: 86400n });
  const verdict = async (response, validator = 'validator') => {
    const rh = h();
    await w.ok(V('carol', 'validationRequest', [addr[validator], 3n, '', rh]));
    await w.ok(V(validator, 'validationResponse', [rh, response, '', ZERO32, '']));
  };
  await verdict(0);
  await w.reverts(M('stranger', 'prune', [l.id]), 'NothingToPrune', [1n, 0]); // one bad sample is not enough
  await verdict(0, 'bob'); // a different validator's verdict does not count for this listing
  await w.reverts(M('stranger', 'prune', [l.id]), 'NothingToPrune', [1n, 0]);
  await verdict(100); // 0 + 100 -> average 50
  const r = await w.ok(M('stranger', 'prune', [l.id]));
  assert.equal(w.ev(r, 'Delisted')[0].args.reason, 'failed-validations');
  assert.equal(await mget('isLive', [l.id]), false);
});

test('metabolism boundary: an average of exactly 60 survives', async () => {
  // fresh agent for a clean record
  await w.ok(w.send(K.stranger, identity, 'AgentIdentityRegistry', 'register', ['ipfs://s']));
  const agent = await w.read(identity, 'AgentIdentityRegistry', 'agentCount');
  const l = await listing({ who: 'stranger', agent, ttl: 86400n });
  for (const response of [100, 20]) {
    const rh = h();
    await w.ok(V('stranger', 'validationRequest', [addr.validator, agent, '', rh]));
    await w.ok(V('validator', 'validationResponse', [rh, response, '', ZERO32, '']));
  }
  await w.reverts(M('alice', 'prune', [l.id]), 'NothingToPrune', [2n, 60]);
});

test('the market refuses zero registries', async () => {
  await assert.rejects(w.chain.deploy(K.owner, w.art.Fallmarket, [ZERO, validation]), /ZeroAddress/);
  await assert.rejects(w.chain.deploy(K.owner, w.art.Fallmarket, [identity, ZERO]), /ZeroAddress/);
});
