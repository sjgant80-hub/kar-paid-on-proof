# Third-party notices

All code in this repository was written in the Aevum Builder Challenge #1 build window (from 18 Nov 2026).
It is not based on the Aevum Starter Kit; it follows the kit's published network facts (chain 44005, Shanghai EVM,
legacy transactions, the tUSD8 address and decimals, the 1,000-block log limit).

| Component | Use | License |
|---|---|---|
| ERC-8004 (Trustless Agents, Draft) | interfaces, events and the `AgentWalletSet` EIP-712 type are implemented from the spec; the job's source documents are verbatim excerpts of the spec text | CC0 (spec) |
| erc-8004/erc-8004-contracts | consulted for the EIP-712 domain name and type hash, so wallets bound here verify the same way; no code copied | MIT |
| solc (solc-js 0.8.24) | compiler | MIT (GPL-3.0 compiler binary distributed via npm) |
| viem 2.21.54 | ABI encoding, signing, RPC | MIT |
| @ethereumjs/vm 8.1.1 and siblings | the in-process Shanghai EVM for tests, Docker and the in-browser run | MPL-2.0 |
| witness (sjgant80-hub/witness, tag v0.7) | the mutation gate, cloned in CI, not vendored | MIT |
| Powered by the Konomi architecture, created by Thomas Frumkin | the estate's build doctrine | credit |
