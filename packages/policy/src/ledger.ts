// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * What the agent has already spent.
 *
 * # A ceiling without a memory is not a ceiling
 *
 * A per-transaction limit stops one large payment and does nothing at all about a thousand small
 * ones. An agent driven by text somebody else wrote is not limited to a single attempt, and the
 * cheapest attack on a per-transaction cap is a loop. So the ceilings in this package are
 * *cumulative over a window*, which means an evaluation needs to know what came before it.
 *
 * # This package does not remember anything, and that is on purpose
 *
 * `LedgerState` is an **input**. This package performs no I/O, holds no state between calls and
 * reads no clock — `nowMs` is passed in. Three things follow, and each is worth the awkwardness:
 *
 *  1. An evaluation is a pure function of its arguments, so a decision recorded in an audit trail
 *     can be replayed years later and must reach the same verdict. A rule that read
 *     `Date.now()` internally could not be replayed at all.
 *  2. Where spend is persisted — a file, Postgres, a Sui object — is a decision with consequences
 *     this package cannot see. A library that picked one would have picked it for every
 *     deployment that ever used it.
 *  3. Tests set time exactly, so window-boundary behaviour is asserted rather than hoped for.
 *
 * # The honest limitation, stated here rather than in a release note
 *
 * The ledger is only as good as the caller's record-keeping. If a caller signs a transaction and
 * fails to record the spend, the next evaluation sees a smaller total and permits more than the
 * ceiling. **The chain-level bound described in `README.md` — funding the input coin at the
 * ceiling so `creator::take_price` physically cannot take more — does not depend on this ledger
 * and does not fail with it.** That is the whole reason there are two bounds and why they must
 * stay independent.
 */

/** One recorded outflow. Written by the caller after a signature is produced. */
export interface LedgerEntry {
  /** Fully-qualified coin type. Normalised at comparison time. */
  readonly coinType: string;
  /** Positive magnitude of what left the agent, as an unsigned decimal string. */
  readonly amountOut: string;
  /** When it left, in epoch milliseconds. */
  readonly atMs: number;
}

export interface LedgerState {
  /**
   * The current time, supplied by the caller.
   *
   * An input rather than a read, so an evaluation is reproducible. See this file's header.
   */
  readonly nowMs: number;
  /**
   * Prior outflows. Order does not matter; entries outside every window are simply ignored.
   *
   * A caller may prune old entries freely — anything older than the widest configured period can
   * no longer affect a decision.
   */
  readonly spend: readonly LedgerEntry[];
}

/** An empty ledger. Named, so a test or a first run says what it means. */
export const EMPTY_LEDGER: LedgerState = { nowMs: 0, spend: [] };
