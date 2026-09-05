// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Money parsing and formatting.
 *
 * The cases that matter are the ones a float implementation gets wrong. `parseFloat('0.1') * 1e9`
 * is `100000000.00000001`, and `Number(9007199254740993n)` is `9007199254740992`. Both are pinned
 * below so a future "simplification" to `Number` fails loudly rather than at scale.
 */

import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount, parseSui } from '../src/money.js';

describe('parseAmount', () => {
  it('parses whole and fractional amounts at 6 decimals', () => {
    expect(parseAmount('1', 6).units).toBe(1_000_000n);
    expect(parseAmount('1.5', 6).units).toBe(1_500_000n);
    expect(parseAmount('0.000001', 6).units).toBe(1n);
    expect(parseAmount('0', 6).units).toBe(0n);
    expect(parseAmount('  3.10  ', 6).units).toBe(3_100_000n);
  });

  it('parses 0.1 exactly', () => {
    // The canonical float failure. parseFloat('0.1') * 1e9 === 100000000.00000001
    expect(parseSui('0.1').units).toBe(100_000_000n);
    expect(parseSui('0.3').units).toBe(300_000_000n);
    // 0.1 + 0.2 !== 0.3 in binary float; exact here.
    expect(parseSui('0.1').units + parseSui('0.2').units).toBe(parseSui('0.3').units);
  });

  it('keeps precision far above 2^53', () => {
    // Number would round this to ...992.
    expect(parseAmount('9007199254.740993', 6).units).toBe(9_007_199_254_740_993n);
  });

  it('refuses excess precision rather than rounding it away', () => {
    // A user who typed a seventh digit meant it. Silently discarding it is how an amount stops
    // matching an exact-price check on chain.
    expect(() => parseAmount('0.1234567', 6)).toThrow(/decimal places/);
  });

  it('accepts exactly the coin’s precision', () => {
    expect(parseAmount('0.123456', 6).units).toBe(123_456n);
  });

  it('rejects anything that is not a plain decimal', () => {
    for (const bad of ['1e9', '-1', '1,000', '0x10', '', 'abc', '1.2.3', '+1', 'Infinity', 'NaN']) {
      expect(() => parseAmount(bad, 6), `"${bad}" should be rejected`).toThrow(RangeError);
    }
  });

  it('refuses an implausible decimals value instead of guessing', () => {
    expect(() => parseAmount('1', -1)).toThrow(RangeError);
    expect(() => parseAmount('1', 1.5)).toThrow(RangeError);
    expect(() => parseAmount('1', 39)).toThrow(RangeError);
  });
});

describe('formatAmount', () => {
  it('round-trips through parse', () => {
    for (const text of ['1', '1.5', '0.000001', '1234.5678', '0']) {
      const parsed = parseAmount(text, 6);
      expect(formatAmount(parsed)).toBe(Number(text).toString() === text ? text : formatAmount(parsed));
      expect(parseAmount(formatAmount(parsed), 6).units).toBe(parsed.units);
    }
  });

  it('renders smallest units exactly', () => {
    expect(formatAmount({ units: 1_500_000n, decimals: 6 })).toBe('1.5');
    expect(formatAmount({ units: 1n, decimals: 6 })).toBe('0.000001');
    expect(formatAmount({ units: 1_000_000n, decimals: 6 })).toBe('1');
    expect(formatAmount({ units: 0n, decimals: 6 })).toBe('0');
  });

  it('keeps trailing zeros when asked', () => {
    expect(formatAmount({ units: 1_500_000n, decimals: 6 }, { trimTrailingZeros: false })).toBe(
      '1.500000',
    );
  });

  it('handles a zero-decimal coin', () => {
    expect(formatAmount({ units: 42n, decimals: 0 })).toBe('42');
    expect(parseAmount('42', 0).units).toBe(42n);
  });

  it('renders a large balance without precision loss', () => {
    expect(formatAmount({ units: 9_007_199_254_740_993n, decimals: 6 })).toBe('9007199254.740993');
  });
});
