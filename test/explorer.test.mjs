// The explorer source-verification step, against a stub explorer: it submits the exact compiler input and the
// encoded constructor arguments, reports success only when the explorer says verified, and never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadArtifacts } from '../lib/setup.mjs';
import { verifyOnExplorer, standardInput, constructorArgs } from '../lib/explorer-verify.mjs';

const art = loadArtifacts();
const A1 = '0x00000000000000000000000000000000000000A1';
const nowait = async () => {};

test('the standard input is the per-file compile tools/compile.mjs ran, with its settings', () => {
  const src = readFileSync(art.FulfilmentGate.source, 'utf8');
  const s = standardInput(art.FulfilmentGate, src);
  assert.deepEqual(Object.keys(s.sources), ['FulfilmentGate.sol']);
  assert.equal(s.sources['FulfilmentGate.sol'].content, src);
  assert.equal(s.settings.evmVersion, 'shanghai');
  assert.equal(constructorArgs(art.AgentIdentityRegistry, []), '');
  assert.equal(constructorArgs(art.ValidationRegistry, [A1]), '00000000000000000000000000000000000000000000000000000000000000a1');
});

test('verified only when the explorer reports is_verified; the submission carries version, licence and args', async () => {
  const seen = [];
  const fetchImpl = async (url, opts = {}) => {
    seen.push({ url, opts });
    if (opts.method === 'POST') return { ok: true, status: 200, text: async () => '{"message":"started"}' };
    return { ok: true, json: async () => ({ is_verified: seen.length > 2 }) };
  };
  const r = await verifyOnExplorer({ explorer: 'https://x.test', address: '0xabc', contract: 'ValidationRegistry', art: art.ValidationRegistry, sourceText: 'src', args: [A1], compilerVersion: 'v0.8.24+commit.e11b9ed9', fetchImpl, wait: nowait });
  assert.equal(r.ok, true);
  assert.equal(r.url, 'https://x.test/address/0xabc?tab=contract');
  const post = seen[0];
  assert.equal(post.url, 'https://x.test/api/v2/smart-contracts/0xabc/verification/via/standard-input');
  assert.equal(post.opts.body.get('compiler_version'), 'v0.8.24+commit.e11b9ed9');
  assert.equal(post.opts.body.get('license_type'), 'mit');
  assert.match(post.opts.body.get('constructor_args'), /a1$/);
});

test('a refused submission, a verification that never lands, and a dead network are reported, not thrown', async () => {
  const base = { explorer: 'https://x.test', address: '0x1', contract: 'C', art: art.AgentIdentityRegistry, sourceText: 's', compilerVersion: 'v', wait: nowait };
  const r1 = await verifyOnExplorer({ ...base, fetchImpl: async () => ({ ok: false, status: 404, text: async () => 'Not found' }) });
  assert.equal(r1.ok, false);
  assert.match(r1.detail, /HTTP 404 Not found/);
  const never = async (u, o = {}) => (o.method === 'POST' ? { ok: true, status: 200, text: async () => 'ok' } : { ok: true, json: async () => ({ is_verified: false }) });
  const r2 = await verifyOnExplorer({ ...base, fetchImpl: never, polls: 2 });
  assert.equal(r2.ok, false);
  assert.match(r2.detail, /not shown as verified after 12 s/);
  const r3 = await verifyOnExplorer({ ...base, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.match(r3.detail, /could not submit: ECONNRESET/);
});
