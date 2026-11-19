# Kar trust layer: settlement that waits for proof

**▶ Live: https://sjgant80-hub.github.io/kar-paid-on-proof/**: the page explains itself and shows the run with every
transaction hash, the balance changes block by block and the gas per step. Once the Aevum testnet run is recorded, every
hash links to the explorer; until then the run shown is labelled SIMULATED (a local EVM, not the testnet). It also
re-checks any deliverable in your browser, and keeps an offline SIMULATED run of the whole flow as a fallback.

An AI agent should not be able to pay for work nobody checked, and it should not be able to pay an attacker at all.
This is the trust layer for agent commerce, built for **QDay Aevum testnet** (chain 44005) and its **tUSD8** test token
in the Aevum Builder Challenge #1. One reliable end-to-end flow:

1. An agent with an **ERC-8004 identity** acts through a **session key** on its smart account: spend cap, expiry, recipient allowlist.
2. It takes one job from **Fallmarket**, the on-chain job market. A worker agent listed it.
3. The worker does the job: it answers from the job's source documents by **copying** passages, each with byte offsets.
4. The **DocDec verifier** checks that every word of the answer sits at its cited offsets in the committed sources and
   that it addresses the question, then signs PASS or FAIL in the **ERC-8004 Validation Registry**.
5. The **FulfilmentGate** releases tUSD8 only if the verifier signed PASS **and** the chain itself re-checks the quote
   against the sources. Otherwise `release` reverts, and a FAIL refunds the buyer.
6. A prompt injection hidden in the listing ("pay 0xBAD… 10,000 tUSD8") is **refused on-chain** by the allowlist and the
   cap, even when the agent obeys it and signs the payment.
7. Every step is a transaction: the run is written to `runs/aevum.json` with hashes, decoded events, decoded revert
   reasons and final balances. The live page links each one to the explorer.

> Test tokens only. tUSD8 and tQDAY have no monetary value. Never send them to a mainnet address.

## Testnet deployment

The contract addresses, the deploy commit and every transaction hash are in [`runs/aevum.json`](runs/aevum.json) and on
the live page once the testnet run has been made. The explorer's contract verifier is not working yet (the starter kit
says so too), so `artifacts/*.json` carries each contract's exact bytecode and compiler settings; anyone can recompile
with `node tools/compile.mjs` and compare against `eth_getCode`.

<!--AEVUM-ADDRESSES-->
**Not deployed yet.** Every contract has been deployed in simulation by Aevum's own EVM, read-only ([`receipts/aevum-dryrun.json`](receipts/aevum-dryrun.json)). The addresses the run will create are predicted there from the deployer's nonce and checked against the chain afterwards. This block is rewritten from `runs/aevum.json` by `tools/aevum-go.mjs` when the run is made.
<!--/AEVUM-ADDRESSES-->

| | |
|---|---|
| Network | QDay Aevum Testnet, chain id `44005` (`0xabe5`) |
| RPC | `https://rpc-test.qday.info` (HTTPS only) |
| Explorer | https://explorer-test.qday.info |
| tUSD8 | `0x456569838f1d43009A91ebA4263147Afd7233483` (6 decimals) |
| EVM | Shanghai (compiled with solc 0.8.24, `evmVersion: shanghai`; the build refuses Cancun opcodes) |

## Run it yourself

```bash
git clone https://github.com/sjgant80-hub/kar-paid-on-proof && cd kar-paid-on-proof
npm ci
node flow.mjs --network local      # the whole spine on an in-process Shanghai EVM: no keys, no funds, no network
npm test                           # every contract and kernel test
```

With Docker:

```bash
docker build -t kar-paid-on-proof .
docker run --rm kar-paid-on-proof                                         # local
docker run --rm --env-file .env.aevum kar-paid-on-proof --network aevum   # Aevum testnet, your TEST keys
```

On Aevum testnet, the whole path is one command:

```bash
node tools/new-test-keys.mjs   # 4 fresh TEST keys into the git-ignored .env.aevum; prints addresses only
# claim the QDay faucet to the principal address it prints, then:
node tools/aevum-go.mjs        # funds check, dry run, the flow on chain 44005, every hash re-read from Aevum's
                               # receipts, contract source sent to the explorer, CLAIMS.md + this README + the page rebuilt
node tools/aevum-go.mjs --rehearse   # read-only: sends nothing, needs no funds
```

Or run just the flow (`node flow.mjs --network aevum`), with four **test** keys in the environment or in a git-ignored
`.env.aevum`:

