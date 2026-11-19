// compile.mjs — compile every contract with the official Solidity compiler (solc-js 0.8.24), EVM version
// SHANGHAI (Aevum has no Cancun opcodes), then refuse any bytecode that carries a Cancun-only opcode.
//
// Each contract file is self-contained (interfaces declared inline), so each compiles on its own and the
// result is cached by the file's SHA-256: a mutation run recompiles only the file it mutated.
//
//   node tools/compile.mjs            -> writes artifacts/<Name>.json (committed: the page and SDK read them)
//   import { compileAll } from './tools/compile.mjs'   -> { Name: { abi, bytecode, deployedBytecode } }

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(ROOT, 'out', 'cache');
export const SOLC_VERSION = '0.8.24';
export const SETTINGS = {
  evmVersion: 'shanghai',
  optimizer: { enabled: true, runs: 200 },
  outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
};

export const CONTRACT_FILES = [
  'contracts/AgentIdentityRegistry.sol',
  'contracts/ValidationRegistry.sol',
  'contracts/Fallmarket.sol',
  'contracts/AgentAccount.sol',
  'contracts/FulfilmentGate.sol',
  'contracts/mocks/MockUSD8.sol',
  'contracts/mocks/MockReceiver.sol',
];

// Opcodes Aevum (Shanghai) does not have. PUSH data is skipped so constants never false-alarm.
const CANCUN_ONLY = { 0x49: 'BLOBHASH', 0x4a: 'BLOBBASEFEE', 0x5c: 'TLOAD', 0x5d: 'TSTORE', 0x5e: 'MCOPY' };

// Strip solc's CBOR metadata trailer (its length is the last two bytes) so hash bytes never false-alarm.
export function stripMetadata(code) {
  if (code.length < 2) return code;
  const len = code.readUInt16BE(code.length - 2);
  return len + 2 <= code.length ? code.subarray(0, code.length - len - 2) : code;
}

export function cancunOpcodes(hex, hasMetadata = true) {
  const raw = Buffer.from(String(hex).replace(/^0x/, ''), 'hex');
  const code = hasMetadata ? stripMetadata(raw) : raw;
  const found = [];
  for (let i = 0; i < code.length; i++) {
    const op = code[i];
    if (op >= 0x60 && op <= 0x7f) {
      i += op - 0x5f;
      continue;
    }
    if (CANCUN_ONLY[op]) found.push(CANCUN_ONLY[op]);
  }
  return found;
}

// Creation code = constructor code + the runtime code (+ its metadata) + constructor args. Scan the
// constructor part only; the runtime part is scanned on its own with its metadata stripped.
function constructorPart(bytecode, deployed) {
  const b = String(bytecode).replace(/^0x/, '');
  const d = String(deployed).replace(/^0x/, '');
  const at = d.length ? b.indexOf(d) : -1;
  return '0x' + (at > 0 ? b.slice(0, at) : b);
}

let solcPromise = null;
function loadSolc() {
  if (!solcPromise) {
    solcPromise = Promise.resolve().then(() => createRequire(import.meta.url)('solc'));
  }
  return solcPromise;
}

async function compileFile(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const sha = createHash('sha256').update(SOLC_VERSION + JSON.stringify(SETTINGS) + src).digest('hex');
  const cached = join(CACHE, sha + '.json');
  if (existsSync(cached)) return JSON.parse(readFileSync(cached, 'utf8'));
  const solc = await loadSolc();
  if (!String(solc.version()).startsWith(SOLC_VERSION)) throw new Error(`solc ${solc.version()} is not ${SOLC_VERSION}`);
  const input = { language: 'Solidity', sources: { [basename(rel)]: { content: src } }, settings: SETTINGS };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(`${rel}:\n` + errors.map((e) => e.formattedMessage).join('\n'));
  const result = {};
  for (const [name, c] of Object.entries(output.contracts[basename(rel)] || {})) {
    const bytecode = '0x' + c.evm.bytecode.object;
    const deployedBytecode = '0x' + c.evm.deployedBytecode.object;
    const bad = cancunOpcodes(deployedBytecode).concat(cancunOpcodes(constructorPart(bytecode, deployedBytecode), false));
    if (bad.length) throw new Error(`${name} uses Cancun-only opcodes (${[...new Set(bad)].join(', ')}); Aevum is Shanghai`);
    result[name] = { abi: c.abi, bytecode, deployedBytecode, source: rel, sourceSha256: createHash('sha256').update(src).digest('hex') };
  }
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(cached, JSON.stringify(result));
  return result;
}

export async function compileAll(files = CONTRACT_FILES) {
  const all = {};
  for (const f of files) Object.assign(all, await compileFile(f));
  return all;
}

// The interfaces declared inside each file also come out as (empty) contracts; keep only real ones.
export const DEPLOYABLE = ['AgentIdentityRegistry', 'ValidationRegistry', 'Fallmarket', 'AgentAccount', 'FulfilmentGate', 'MockUSD8'];

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const all = await compileAll();
  const dir = join(ROOT, 'artifacts');
  mkdirSync(dir, { recursive: true });
  for (const name of DEPLOYABLE) {
    const c = all[name];
    writeFileSync(join(dir, name + '.json'), JSON.stringify({ contractName: name, solc: SOLC_VERSION, settings: SETTINGS, ...c }, null, 1) + '\n');
    console.log(`${name.padEnd(22)} ${((c.deployedBytecode.length - 2) / 2).toString().padStart(6)} bytes  shanghai-clean`);
  }
  const stale = readdirSync(dir).filter((f) => f.endsWith('.json') && !DEPLOYABLE.includes(f.slice(0, -5)));
  if (stale.length) console.log('note: extra files in artifacts/:', stale.join(', '));
}
