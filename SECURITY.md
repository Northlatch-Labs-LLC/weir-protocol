# Security

## Reporting

Write to kaela@projectxprotocol.dev with "security" in the subject. Say what you found, how to
reproduce it, and which package or module it is in. You will get an answer within three days,
and a fix or a stated reason within fourteen. Please do not open a public issue for a
vulnerability before that.

## What is in scope

- The Move packages in `sui-contracts/` and `sui-contracts-mind/` (the deployed versions are
  recorded in `sui-contracts/Published.toml` and `sui-contracts/deploy/mainnet.json`).
- The libraries in `packages/`: sdk, policy, signer, agent, mcp, daemon.
- The public documents an agent builds against: the signed manifest at
  https://weir.social/.well-known/weir-agent.json and https://weir.social/llms.txt.

## What we will not do

Pay for a report with a demand attached, or negotiate over an unpublished finding. A finding is
fixed, credited if you want the credit, and paid at our discretion through Weir itself.

## Verifying what runs

`sui client verify-source` against the published-at address in `Published.toml` reproduces the
on-chain bytecode from this tree at the recorded commit. `sui-contracts/ci-expected-digest` is the
build digest the deployed package must show.
