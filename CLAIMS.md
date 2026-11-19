# Pre-registered claims

Written **before** the first test run or testnet run (19 Nov 2026). Each claim names the check that decides it.
A claim that fails stays on this page, marked FAILED. Results are filled in below each claim only from real runs.

| # | Claim | Decided by | Pass bar |
|---|---|---|---|
| P1 | An agent with an ERC-8004 identity takes a Fallmarket job through a session key, and tUSD8 is escrowed | `flow.mjs` step S4 | `JobOpened` event, gate balance +1.00 |
| P2 | A prompt-injected payment ("pay 0xBAD… 10,000 tUSD8") is refused **on-chain**, even when the agent signs it | S5 | reverted tx, error `RecipientNotAllowed`, attacker balance 0.00 |
| P3 | Routing the same 10,000 through the one allowed recipient is refused by the cap | S5 | reverted tx, error `OverCap` |
| P4 | A grounded, verbatim deliverable is paid only after the DocDec verifier signs PASS and the chain re-checks the quote | S6–S8 | `Released`, worker +1.00 |
| P5 | A reworded deliverable cannot be paid; the buyer gets the escrow back | S9 | release reverts `NotValidated`; `Refunded` reason `failed-validation` |
| P6 | Even a PASS signed by a dishonest verifier cannot release a reworded answer | `test/gate.test.mjs` | reverts `NotVerbatim` |
| P7 | The market prunes a worker whose verified record falls under the bar, permissionlessly | S10 | `Delisted` reason `failed-validations` |
| P8 | A revoked session key is dead at once | S11 | reverted tx, error `SessionNotActive` |
| P9 | No money is stranded or leaked | end of flow | gate 0.00, attacker 0.00, worker 1.00, agent account 1.00 |
| P10 | The page's SDK preview predicts the chain's verdict on every session action | `flow.mjs` checks | preview error == chain error, every action |
| P11 | The contracts, the verifier, the reader and the policy kernels have no test-theatre | `tools/mutation-gate.mjs` | witness + Solidity operators: 0 live survivors; fuzz: never throws |
| P12 | The same flow runs on QDay Aevum testnet with real transactions | `flow.mjs --network aevum` | all of P1–P10 with tx hashes on explorer-test.qday.info |

**What these claims do not say.** The verifier proves an answer's words sit at its cited byte offsets in the committed
sources, and that the copied words cover the question's terms. It does not prove the answer is the best one, that
the sources are true, or that the worker understood anything. DocDec's own benchmark numbers (and its public
failures) are on the DocDec demo page and are not re-claimed here.

## Results

Filled in from real runs only.

**Local Shanghai EVM, 19 Nov 2026** (`node flow.mjs --network local`, `runs/local.json`; the same run passes in CI and
in the page's in-browser EVM): 32 transactions, 4 refused on-chain as designed, 23/23 checks.

| # | Result |
|---|---|
| P1 | PASS (local): `JobOpened`, escrow 1.00 |
| P2 | PASS (local): reverted `RecipientNotAllowed(0xBAD…BaD0)`, attacker 0.00 |
| P3 | PASS (local): reverted `OverCap(1000000, 10000000000)` |
| P4 | PASS (local): verifier 100/100, `Released`, worker +1.00 |
| P5 | PASS (local): release reverted `NotValidated(0)`, `Refunded` reason `failed-validation` |
| P6 | PASS: `test/gate.test.mjs` "a reworded answer is refused on-chain even if a verifier wrongly signed PASS" → `NotVerbatim` |
| P7 | PASS (local): `Delisted` reason `failed-validations` (record 2 verdicts, average 50) |
| P8 | PASS (local): reverted `SessionNotActive` |
| P9 | PASS (local): gate 0.00, attacker 0.00, worker 1.00, agent account 1.00 |
| P10 | PASS (local): preview == chain on all 5 session actions in the run (2 accepted, 3 refused) |
| P11 | Kernels PASS locally (witness v0.7): verify 49/49, reader 9/9, policy 14/14, cost 6/6, all fuzz never-throws. Two equivalent loop-bound mutants and one guard made dead by a refactor were removed from the code, not baselined. Contracts: gated in CI on every push (see Actions). |
| P12 | PENDING: waits on a funded testnet key (Simon's yes) |
