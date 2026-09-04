# @projectx-social/sdk

TypeScript client for the `projectx_social` Move package on Sui.

## Two rules that shape the whole API

**A failed read is never a value.** Chain reads return `Reading<T>`, which is either a value with
an observation time or a typed failure. There is no `unwrapOr` and no default — a default is the
exact mechanism that turns an outage into a plausible zero, and a creator shown "0 earned" because
a node timed out looks identical to one who has earned nothing.

```ts
const platform = await readPlatform(client, config);
fold(
  platform,
  (p) => render(`${Number(p.feeBps) / 100}%`),
  (f) => render(`fee not measured — ${f.kind}`),   // both branches required
);
```

**Nothing signs without simulating.** Builders in `tx` return a `Transaction`; they never execute.
Call `simulate()` and only offer to sign once it passes. On a chain an abort discovered after
signing has already cost gas, and a *success* discovered after signing may have moved money.

## Transport

gRPC, via `@mysten/sui/grpc`. Not a preference: Sui public fullnodes answer JSON-RPC with
`-32601 "JSON-RPC on public fullnodes has been deprecated"` as of 14 August 2026. A client on the
old transport does not degrade — it stops.

## Configuration

No defaults. The live mainnet ids are in `sui-contracts/deploy/mainnet.json` in the public
repository; set each variable explicitly. An unset variable makes `loadConfig` return a failure
naming it, rather than resolving to a deployment nobody chose.

## Money

Integers in the coin's smallest unit, `bigint` throughout. Parse user input with `parseAmount`,
which does string manipulation and never constructs a float — `parseFloat('0.1') * 1e9` is
`100000000.00000001`. Decimals come from `readDecimals` (i.e. `CoinMetadata`) and are never
assumed; assuming 9 for a 6-decimal coin is wrong by a factor of a thousand.

## Tests

| Command | What it covers |
|---|---|
| `pnpm test` | Unit tests, no network. Run it against this tree for the current count. |
| `pnpm test:chain` | Tests against the live mainnet deployment. Run it against this tree for the current count. |
| `pnpm typecheck` | `tsc --noEmit`, strict, `noUncheckedIndexedAccess`. |

`test/drift.test.ts` is the one to understand. It reads the `.move` sources directly and asserts
every mirrored value against them — fee ceilings, abort codes, entry-point names, and the
**BCS field order** of `Platform`. That last one matters most: gRPC returns object contents as raw
BCS, which is positional and carries no field names, so swapping two `u64`s in the Move struct
would leave the decoder happily returning the fee as the referral share. Nothing else would notice.

Both drift guards have been mutation-tested: the struct was reordered on purpose, the tests were
watched failing, and the source restored and verified byte-identical.
