// setup.mjs — shared by the CLI, the tests and the Docker run (Node only: reads files).
import { readFileSync } from 'node:fs';

export { ROLES, LOCAL_KEYS } from './keys.mjs';
export const CONTRACTS = ['AgentIdentityRegistry', 'ValidationRegistry', 'Fallmarket', 'AgentAccount', 'FulfilmentGate', 'MockUSD8'];

export function loadArtifacts() {
  return Object.fromEntries(CONTRACTS.map((n) => [n, JSON.parse(readFileSync(new URL(`../artifacts/${n}.json`, import.meta.url), 'utf8'))]));
}

export function loadJob() {
  return JSON.parse(readFileSync(new URL('../fixtures/job.json', import.meta.url), 'utf8'));
}
