// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Money: integers in the coin's smallest unit, always.
 *
 * # Two rules, both learned expensively elsewhere
 *
 * **Never `Number`.** `Number` loses precision above 2^53. For a 6-decimal coin that is around
 * 9 billion units; for a 9-decimal one, around 9 million. It fails only for large balances, which
 * is the worst possible schedule: everything works until the amounts matter.
 *
 * **Never `parseFloat(x) * 1e9`.** `parseFloat('0.1') * 1e9` is `100000000.00000001`. Decimal
 * strings are parsed by string manipulation here, digit by digit, so no binary float ever touches
 * a user's amount.
 *
 * # Decimals are read, never assumed
 *
 * Nothing in this file has a default `decimals`. The caller must pass the value read from
 * `CoinMetadata` — see `reads.ts`. Assuming 9 for a 6-decimal coin is wrong by a factor of a
 * thousand, in the direction nobody checks. The contracts themselves never read decimals at all,
 * because the split is proportional and therefore exact at any scale; decimals matter only for
 * display and for parsing what a human typed.
 */

/** A quantity of a coin, in its smallest unit, with the scale it was measured at. */
export interface Amount {
  /** Smallest units. For USDC at 6 decimals, `1_500_000n` is 1.5 USDC. */
  units: bigint;
  /** Decimals, as read from `CoinMetadata`. Never defaulted. */
  decimals: number;
}

export function amount(units: bigint, decimals: number): Amount {
  assertDecimals(decimals);
  return { units, decimals };
}

/**
 * Parse a human decimal string into smallest units.
 *
 * Accepts `"1.5"`, `"0.000001"`, `"12"`, `" 3.10 "`. Rejects anything else — including
 * exponent notation, which is a common way for a form to hand over a number that means something
 * other than what the user typed.
 *
 * Rejects excess precision rather than rounding it away. `parseAmount('0.1234567', 6)` throws
 * instead of silently becoming `0.123456`, because a user who typed a seventh digit meant it, and
 * quietly discarding it is how an amount ends up not matching an exact-price check on chain.
 */
export function parseAmount(input: string, decimals: number): Amount {
  assertDecimals(decimals);

  const text = input.trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new RangeError(
      `"${input}" is not a plain decimal number. Use digits and at most one point, ` +
        `without a sign, exponent, or separators.`,
    );
  }

  const pointIndex = text.indexOf('.');
  const whole = pointIndex === -1 ? text : text.slice(0, pointIndex);
  const fraction = pointIndex === -1 ? '' : text.slice(pointIndex + 1);

  if (fraction.length > decimals) {
    throw new RangeError(
      `"${input}" has ${fraction.length} decimal places but this coin has ${decimals}. ` +
        `Refusing to round: the extra digits would be silently discarded.`,
    );
  }

  // String padding rather than multiplication — no float is ever constructed.
  const padded = fraction.padEnd(decimals, '0');
  return { units: BigInt(whole + padded), decimals };
}

/**
 * Render smallest units as a decimal string.
 *
 * Exact. Trailing zeros in the fraction are trimmed, and a whole amount renders without a point.
 */
export function formatAmount(value: Amount, options?: { trimTrailingZeros?: boolean }): string {
  const trim = options?.trimTrailingZeros ?? true;
  const { units, decimals } = value;

  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(decimals + 1, '0');

  const whole = digits.slice(0, digits.length - decimals);
  let fraction = decimals === 0 ? '' : digits.slice(digits.length - decimals);

  if (trim) fraction = fraction.replace(/0+$/, '');

  const sign = negative ? '-' : '';
  return fraction.length > 0 ? `${sign}${whole}.${fraction}` : `${sign}${whole}`;
}

/** MIST per SUI. SUI is 9 decimals — the one place a decimal count is a protocol constant. */
export const MIST_PER_SUI = 1_000_000_000n;

export const SUI_DECIMALS = 9;

/** Parse a SUI amount. Safe to hardcode 9 here because SUI's decimals are fixed by the chain. */
export function parseSui(input: string): Amount {
  return parseAmount(input, SUI_DECIMALS);
}

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) {
    throw new RangeError(
      `decimals must be an integer in 0..38, got ${decimals}. ` +
        `Read it from CoinMetadata rather than assuming a common value.`,
    );
  }
}
