// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Reading the amounts a policy compares.
 *
 * # Why every amount here is a `bigint` and every parse can fail
 *
 * A Sui `u64` reaches its maximum at 18_446_744_073_709_551_615. `Number.MAX_SAFE_INTEGER` is
 * 9_007_199_254_740_991 — a little over two thousand times smaller. A balance change of
 * 10_000_000_000_000_001 MIST parsed as a `number` becomes 10_000_000_000_000_000, and a ceiling
 * of exactly that value then passes a transaction that should have been refused. The gap is not
 * hypothetical: it is one MIST wide at the boundary and grows from there.
 *
 * The node reports amounts as **decimal strings**, measured live on mainnet 2026-08-31:
 *
 * ```json
 * {"coinType":"0x00…02::sui::SUI","address":"0xda78…15d","amount":"-1088000"}
 * ```
 *
 * A leading `-` means the address lost value. That sign is the entire outflow signal, so the
 * parser must be exact about it and must never, under any input, return `0`.
 *
 * # `BigInt("")` is `0n`, and that is the bug this file is built around
 *
 * `BigInt('')`, `BigInt(' ')` and `BigInt('0x10')` all succeed and none of them mean what a
 * reader expects. An empty amount silently becoming a zero outflow is a transaction that spends
 * and reports that it did not. So the shape is checked with a regular expression **before**
 * `BigInt` is ever called, and a rejected string returns `null` — never a default.
 */

/**
 * One canonical decimal integer, optionally negative. No hex, no whitespace, no leading zeros.
 *
 * `-0` is refused, and the sign sits inside the alternation to make that so. Zero has exactly one
 * spelling here, because two spellings of the same value would make canonical comparison — and
 * therefore the policy hash in every audit entry — ambiguous for no gain.
 */
const SIGNED_INTEGER = /^(0|-?[1-9][0-9]*)$/;

/** An unsigned decimal integer. Ceilings and gas budgets can never be negative. */
const UNSIGNED_INTEGER = /^(0|[1-9][0-9]*)$/;

/**
 * Parse a signed decimal amount as reported by a simulation.
 *
 * Returns `null` for an empty string, whitespace, hex, a float, `+1`, `-0` written as `-0`
 * (rejected: two spellings of zero would make canonical comparison ambiguous), thousands
 * separators, or anything else that is not exactly one canonical decimal integer.
 */
export function parseSignedAmount(value: string): bigint | null {
  if (!SIGNED_INTEGER.test(value)) return null;
  return BigInt(value);
}

/**
 * Parse an unsigned decimal amount as written in a policy document.
 *
 * A negative ceiling is not a small ceiling; it is a typo, and a typo that parsed would make
 * every comparison against it fail closed for reasons no operator could see in the file.
 */
export function parseUnsignedAmount(value: string): bigint | null {
  if (!UNSIGNED_INTEGER.test(value)) return null;
  return BigInt(value);
}

/**
 * The magnitude of an outflow, or `null` when the change is not an outflow.
 *
 * Zero is not an outflow. A `+` change is not an outflow. Only a strictly negative amount is, and
 * its magnitude is returned as a positive `bigint` so every ceiling comparison in this package is
 * between two positive numbers and no rule has to reason about signs a second time.
 */
export function outflowMagnitude(amount: bigint): bigint | null {
  return amount < 0n ? -amount : null;
}
