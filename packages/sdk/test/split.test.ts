// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The TypeScript split, asserted against the same cases the Move suite asserts.
 *
 * These are deliberately the *same numbers* as `sui-contracts/tests/split_tests.move`, not
 * independently invented ones. Two implementations tested against two different sets of cases can
 * both pass while disagreeing; testing both against one set is what makes this a mirror check
 * rather than two separate opinions.
 */

import { describe, expect, it } from 'vitest';
import { computeSplit, computeYieldSplit } from '../src/split.js';

/** The property. Asserted for both referrer states everywhere, exactly as the Move helper does. */
function expectConserves(gross: bigint, feeBps: bigint, referralShareBps: bigint): void {
  const withRef = computeSplit(gross, feeBps, referralShareBps, true);
  expect(withRef.creator + withRef.platform + withRef.referrer).toBe(gross);

  const without = computeSplit(gross, feeBps, referralShareBps, false);
  expect(without.creator + without.platform + without.referrer).toBe(gross);

  // The creator is indifferent to referral — the half that conservation alone cannot catch.
  expect(withRef.creator).toBe(without.creator);
  expect(without.referrer).toBe(0n);
}

describe('computeSplit', () => {
  it('gives everything to the creator at a zero fee', () => {
    const s = computeSplit(1_000_000n, 0n, 0n, true);
    expect(s).toEqual({ creator: 1_000_000n, platform: 0n, referrer: 0n });
  });

  it('splits a zero gross into zeroes', () => {
    expect(computeSplit(0n, 3_000n, 5_000n, true)).toEqual({
      creator: 0n,
      platform: 0n,
      referrer: 0n,
    });
  });

  it('takes ten percent of a round number', () => {
    expect(computeSplit(1_000_000n, 1_000n, 0n, true)).toEqual({
      creator: 900_000n,
      platform: 100_000n,
      referrer: 0n,
    });
  });

  it('leaves an absent referrer’s share with the platform', () => {
    // The regression that mattered: paying it to the creator conserves value and is still wrong.
    const s = computeSplit(1_000_000n, 1_000n, 5_000n, false);
    expect(s).toEqual({ creator: 900_000n, platform: 100_000n, referrer: 0n });

    const referred = computeSplit(1_000_000n, 1_000n, 5_000n, true);
    expect(referred.creator).toBe(s.creator);
    expect(referred.platform).toBe(50_000n);
    expect(referred.referrer).toBe(50_000n);
    expect(referred.platform + referred.referrer).toBe(s.platform);
  });

  it('never loses a unit to rounding', () => {
    expect(computeSplit(1n, 3_000n, 5_000n, true)).toEqual({
      creator: 1n,
      platform: 0n,
      referrer: 0n,
    });
    expectConserves(1n, 3_000n, 5_000n);
  });

  it('conserves at awkward amounts', () => {
    expectConserves(7n, 333n, 777n);
    expectConserves(99n, 1n, 1n);
    expectConserves(101n, 2_999n, 4_999n);
    expectConserves(12_345_678n, 1_234n, 5_678n);
    expectConserves(3n, 9_999n, 9_999n);
    expectConserves(1n, 1n, 1n);
  });

  it('conserves across a sweep of amounts and rates', () => {
    for (let gross = 1n; gross < 100_000n; gross = gross * 3n + 1n) {
      for (let fee = 0n; fee <= 3_000n; fee += 371n) {
        expectConserves(gross, fee, 0n);
        expectConserves(gross, fee, 5_000n);
        expectConserves(gross, fee, 3_333n);
      }
    }
  });

  it('behaves at the maximum permitted rates', () => {
    expect(computeSplit(1_000_000n, 3_000n, 5_000n, true)).toEqual({
      creator: 700_000n,
      platform: 150_000n,
      referrer: 150_000n,
    });
  });

  it('does not overflow at large amounts', () => {
    // bigint has no ceiling, but this is the case a Number-based implementation gets wrong, so it
    // is pinned here as the regression that would catch a well-meaning "simplification".
    const big = 1_000_000_000_000_000_000n;
    expectConserves(big, 3_000n, 5_000n);
    expect(computeSplit(big, 3_000n, 5_000n, true)).toEqual({
      creator: 700_000_000_000_000_000n,
      platform: 150_000_000_000_000_000n,
      referrer: 150_000_000_000_000_000n,
    });
  });

  it('conserves at the largest u64', () => {
    const max = 18_446_744_073_709_551_615n;
    expectConserves(max, 3_000n, 5_000n);
    expectConserves(max, 1n, 1n);
  });

  it('refuses negative inputs rather than producing a nonsense split', () => {
    expect(() => computeSplit(-1n, 0n, 0n, false)).toThrow(RangeError);
    expect(() => computeSplit(1n, -1n, 0n, false)).toThrow(RangeError);
  });
});

describe('computeYieldSplit', () => {
  // 290 bps is the rate configured on mainnet.
  const FEE = 290n;

  it('gives the creator everything after the platform cut when there is no rebate', () => {
    expect(computeYieldSplit(1_000_000n, FEE, 0n)).toEqual({
      creator: 971_000n,
      platform: 29_000n,
      rebate: 0n,
    });
  });

  it('takes the rebate from the creator, never the platform', () => {
    const half = computeYieldSplit(1_000_000n, FEE, 5_000n);
    expect(half.platform).toBe(29_000n); // unchanged
    expect(half.rebate).toBe(485_500n);
    expect(half.creator).toBe(485_500n);

    const full = computeYieldSplit(1_000_000n, FEE, 10_000n);
    expect(full.creator).toBe(0n);
    expect(full.platform).toBe(29_000n); // still untouched at a 100% rebate
    expect(full.rebate).toBe(971_000n);
  });

  it('conserves across a sweep', () => {
    for (let gross = 1n; gross < 10_000_000n; gross = gross * 7n + 3n) {
      for (let rebate = 0n; rebate <= 10_000n; rebate += 1_111n) {
        const s = computeYieldSplit(gross, FEE, rebate);
        expect(s.creator + s.platform + s.rebate).toBe(gross);
      }
    }
  });
});
