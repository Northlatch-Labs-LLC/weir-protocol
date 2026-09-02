// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The fee arithmetic, mirrored from Move.
 *
 * # This is a copy, and a copy is a liability
 *
 * These two functions restate `projectx_social::creator::compute_split` and
 * `projectx_social::stake_vault::compute_yield_split` in TypeScript, because a UI has to show a
 * breakdown before anyone signs and cannot call into Move to do it.
 *
 * A mirrored constant is silent when it goes stale. So `test/split.test.ts` asserts these against
 * the exact cases the Move suite asserts, and `test/drift.chain.test.ts` goes further: it calls
 * the **published mainnet package** through a simulated transaction and compares its answer with
 * this file's, at a spread of inputs. If Move changes and this does not, that test fails.
 *
 * # The order of operations is load-bearing
 *
 * Multiply first, then floor-divide. Dividing first loses the remainder and disagrees with the
 * contract at the last unit — enough to make an exact-amount check abort on chain while the UI
 * showed a number that looked right.
 *
 * Everything is `bigint`. `Number` silently loses precision above 2^53, which for a 6-decimal coin
 * is around 9 billion units — reachable, and it fails only for large balances, which is the worst
 * possible failure schedule.
 */

/** Basis-point denominator. Mirrors `BPS_DENOMINATOR` in every Move module here. */
export const BPS_DENOMINATOR = 10_000n;

/** Mirrors `platform::MAX_PLATFORM_FEE_BPS`. Asserted against chain in the drift test. */
export const MAX_PLATFORM_FEE_BPS = 3_000n;

/** Mirrors `platform::MAX_REFERRAL_SHARE_BPS`. */
export const MAX_REFERRAL_SHARE_BPS = 5_000n;

export interface PaymentSplit {
  /** What the creator receives. */
  creator: bigint;
  /** What the platform receives, after any referral is carved out of its cut. */
  platform: bigint;
  /** What the referrer receives. Zero when there is no referrer. */
  referrer: bigint;
}

/**
 * Divide a payment three ways.
 *
 * Mirrors, verbatim:
 * ```move
 * public fun compute_split(
 *     gross: u64, fee_bps: u64, referral_share_bps: u64, has_referrer: bool,
 * ): (u64, u64, u64)
 * ```
 *
 * `hasReferrer` is a parameter rather than something the caller applies afterwards. When there is
 * no referrer the referral share stays with the **platform** — it was carved out of the platform's
 * cut in the first place. Getting this wrong conserves value perfectly while paying the wrong
 * party, which is exactly how it survived a first draft of the Move code.
 *
 * Invariant, exact at every input: `creator + platform + referrer === gross`.
 */
export function computeSplit(
  gross: bigint,
  feeBps: bigint,
  referralShareBps: bigint,
  hasReferrer: boolean,
): PaymentSplit {
  assertNonNegative(gross, 'gross');
  assertNonNegative(feeBps, 'feeBps');
  assertNonNegative(referralShareBps, 'referralShareBps');

  const platformFee = (gross * feeBps) / BPS_DENOMINATOR;
  const referrer = hasReferrer ? (platformFee * referralShareBps) / BPS_DENOMINATOR : 0n;

  return {
    creator: gross - platformFee,
    platform: platformFee - referrer,
    referrer,
  };
}

export interface YieldSplit {
  creator: bigint;
  platform: bigint;
  /** Returned to depositors as the creator's chosen perk. */
  rebate: bigint;
}

/**
 * Divide harvested staking yield three ways.
 *
 * Mirrors, verbatim:
 * ```move
 * public fun compute_yield_split(gross: u64, fee_bps: u64, rebate_bps: u64): (u64, u64, u64)
 * ```
 *
 * Note the order differs from {@link computeSplit} and the difference is deliberate: the platform's
 * cut comes off the gross first, then the rebate is carved from **what remains to the creator**.
 * A creator setting a 100% rebate gives away all of their own yield and none of the platform's,
 * which is the only reading under which "the creator chooses the perk" is true.
 *
 * Invariant, exact at every input: `creator + platform + rebate === gross`.
 */
export function computeYieldSplit(gross: bigint, feeBps: bigint, rebateBps: bigint): YieldSplit {
  assertNonNegative(gross, 'gross');
  assertNonNegative(feeBps, 'feeBps');
  assertNonNegative(rebateBps, 'rebateBps');

  const platform = (gross * feeBps) / BPS_DENOMINATOR;
  const afterFee = gross - platform;
  const rebate = (afterFee * rebateBps) / BPS_DENOMINATOR;

  return { creator: afterFee - rebate, platform, rebate };
}

/**
 * Guard against negative inputs.
 *
 * The Move side takes `u64` and cannot represent a negative, so a negative here means the caller
 * has already made an arithmetic mistake upstream. Failing loudly beats producing a split that
 * conserves to a nonsense total.
 */
function assertNonNegative(value: bigint, name: string): void {
  if (value < 0n) throw new RangeError(`${name} must not be negative, got ${value}`);
}
