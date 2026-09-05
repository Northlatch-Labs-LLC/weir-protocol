// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The harvest decision — a pure function of on-chain state plus the current epoch.
 *
 * # Why this is pure, and holds no memory between ticks
 *
 * `stake_vault::harvest` is **permissionless**: anyone may call it, and that is the protocol's
 * liveness guarantee. So between two of this daemon's ticks, a third party may already have
 * harvested. A driver that remembered "I harvested vault X at epoch N" would treat that as a
 * conflict; a driver that re-reads state each tick treats it as a non-event, which is what it is.
 *
 * The same property makes restarting mid-cycle always safe, and makes every decision here
 * testable without a chain, a clock, or a network.
 *
 * # The rule that actually saves money
 *
 * `harvest` does two things — withdraw matured tranches, and stake at most one rung — and
 * **neither aborts when it cannot act**. `stake_one_rung` returns 0 if a rung was already staked
 * this epoch, if the tranche cap is reached, or if the balance is below Sui's minimum stake.
 * `harvest_matured` simply withdraws nothing when nothing has matured.
 *
 * That means a pointless harvest is not a failed transaction — it is a **successful** one that
 * changes nothing and costs gas. On a daemon ticking continuously across many vaults, that cost
 * is unbounded and completely invisible in success metrics. The sibling Flash driver states the
 * same rule for aborts; this is its more dangerous cousin, because nothing goes red.
 *
 * So: never submit a harvest this function has not said is worthwhile.
 */

/** Mirrors `stake_ladder::LADDER_DEPTH`. Asserted against the Move source by the drift test. */
export const LADDER_DEPTH = 6n;

/** Mirrors `stake_ladder::MAX_TRANCHES`. */
export const MAX_TRANCHES = 16;

/** Mirrors `stake_ladder::MIN_STAKE_MIST` — Sui's own minimum for a single stake. */
export const MIN_STAKE_MIST = 1_000_000_000n;

/** One tranche of delegated principal, as read from the vault. */
export interface Tranche {
  /** The epoch this stake becomes active. Sui stamps `current + 1` at staking time. */
  activationEpoch: bigint;
  /** Principal delegated, in MIST. */
  principalMist: bigint;
}

/** Everything the decision needs. Deliberately a plain value — no client, no clock. */
export interface VaultSnapshot {
  vaultId: string;
  tranches: readonly Tranche[];
  /** Undelegated principal held by the vault, in MIST. */
  liquidMist: bigint;
  totalPrincipalMist: bigint;
}

export type HarvestReason =
  /** At least one tranche has matured and its yield is sitting unrealised. */
  | 'matured-tranche'
  /** Principal is idle and a rung may be staked this epoch. */
  | 'idle-principal'
  /** Both. The common steady-state case: one rung matures, and is immediately restaked. */
  | 'matured-and-idle';

export type SkipReason =
  /** Nothing matured, and a rung was already staked this epoch. The steady state between ticks. */
  | 'already-staked-this-epoch'
  /** Nothing matured, and there is less than Sui's minimum stake sitting idle. */
  | 'nothing-to-stake'
  /** Nothing matured, and the ladder is at its tranche ceiling. Principal stays liquid. */
  | 'tranche-cap-reached'
  /** The vault holds no principal at all. */
  | 'empty-vault'
  /**
   * The vault could not be read, so no decision was made about it at all.
   *
   * Distinct from `empty-vault` on purpose, and the distinction is the whole reason this member
   * exists. A read failure used to be journalled as `empty-vault` — a measured fact about a vault
   * nobody could measure. The two are opposite in what they should cause: an empty vault is the
   * steady state and needs nobody, an unreadable one means this daemon is not seeing part of the
   * estate and somebody should find out why. Aggregated by reason, the first buries the second.
   *
   * This reason never comes from `decideHarvest`, which cannot be reached without a state to
   * decide on. It is written by `engine.ts` for the vault whose read failed, alongside the real
   * error text.
   */
  | 'unreadable';

export type HarvestDecision =
  | { readonly act: true; readonly reason: HarvestReason }
  | { readonly act: false; readonly reason: SkipReason };

