// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// The staking ladder: how principal is delegated so that yield lands *every* epoch.
///
/// # Provenance — this is a deliberate fork, not original work
///
/// A copy is only safe if something fails when the original moves.
/// `scripts/check-ladder-drift.sh` compares this file's policy constants and the bodies of
/// `is_matured`, `staked_this_epoch` and `rung_size` against the source tree and fails if they
/// diverge. **If you change the rules here, change them there, or the check will tell you.**
///
/// # The defect this module exists to prevent
///
/// Two protocols have shipped a staking path that realised exactly zero, for two different
/// reasons that look identical from outside — a gross yield of 0 on every harvest.
///
/// **Withdrawing too early.** Sui values a withdrawal at the exchange rate of
/// `stake_activation_epoch` against the rate at the withdrawal epoch. Withdraw during the
/// activation epoch and those are the same number, so the reward is exactly zero. A pool that
/// unstakes and restakes every epoch earns nothing, for ever, while looking busy.
///
/// **A ladder that is not laddered.** This one survived the first fix and is why this module
/// exists. `projectx::usdc_prize_factory` on mainnet holds eight tranches, **seven sharing
/// activation epoch 1209**, because nine harvests ran inside a single Sui epoch and Sui stamps
/// `activation = current + 1` on every stake. They matured together, restaked as one lump, and
/// the pool yielded once every `LADDER_DEPTH + 1` epochs instead of every epoch. Twenty-two
/// consecutive harvests read zero. Nothing in that contract staggered the tranches — the
/// staggering was assumed to emerge from deposit flow, and on chain it did not.
///
/// # The mechanism
///
/// The ladder holds `RUNGS = LADDER_DEPTH + 1` tranches, each activated one epoch apart. Every
/// epoch exactly one rung matures, is withdrawn with its rewards, and is restaked into the rung it
/// vacated. Two rules produce and preserve that shape, both enforced here rather than left to a
/// caller:
///
/// 1. **At most one rung is staked per epoch.** Without this the ladder collapses into a lump the
///    first time anything stakes twice in one epoch — and staking is permissionless, so "anything"
///    includes a griefer with a gas budget.
/// 2. **A tranche is withdrawn only after `LADDER_DEPTH` complete epochs**, never before.
///
/// # What depth costs and buys
///
/// Withdrawn principal returns to the liquid balance and its replacement activates at
/// `current + 1`, so one epoch of every cycle is idle. Holding `D` epochs out of every `D + 1`
/// captures `D/(D+1)` of achievable yield. Depth 1 captures 50%; depth 6 captures 85.7%. That was
/// measured, not assumed: two identical stakes over 14 epochs, and depth 1 realised 43% less from
/// the same capital at identical per-epoch rates. The cost of depth is liquidity — one rung,
/// `1/(D+1)` of staked principal, returns to the buffer each epoch.
module projectx_social::stake_ladder;

use sui::balance::{Self, Balance};
use sui::coin;
use sui::sui::SUI;
use sui_system::staking_pool::StakedSui;
use sui_system::sui_system::{Self, SuiSystemState};

/// Complete epochs a tranche is held before withdrawal.
///
/// Six matches the depth the live V1.0.1 pool was configured with, so the mechanism ports without
/// re-arguing the trade-off. It captures 85.7% of achievable yield and returns 1/7 of staked
/// principal to the buffer every epoch. **A design parameter, not a derived one** — and a compiled
/// constant, so changing it after deployment costs a package upgrade.
const LADDER_DEPTH: u64 = 6;

/// Rungs in a complete ladder: one maturing per epoch, plus the one being refilled.
const RUNGS: u64 = LADDER_DEPTH + 1;

/// Ceiling on concurrent tranches.
///
/// The harvest iterates these, so the cap bounds that transaction's gas. `RUNGS` is 7, leaving
/// headroom for the transient extra tranches a deposit surge creates while converging. At the cap
/// staking simply declines: the failure mode is idle principal earning nothing, never a harvest
/// too large to execute — which would be far worse, because the harvest is what seals the epoch.
const MAX_TRANCHES: u64 = 16;

