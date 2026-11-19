#!/usr/bin/env node
// flow.mjs — run the whole spine end to end and write the audit trail.
//
//   node flow.mjs --network local     in-process Shanghai EVM, mock tUSD8, public test keys. No funds, no network.
//   node flow.mjs --network aevum     QDay Aevum testnet (chain 44005), real tUSD8, your TEST keys from the env:
//        KAR_PRINCIPAL_KEY  owner of the buyer agent + its smart account; deploys and relays (needs tQDAY + tUSD8)
//        KAR_WORKER_KEY     the worker agent's owner            (gets a little tQDAY from the principal)
//        KAR_VALIDATOR_KEY  the DocDec verifier agent's owner   (gets a little tQDAY from the principal)
//        KAR_SESSION_KEY    the agent's session key: signs only, never needs gas
//      or KAR_KEYS_FILE=<path to a dotenv file holding those four lines> (the default is .env.aevum)
//
// Writes runs/<network>.json. Keys are never printed or written anywhere by this script.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { privateKeyToAccount } from 'viem/accounts';
import { runFlow } from './lib/flow.mjs';
import { createLocalChain, replacer } from './lib/chain-local.mjs';
import { createRpcChain } from './lib/chain-rpc.mjs';
import { ROLES, LOCAL_KEYS, loadArtifacts, loadJob } from './lib/setup.mjs';
import { TUSD8 } from './sdk/index.mjs';

function keysFromEnv() {
  const file = process.env.KAR_KEYS_FILE || '.env.aevum';
  const env = { ...process.env };
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(0x[0-9a-fA-F]{64})\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  }
  const keys = {};
  for (const r of ROLES) {
    const k = env[`KAR_${r.toUpperCase()}_KEY`];
    if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Error(`missing KAR_${r.toUpperCase()}_KEY (a 0x-prefixed 32-byte TEST key)`);
    if (Object.values(LOCAL_KEYS).includes(k)) throw new Error(`KAR_${r.toUpperCase()}_KEY is a public local test key; refusing to use it on a real network`);
    keys[r] = k;
  }
  if (new Set(Object.values(keys)).size !== ROLES.length) throw new Error('each role needs its own key');
  return keys;
}

const net = (process.argv.find((a, i) => process.argv[i - 1] === '--network') || 'local').toLowerCase();
const art = loadArtifacts();
const abis = Object.values(art).map((a) => a.abi);
const job = loadJob();
let chain;
let keys;
let token;
try {
  if (net === 'local') {
    keys = LOCAL_KEYS;
    chain = await createLocalChain({ abis, fund: [keys.principal] });
  } else if (net === 'aevum') {
    keys = keysFromEnv();
    chain = createRpcChain({ abis, rpcUrl: process.env.AEVUM_RPC_URL || undefined });
    token = TUSD8;
    const p = privateKeyToAccount(keys.principal).address;
    console.log(`principal ${p}: ${(Number(await chain.balance(p)) / 1e18).toFixed(4)} tQDAY`);
  } else {
    throw new Error(`unknown --network ${net} (local | aevum)`);
  }
  let commit = null;
  try {
    commit = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {}
  const trail = await runFlow(chain, { keys, art, job, token, log: (l) => console.log(l) });
  trail.commit = commit;
  trail.explorer = chain.explorer;
  mkdirSync('runs', { recursive: true });
  const out = `runs/${net}.json`;
  writeFileSync(out, JSON.stringify(trail, replacer, 1) + '\n');
  // runs/index.json tells the page which recorded runs exist (it shows Aevum when there is one).
  const idxPath = 'runs/index.json';
  const idx = existsSync(idxPath) ? JSON.parse(readFileSync(idxPath, 'utf8')) : {};
  idx[net] = true;
  writeFileSync(idxPath, JSON.stringify(idx) + '\n');
  const passed = trail.checks.filter((c) => c.ok).length;
  console.log(`\n${trail.steps.length} transactions (${trail.steps.filter((s) => s.status === 'reverted').length} refused on-chain, as designed); ${passed}/${trail.checks.length} checks passed -> ${out}`);
  console.log('final:', JSON.stringify(trail.final, replacer));
} catch (e) {
  console.error('FLOW FAILED:', e.message);
  process.exit(1);
}
