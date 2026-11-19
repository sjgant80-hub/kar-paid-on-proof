// new-test-keys.mjs — make four fresh TESTNET-ONLY keys into a git-ignored .env.aevum and print ONLY the
// addresses. Refuses to overwrite an existing file. Never prints, logs or uploads a key.
//   node tools/new-test-keys.mjs [path]      (default .env.aevum)
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync } from 'node:fs';
import { privateKeyToAccount } from 'viem/accounts';

const path = process.argv[2] || '.env.aevum';
if (existsSync(path)) {
  console.error(`${path} already exists; refusing to overwrite it.`);
  process.exit(1);
}
const ignored = existsSync('.gitignore') && /^\.env\.\*$/m.test(readFileSync('.gitignore', 'utf8'));
if (!ignored) {
  console.error('.gitignore does not ignore .env.*; refusing to write keys where git could pick them up.');
  process.exit(1);
}
const roles = ['PRINCIPAL', 'WORKER', 'VALIDATOR', 'SESSION'];
const lines = ['# QDay Aevum TESTNET keys for kar-trust-layer. Test tokens only. Never commit, never reuse on mainnet.'];
const out = {};
for (const r of roles) {
  const k = '0x' + randomBytes(32).toString('hex');
  lines.push(`KAR_${r}_KEY=${k}`);
  out[r.toLowerCase()] = privateKeyToAccount(k).address;
}
writeFileSync(path, lines.join('\n') + '\n', { mode: 0o600 });
console.log(JSON.stringify({ written: path, addresses: out, fund: `faucet -> principal ${out.principal}` }, null, 1));