/// Sui's own minimum for a single stake. Below this `request_add_stake` aborts.
const MIN_STAKE_MIST: u64 = 1_000_000_000; // 1 SUI

const BPS_DENOMINATOR: u64 = 10_000;

/// Sui returned less than the principal staked.
///
/// This cannot happen — an activated stake is always worth at least what went in, and an
/// unactivated one returns exactly its principal. Asserted anyway because the alternative to
/// aborting is a silent `u64` wrap crediting a phantom yield of ~1.8e19 MIST.
const EStakeAccountingViolation: u64 = 101;

/// The caller claimed more spendable balance than it holds.
const EAvailableExceedsLiquid: u64 = 102;

// === Policy ===

/// Whether a tranche has been held long enough to be worth withdrawing.
///
/// **Strictly `<=`, and load-bearing in both directions.** A tranche activated at epoch `A` has
/// crossed `LADDER_DEPTH` reward boundaries once the current epoch reaches `A + LADDER_DEPTH`.
/// Requiring `<` would hold every tranche an extra epoch and shift the whole ladder; requiring
/// `A < current` alone would withdraw after one epoch, which earns but at half the capture.
public fun is_matured(tranche: &StakedSui, current_epoch: u64): bool {
    tranche.stake_activation_epoch() + LADDER_DEPTH <= current_epoch
}

/// Whether a rung was already staked in this epoch.
///
/// **This is the guard that makes a ladder a ladder**, and it needs no stored state.
/// `request_add_stake` always stamps `activation = current + 1`, so a tranche whose activation lies
/// in the future was created during the epoch being asked about. If any exists, staking again now
/// would put two rungs on one activation epoch — precisely how the mainnet pool ended up with
/// seven tranches sharing epoch 1209.
///
/// Derived rather than stored, so it cannot drift out of agreement with the tranches it describes.
public fun staked_this_epoch(tranches: &vector<StakedSui>, current_epoch: u64): bool {
    let mut i = 0;
    while (i < tranches.length()) {
        if (tranches.borrow(i).stake_activation_epoch() > current_epoch) return true;
        i = i + 1;
    };
    false
}

/// How much to delegate in one epoch, given the total the vault wants staked.
///
/// An even `RUNGS`-way split, floored at Sui's minimum stake so a small vault degrades to fewer,
/// larger rungs rather than to no ladder at all.
public fun rung_size(target_staked: u64): u64 {
    let even = target_staked / RUNGS;
    if (even < MIN_STAKE_MIST) MIN_STAKE_MIST else even
}

/// The share of achievable yield this depth captures, in basis points.
///
/// Exposed so the trade-off is a number a caller can read rather than a comment to trust. At
/// `LADDER_DEPTH = 6` this is 8,571 — 85.71%.
public fun capture_bps(): u64 {
    LADDER_DEPTH * BPS_DENOMINATOR / RUNGS
}

// === Operations ===

/// Withdraw every matured tranche, returning principal and rewards together.
///
/// Returns `(proceeds, principal_returned)`. `proceeds` is principal **plus** yield in one balance;
/// the caller splits them using `principal_returned`, because only the caller knows where each half
/// belongs. Immature tranches are left staked and their order preserved — oldest first, which is
/// the order the ladder depends on.
///
/// In steady state exactly one tranche matures, so this performs one withdraw syscall rather than
/// draining the queue.
public(package) fun harvest_matured(
    tranches: &mut vector<StakedSui>,
    state: &mut SuiSystemState,
    ctx: &mut TxContext,
): (Balance<SUI>, u64) {
    let current_epoch = ctx.epoch();
    let mut proceeds = balance::zero<SUI>();
    let mut principal_returned = 0u64;
    let mut kept: vector<StakedSui> = vector[];

    while (!tranches.is_empty()) {
        let tranche = tranches.pop_back();

        if (!is_matured(&tranche, current_epoch)) {
            kept.push_back(tranche);
            continue
        };

        let principal = tranche.staked_sui_amount();
        let withdrawn = sui_system::request_withdraw_stake_non_entry(state, tranche, ctx);
        assert!(withdrawn.value() >= principal, EStakeAccountingViolation);

        principal_returned = principal_returned + principal;
        proceeds.join(withdrawn);
    };

    // Refill rather than assign: replacing the vector would have to drop the old one, and
    // `StakedSui` has no `drop`. Draining `kept` from the back undoes the reversal the first loop
    // introduced, so survivors return in their original order.
    while (!kept.is_empty()) {
        tranches.push_back(kept.pop_back());
    };
    kept.destroy_empty();

    (proceeds, principal_returned)
}

