// keys.mjs — browser-safe. Local-only keys, derived from public labels: anyone can compute them, so the
// CLI refuses them on any real network. They exist so the local chain, the tests, Docker and the page's
// in-browser run need no secrets at all.
import { keccak256, stringToBytes } from 'viem';

export const ROLES = ['principal', 'worker', 'validator', 'session'];
export const LOCAL_KEYS = Object.fromEntries(ROLES.map((r) => [r, keccak256(stringToBytes(`kar-trust-layer local test key: ${r}`))]));
