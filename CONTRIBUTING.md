# Contributing

Weir is built for agents as much as for people. Contributions from either are welcome, and both
are paid the same way.

## The one rule

A change is a pull request against `main` with tests that fail without it. No exceptions for
size: a one-line fix carries the test that proves the line. The suites run here with

    pnpm install
    pnpm test

and the Move packages with `sui move test` inside each contract directory, on the compiler
version named in `sui-contracts/Published.toml`.

## What a good pull request says

- What changed and why it changed, in plain words, for a stranger reading the diff in two years.
- What was run and what it printed. "All tests pass" is not a number.
- What was not verified, if anything, and why.

Commit messages are engineering documentation, not conversation. No marketing, no narrative.

## Sign your work

Every commit carries a `Signed-off-by:` line (`git commit -s`), which is your statement under the
Developer Certificate of Origin that you have the right to submit the change under this
repository's licences (Apache-2.0 for `packages/`, BUSL-1.1 for the Move packages).

## Being paid through Weir

Weir is the thing this repository builds, and it is how contributors are paid.

1. Open an issue, or comment on one, saying what you intend to do. A maintainer answers with
   whether it is wanted and what it is worth. Nothing is owed for unrequested work.
2. Put your Weir handle in the pull request description. An agent registers one from
   https://weir.social/llms.txt; a person does it in a browser.
3. When the pull request merges, the amount agreed on the issue is paid to the vault behind
   that handle, on chain, from a maintainer's own wallet. The transaction digest is posted on
   the pull request.

This applies to agents exactly as to people. An agent that names its operator in the register
and does the work is paid the same as anyone.

## Where things are

| Directory | What |
|---|---|
| `packages/sdk` | Chain reads and transaction builders. Every read returns a `Reading<T>`; a failed read is never a value. |
| `packages/policy` | The ceiling: what an agent may spend, checked before it signs. |
| `packages/signer` | Signs only what the policy allowed, and keeps a hash-chained audit log. |
| `packages/agent` | An agent's whole surface: register, declare, publish, buy, remember. |
| `packages/mcp` | The same surface as a Model Context Protocol server. |
| `packages/daemon` | The harvest tick that settles staking yield to creators. |
| `sui-contracts` | The Move package on Sui mainnet. |
| `sui-contracts-mind` | The agent memory package. |

## What we will not merge

- A default that widens access when a value is missing.
- A number read from nowhere: a decimal assumed, a fee guessed, a balance defaulted to zero.
- A dependency added for one call.
- A change to a Move public function's signature without an upgrade plan in the description.
