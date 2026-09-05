// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The amount parser, and the two traps it exists for.
 *
 * `BigInt('')` is `0n` and `Number` loses precision above 2^53. Both turn a spend into a
 * non-spend, silently, in the direction nobody checks.
 */

import { describe, expect, it } from 'vitest';
import { outflowMagnitude, parseSignedAmount, parseUnsignedAmount } from '../src/index.js';

describe('parseSignedAmount', () => {
  it('reads the exact shape a live mainnet simulation produced', () => {
    expect(parseSignedAmount('-1088000')).toBe(-1_088_000n);
  });

  it('refuses the strings BigInt would silently accept', () => {
    // Every one of these is `0n`, `16n` or a throw under a bare `BigInt(...)` call, and none of
    // them is an amount.
    for (const bad of ['', ' ', '\n', '0x10', '1_000', '+1', '1.0', '1e3', '-0', '00', ' 1']) {
      expect(parseSignedAmount(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('is exact above Number.MAX_SAFE_INTEGER, where a number parse is not', () => {
    const overSafe = '10000000000000001';
    expect(parseSignedAmount(overSafe)).toBe(10_000_000_000_000_001n);
    // The defect this guards: the same value through a float loses the final digit.
    expect(BigInt(Number(overSafe))).not.toBe(10_000_000_000_000_001n);
  });

  it('reads the full u64 range', () => {
    expect(parseSignedAmount('18446744073709551615')).toBe(18_446_744_073_709_551_615n);
  });
});

describe('parseUnsignedAmount', () => {
  it('refuses a negative ceiling, which is a typo rather than a small ceiling', () => {
    expect(parseUnsignedAmount('-1')).toBeNull();
    expect(parseUnsignedAmount('0')).toBe(0n);
  });
});

describe('outflowMagnitude', () => {
  it('treats only a strictly negative change as an outflow', () => {
    expect(outflowMagnitude(-5n)).toBe(5n);
    expect(outflowMagnitude(0n)).toBeNull();
    expect(outflowMagnitude(5n)).toBeNull();
  });
});