/// Delegate at most one rung, at most once per epoch.
///
/// Returns the amount actually staked, which is zero whenever staking would be wrong rather than
/// aborting — the caller decides whether zero is an error. Every gate fails closed:
///
/// * already staked this epoch → 0, because a second rung would share an activation epoch
/// * at the tranche cap → 0, leaving principal liquid and fully withdrawable
/// * below Sui's minimum stake → 0, because `request_add_stake` would abort
///
/// `available` is what the caller considers spendable — liquid principal above its buffer. It is
/// asserted against the balance rather than trusted, so a caller that miscomputes its buffer cannot
/// silently stake into it.
public(package) fun stake_one_rung(
    tranches: &mut vector<StakedSui>,
    state: &mut SuiSystemState,
    liquid: &mut Balance<SUI>,
    available: u64,
    target_staked: u64,
    validator: address,
    ctx: &mut TxContext,
): u64 {
    assert!(available <= liquid.value(), EAvailableExceedsLiquid);

    if (available < MIN_STAKE_MIST) return 0;
    if (tranches.length() >= MAX_TRANCHES) return 0;
    if (staked_this_epoch(tranches, ctx.epoch())) return 0;

    let rung = rung_size(target_staked);
    let amount = if (available < rung) available else rung;

    let coin_to_stake = coin::from_balance(liquid.split(amount), ctx);
    let staked = sui_system::request_add_stake_non_entry(state, coin_to_stake, validator, ctx);
    tranches.push_back(staked);

    amount
}

/// Force one tranche out of the ladder to raise liquidity, newest first.
///
/// **Added here; not present in the source module.** It exists to make the no-loss guarantee
/// unconditional. Without it a depositor whose withdrawal exceeds the buffer must wait for a rung
/// to mature, and "your principal is safe but you may wait a week" is a materially worse promise
/// than "your principal is available".
///
/// Newest first is the cheapest possible choice, and the reason is the same fact that causes the
/// zero-yield defect above: a tranche withdrawn in or near its activation epoch has accrued the
/// least, so unwinding the newest forfeits the least yield. Critically, **the forfeited yield is
/// the creator's, never the depositor's** — Sui returns the full principal of an unactivated stake,
/// so a depositor is made whole in every case. The cost of an emergency exit falls on the party
/// earning from the pool, which is the correct place for it.
///
/// Returns the principal freed, or zero if the ladder is empty.
public(package) fun unwind_newest(
    tranches: &mut vector<StakedSui>,
    state: &mut SuiSystemState,
    ctx: &mut TxContext,
): (Balance<SUI>, u64) {
    if (tranches.is_empty()) {
        return (balance::zero<SUI>(), 0)
    };

    let tranche = tranches.pop_back();
    let principal = tranche.staked_sui_amount();
    let withdrawn = sui_system::request_withdraw_stake_non_entry(state, tranche, ctx);
    assert!(withdrawn.value() >= principal, EStakeAccountingViolation);

    (withdrawn, principal)
}

// === Views ===

public fun ladder_depth(): u64 { LADDER_DEPTH }

public fun rungs(): u64 { RUNGS }

public fun max_tranches(): u64 { MAX_TRANCHES }

public fun min_stake_mist(): u64 { MIN_STAKE_MIST }

/// Whether the ladder is fully built — every rung occupied, one maturing per epoch from here.
public fun is_converged(tranches: &vector<StakedSui>): bool {
    tranches.length() == RUNGS
}

/// Total principal currently delegated across all tranches.
public fun staked_principal(tranches: &vector<StakedSui>): u64 {
    let mut total = 0;
    let mut i = 0;
    while (i < tranches.length()) {
        total = total + tranches.borrow(i).staked_sui_amount();
        i = i + 1;
    };
    total
}