/**
 * Has this tranche been held long enough to be worth withdrawing?
 *
 * Mirrors, verbatim:
 * ```move
 * public fun is_matured(tranche: &StakedSui, current_epoch: u64): bool {
 *     tranche.stake_activation_epoch() + LADDER_DEPTH <= current_epoch
 * }
 * ```
 */
export function isMatured(tranche: Tranche, currentEpoch: bigint): boolean {
  return tranche.activationEpoch + LADDER_DEPTH <= currentEpoch;
}

/**
 * Was a rung already staked during this epoch?
 *
 * Mirrors `stake_ladder::staked_this_epoch`. `request_add_stake` always stamps
 * `activation = current + 1`, so a tranche whose activation lies in the future was created during
 * the epoch being asked about. Derived rather than remembered, so it cannot drift out of agreement
 * with the tranches it describes — and so a third party's stake is seen as readily as our own.
 */
export function stakedThisEpoch(
  tranches: readonly Tranche[],
  currentEpoch: bigint,
): boolean {
  return tranches.some((t) => t.activationEpoch > currentEpoch);
}

/**
 * Should this vault be harvested now?
 *
 * Returns a reason either way. A skip is not a non-event: "already staked this epoch" is healthy
 * steady state, while "tranche cap reached" means principal is sitting idle and someone should
 * look. Collapsing both into `false` throws that away.
 */
export function decideHarvest(
  snapshot: VaultSnapshot,
  currentEpoch: bigint,
): HarvestDecision {
  const hasMatured = snapshot.tranches.some((t) => isMatured(t, currentEpoch));

  // Checked before the staking gates so a matured tranche is always realised, even on a vault
  // that is at its tranche cap or has nothing new to stake.
  const canStake =
    !stakedThisEpoch(snapshot.tranches, currentEpoch) &&
    snapshot.tranches.length < MAX_TRANCHES &&
    snapshot.liquidMist >= MIN_STAKE_MIST;

  if (hasMatured && canStake) return { act: true, reason: 'matured-and-idle' };
  if (hasMatured) return { act: true, reason: 'matured-tranche' };
  if (canStake) return { act: true, reason: 'idle-principal' };

  // Nothing to do. Name *why*, most-actionable first.
  if (snapshot.totalPrincipalMist === 0n && snapshot.tranches.length === 0) {
    return { act: false, reason: 'empty-vault' };
  }
  if (snapshot.tranches.length >= MAX_TRANCHES) {
    return { act: false, reason: 'tranche-cap-reached' };
  }
  if (stakedThisEpoch(snapshot.tranches, currentEpoch)) {
    return { act: false, reason: 'already-staked-this-epoch' };
  }
  return { act: false, reason: 'nothing-to-stake' };
}

/**
 * The epoch at which this vault will next have something to do, if it is knowable.
 *
 * Used only to schedule the next look — never to decide. `null` means "nothing pending", which
 * for a vault holding staked principal should be impossible and is worth surfacing rather than
 * treating as "check again later".
 */
export function nextActionableEpoch(snapshot: VaultSnapshot): bigint | null {
  if (snapshot.tranches.length === 0) return null;

  let earliest: bigint | null = null;
  for (const tranche of snapshot.tranches) {
    const matures = tranche.activationEpoch + LADDER_DEPTH;
    if (earliest === null || matures < earliest) earliest = matures;
  }
  return earliest;
}

/**
 * Share of achievable yield the current ladder shape is capturing, in basis points.
 *
 * A converged ladder holds `LADDER_DEPTH + 1` tranches and captures `D/(D+1)` — 8,571 bps at
 * depth 6. A collapsed ladder holds one lump and yields once every seven epochs instead of every
 * epoch, which is the live-mainnet defect this whole design exists to prevent.
 *
 * Reported so a degraded ladder is **visible as a number** rather than inferred from a run of
 * unexpectedly small harvests. A ladder converges on its own within `RUNGS` epochs, so a low
 * value is only worth alarming on if it persists.
 */
export function ladderCaptureBps(snapshot: VaultSnapshot): number {
  const rungs = Number(LADDER_DEPTH) + 1;
  const occupied = Math.min(snapshot.tranches.length, rungs);
  if (occupied === 0) return 0;
  return Math.floor((occupied / rungs) * 10_000);
}