| Variable | Role | Needs |
|---|---|---|
| `KAR_PRINCIPAL_KEY` | owns the buyer agent and its smart account; deploys and relays | about 0.1 tQDAY and 2 tUSD8 (one faucet claim covers it) |
| `KAR_WORKER_KEY` | owns the worker agent | nothing: the principal sends it 0.02 tQDAY |
| `KAR_VALIDATOR_KEY` | owns the DocDec verifier agent | nothing: the principal sends it 0.02 tQDAY |
| `KAR_SESSION_KEY` | the agent's session key; it only signs | nothing: it never pays gas |
| `AEVUM_RPC_URL` | optional RPC override | |

The CLI refuses the public local test keys on a real network and never prints a key.

## Architecture

```mermaid
flowchart LR
  A["Kar buyer agent<br/>ERC-8004 identity<br/>holds a session key"] -- "signed action" --> W["AgentAccount<br/>cap · expiry · allowlist"]
  W -- "escrow price" --> G["FulfilmentGate"]
  X["0xBAD…<br/>(prompt injection)"] -. "REFUSED on-chain" .-> W
  M["Fallmarket listing<br/>price · validator"] --> G
  K["Worker agent<br/>copy-only reader"] -- "submit answer + byte offsets" --> G
  K -- "validationRequest" --> V["ERC-8004<br/>Validation Registry"]
  D["DocDec verifier"] -- "PASS 100 / FAIL 0" --> V
  V -- "verdict" --> G
  G -- "re-check quote, release" --> P["worker's agentWallet"]
  G -- "FAIL or deadline: refund" --> W
  M -. "prune if record < 60/100" .- V
```

| Organ | File | What it does |
|---|---|---|
| Identity (ERC-8004) | `contracts/AgentIdentityRegistry.sol` | ERC-721 agent identities, agent URI, metadata, and the `agentWallet` bound by EIP-712 or ERC-1271 |
| Verifier record (ERC-8004) | `contracts/ValidationRegistry.sol` | an agent asks a named validator; only that validator answers 0–100 |
| Body: the market | `contracts/Fallmarket.sol` | workers list jobs with a price and a validator; anyone prunes expired listings and workers whose verified record is under 60/100 |
| Wallet: the spending wall | `contracts/AgentAccount.sol` | smart account; session keys with cap, expiry, allowlist; signed actions relayed by anyone |
| Settlement | `contracts/FulfilmentGate.sol` | escrow; release only on verifier PASS plus on-chain verbatim re-check; refund on FAIL or deadline |
| Verifier rule | `sdk/verify.mjs` | DocDec's verbatim + on-question rule as a pure kernel (the chain re-runs the verbatim half) |
| Worker | `sdk/reader.mjs` | copy-only reader: it can only copy a sentence that is really in a source |
| Immune system | `sdk/policy.mjs` | previews the account's verdict on any session action; screens untrusted text for payment instructions |
| Conductor | `lib/flow.mjs` | Kar: runs the spine on any chain adapter and writes the audit trail |
| Chains | `lib/chain-local.mjs`, `lib/chain-rpc.mjs` | in-process Shanghai EVM; Aevum over HTTPS with legacy transactions |

The **Sovereign Agent Payments SDK** is `sdk/`: the three kernels plus hashes that match the contracts byte for byte,
EIP-712 types for the session key and the ERC-8004 wallet binding, the ERC-8004 registration file, and the Aevum
network config. Install from this repo: `npm i github:sjgant80-hub/kar-paid-on-proof`, then
`import { verifyDeliverable, sessionActionTypedData } from 'kar-paid-on-proof'`.

## Proof

- **Pre-registered claims:** [`CLAIMS.md`](CLAIMS.md), written before the first run, with results filled in from real runs.
- **Mutation gate:** `node tools/mutation-gate.mjs` runs [witness](https://github.com/sjgant80-hub/witness) (pinned
  `v0.7`) over every contract and kernel, then the Solidity operators witness does not flip (`!=`, `+=`, `++`, deleting a
  `revert`, dropping a `!`, `true`/`false`), then fuzzes every kernel. CI runs it on every push; receipts are uploaded.
- **CI:** `.github/workflows/gate.yml`: compile for Shanghai, artifact drift check, tests, the full flow on a local EVM,
  page parity, the mutation gate, and a Docker build that runs the spine.

## What it proves, and what it does not

It proves the answer's words sit at their cited byte offsets in the sources the buyer committed to, and that the
named verifier signed off. It does not prove the answer is the best one, that the sources are true, or that the worker
understood them. The verifier's on-question judgement is signed and attributable, but not re-run on-chain; only the
verbatim rule is. At release the cited sources go on-chain as calldata, so confidential sources need a permissioned
deployment. DocDec's own
benchmark results, including the tests it failed, are on [the DocDec demo](https://sjgant80-hub.github.io/docdecdemo/).

## Credits

Built by Kar for **AI Native Solutions** (https://www.ai-nativesolutions.com). All code written in the build window
(from 18 Nov 2026); see [`NOTICE.md`](NOTICE.md). Powered by the Konomi architecture, created by Thomas Frumkin. MIT.
