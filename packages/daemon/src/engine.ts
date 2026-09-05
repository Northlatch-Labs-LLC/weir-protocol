// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The tick engine: read every vault, decide, act on at most one step each, stop.
 *
 * # Bounded, always
 *
 * Every loop here has a hard ceiling that does not depend on a caller parameter. A sibling scanner
 * in this estate once issued 99,616 RPC calls against a budget of 12 because of an unbounded
 * `while (hasNextPage)`. When a ceiling stops us early the result is returned **flagged as
 * partial** — "that is all of them" and "we ran out of budget" imply opposite next actions, and
 * only one of them is safe to act on.
 *
 * # One step per vault per tick
 *
 * `harvest` withdraws matured tranches and stakes at most one rung. Calling it twice in a tick
 * cannot stake twice — the contract forbids two rungs in one epoch — so the second call would be a
 * successful transaction that changes nothing and costs gas. One step per tick keeps the cost
 * proportional to the work actually available.
 *
 * # Failures are per-vault
 *
 * One unreadable vault must not stop the others. Each is isolated, and the tick reports what it
 * did, what it skipped, and what it could not read — as three different things, because a vault
 * that failed to read is not a vault with nothing to do.
 */

import { fold, type Reading } from '@projectx-social/sdk';
import { decideHarvest, ladderCaptureBps, type HarvestDecision } from './domain/harvest.js';
import type { StakeVaultState } from './adapters/vault.js';

/** Hard ceiling on vaults processed in one tick. Not caller-supplied — see the header. */
export const MAX_VAULTS_PER_TICK = 200;

/** What the engine needs from the world. Ports, so the tick is testable with fixtures. */
export interface EnginePorts {
  /** Current Sui epoch, read from chain each tick rather than derived from wall-clock time. */
  readEpoch(): Promise<Reading<bigint>>;
  readVault(vaultId: string): Promise<Reading<StakeVaultState>>;
  /**
   * Simulate, then submit, a harvest. Returns the transaction digest.
   */
  simulateAndHarvest(vaultId: string): Promise<Reading<string>>;
}

export interface VaultOutcome {
  vaultId: string;
  decision: HarvestDecision;
  /** Present when a harvest was submitted. */
  digest?: string;
  /** Present when something could not be read or submitted. */
  error?: string;
  /** Ladder health, 0–10,000. Low and persistent means the ladder has collapsed. */
  captureBps?: number;
}

export interface TickResult {
  epoch: bigint;
  harvested: VaultOutcome[];
  skipped: VaultOutcome[];
  failed: VaultOutcome[];
  /** True when `MAX_VAULTS_PER_TICK` stopped us before the list was exhausted. */
  truncated: boolean;
}

/**
 * Run one tick.
 *
 * Returns a failure only when the epoch itself could not be read — without it no decision is
 * possible, and guessing the epoch would mean harvesting against a ladder position we invented.
 * Everything else is reported per vault.
 */
export async function tick(
  ports: EnginePorts,
  vaultIds: readonly string[],
): Promise<Reading<TickResult>> {
  const epochReading = await ports.readEpoch();
  if (!epochReading.ok) return epochReading;
  const epoch = epochReading.value;

  const truncated = vaultIds.length > MAX_VAULTS_PER_TICK;
  const batch = vaultIds.slice(0, MAX_VAULTS_PER_TICK);

  const harvested: VaultOutcome[] = [];
  const skipped: VaultOutcome[] = [];
  const failed: VaultOutcome[] = [];

  for (const vaultId of batch) {
    const vaultReading = await ports.readVault(vaultId);

    // `fold` requires both branches, so the failure path cannot be defaulted past into an empty
    // snapshot that would read as "nothing to do".
    const state = fold<StakeVaultState, StakeVaultState | null>(
      vaultReading,
      (value) => value,
      (failure) => {
        /*
          `unreadable`, not `empty-vault`.

          This branch is reached when the vault could not be READ. It used to record
          `empty-vault`, which is a measured fact — "the vault holds no principal at all" is what
          that reason means in `domain/harvest.ts` — about a vault nobody managed to measure.

          The two point opposite ways. An empty vault is the steady state and needs nobody. An
          unreadable one means the daemon is not seeing part of the estate, and anyone counting
          reasons to find out how much of it is being missed was reading those failures as vaults
          that were fine. The `error` field carried the truth the whole time; the field people
          aggregate on did not.
        */
        failed.push({
          vaultId,
          decision: { act: false, reason: 'unreadable' },
          error: `${failure.kind}: ${failure.detail}`,
        });
        return null;
      },
    );
    if (state === null) continue;

    const decision = decideHarvest(state, epoch);
    const captureBps = ladderCaptureBps(state);

    if (!decision.act) {
      skipped.push({ vaultId, decision, captureBps });
      continue;
    }

    const submitted = await ports.simulateAndHarvest(vaultId);
    fold(
      submitted,
      (digest) => harvested.push({ vaultId, decision, digest, captureBps }),
      (failure) =>
        failed.push({
          vaultId,
          decision,
          captureBps,
          error: `${failure.kind}: ${failure.detail}`,
        }),
    );
  }

  return {
    ok: true,
    value: { epoch, harvested, skipped, failed, truncated },
    observedAtMs: Date.now(),
  };
}
