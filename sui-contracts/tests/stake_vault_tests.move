// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// Tests for the stake leg, against a real `SuiSystemState` with real epoch advancement.
///
/// These are integration tests, not simulations. `governance_test_utils` stands up an actual
/// validator set, and `advance_epoch_with_reward_amounts` distributes actual staking rewards, so
/// yield here is produced by the same code path that produces it on mainnet. That matters more
/// than usual for this module: the two defects it is built to avoid — withdrawing inside the
/// activation epoch, and a ladder that silently collapses into a lump — both present as a yield of
/// exactly zero, and neither is visible to a test that mocks the staking layer.
#[test_only]
module projectx_social::stake_vault_tests;

use projectx_social::account::{Self, Registry, SocialAccount};
use projectx_social::platform::{Self, Platform, PlatformCap};
use projectx_social::stake_ladder as ladder;
use projectx_social::stake_vault::{Self as sv, StakeVault, StakeCap};
use sui::clock;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};
use sui_system::governance_test_utils as gtu;
use sui_system::sui_system::SuiSystemState;


const ADMIN: address = @0xAD;
const CREATOR: address = @0xC1;
const FAN: address = @0xFA;
const FAN2: address = @0xFB;
const VALIDATOR: address = @0x1001;

const SUI_1: u64 = 1_000_000_000;
/// The platform fee on yield, in bps — the rate chosen for deployment.
const FEE_BPS: u64 = 290;

// === Fixtures ===

fun setup(): Scenario {
    let mut sc = ts::begin(ADMIN);
    gtu::set_up_sui_system_state(vector[VALIDATOR]);

    sc.next_tx(ADMIN);
    {
        let ctx = sc.ctx();
        platform::init_for_testing(ctx);
        account::init_for_testing(ctx);
    };

    sc.next_tx(ADMIN);
    {
        let mut p = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_fees(&mut p, &cap, FEE_BPS, 0, 0);
        platform::set_creation_paused(&mut p, &cap, false);
        sc.return_to_sender(cap);
        ts::return_shared(p);
    };

    open_account(&mut sc, CREATOR, b"creator");
    open_account(&mut sc, FAN, b"fan");
    open_account(&mut sc, FAN2, b"fantwo");

    sc.next_tx(CREATOR);
    {
        let mut p = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();
        let cap = sv::open(&mut p, &acct, VALIDATOR, sc.ctx());
        transfer::public_transfer(cap, CREATOR);
        sc.return_to_sender(acct);
        ts::return_shared(p);
    };
    sc
}

fun open_account(sc: &mut Scenario, who: address, handle: vector<u8>) {
    sc.next_tx(who);
    let mut p = sc.take_shared<Platform>();
    let mut reg = sc.take_shared<Registry>();
    let clk = clock::create_for_testing(sc.ctx());
    account::open(&mut p, &mut reg, handle.to_string(), option::none(), &clk, sc.ctx());
    clock::destroy_for_testing(clk);
    ts::return_shared(p);
    ts::return_shared(reg);
}

fun deposit(sc: &mut Scenario, who: address, amount: u64) {
    sc.next_tx(who);
    let p = sc.take_shared<Platform>();
    let mut v = sc.take_shared<StakeVault>();
    let acct = sc.take_from_sender<SocialAccount>();
    let funds = coin::mint_for_testing<SUI>(amount, sc.ctx());
    sv::deposit(&p, &mut v, &acct, funds, sc.ctx());
    sc.return_to_sender(acct);
    ts::return_shared(v);
    ts::return_shared(p);
}

fun harvest(sc: &mut Scenario) {
    sc.next_tx(ADMIN); // permissionless — deliberately not the creator
    let mut v = sc.take_shared<StakeVault>();
    let mut state = sc.take_shared<SuiSystemState>();
    sv::harvest(&mut v, &mut state, sc.ctx());
    ts::return_shared(state);
    ts::return_shared(v);
}

/// Advance far enough that a tranche staked in the current epoch has matured.
///
/// Derived from `ladder_depth()` rather than written as 7, so a depth change moves every test with
/// it instead of leaving them asserting the wrong boundary.
fun advance_to_maturity(sc: &mut Scenario) {
    let mut i = 0;
    while (i <= ladder::ladder_depth()) {
        gtu::advance_epoch_with_reward_amounts(0, 400, sc);
        i = i + 1;
    };
}

// === The yield split, pure ===

#[test]
fun the_yield_split_conserves_and_takes_the_rebate_from_the_creator() {
    // No rebate: creator takes everything after the platform's 290 bps.
    let (c, p, r) = sv::compute_yield_split(1_000_000, FEE_BPS, 0);
    assert!(p == 29_000, 0);
    assert!(c == 971_000, 1);
    assert!(r == 0, 2);
    assert!(c + p + r == 1_000_000, 3);

    // Half rebate: the platform's cut is untouched; the creator's halves.
    let (c2, p2, r2) = sv::compute_yield_split(1_000_000, FEE_BPS, 5_000);
    assert!(p2 == 29_000, 4); // identical — the rebate is not taken from the platform
    assert!(r2 == 485_500, 5);
    assert!(c2 == 485_500, 6);
    assert!(c2 + p2 + r2 == 1_000_000, 7);

    // Full rebate: the creator gives away all of their own yield, and none of the platform's.
    let (c3, p3, r3) = sv::compute_yield_split(1_000_000, FEE_BPS, 10_000);
    assert!(c3 == 0, 8);
    assert!(p3 == 29_000, 9);
    assert!(r3 == 971_000, 10);
    assert!(c3 + p3 + r3 == 1_000_000, 11);
}

#[test]
fun the_yield_split_conserves_across_a_sweep() {
    let mut gross = 1;
    while (gross < 10_000_000) {
        let mut rebate = 0;
        while (rebate <= 10_000) {
            let (c, p, r) = sv::compute_yield_split(gross, FEE_BPS, rebate);
            assert!(c + p + r == gross, 0);
            rebate = rebate + 1_111;
        };
        gross = gross * 7 + 3;
    };
}

// === The regression that matters ===

#[test]
/// **Principal staked across a full ladder period must realise non-zero yield.**
///
/// This is the direct regression for the mainnet defect: a pool whose 22 consecutive harvests all
/// read zero because its tranches shared an activation epoch and matured as one lump. If this
/// asserts a positive number, the ladder is laddering.
fun a_matured_tranche_actually_yields() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 100 * SUI_1);

    harvest(&mut sc); // stakes the first rung
    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::tranche_count(&v) == 1, 0);
        assert!(sv::staked_principal(&v) > 0, 1);
        ts::return_shared(v);
    };

    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        // The whole point: yield is strictly positive.
        assert!(sv::lifetime_yield(&v) > 0, 2);
        assert!(sv::platform_yield_value(&v) > 0, 3);
        assert!(sv::creator_yield_value(&v) > 0, 4);
        // And principal is still fully backed.
        assert!(sv::is_solvent(&v), 5);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// Two stakes in one epoch would share an activation epoch and collapse the ladder. The guard
/// makes the second harvest a no-op for staking rather than a second rung.
fun the_ladder_stakes_at_most_one_rung_per_epoch() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 100 * SUI_1);

    harvest(&mut sc);
    harvest(&mut sc); // same epoch
    harvest(&mut sc); // still the same epoch

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::tranche_count(&v) == 1, 0);
        ts::return_shared(v);
    };

    // A new epoch permits exactly one more.
    gtu::advance_epoch_with_reward_amounts(0, 400, &mut sc);
    harvest(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::tranche_count(&v) == 2, 1);
        ts::return_shared(v);
    };

    sc.end();
}

// === The no-loss guarantee ===

#[test]
/// A depositor gets their whole principal back, even when every unit of it is staked and the
/// liquid buffer is empty. The vault unwinds tranches to make them whole immediately.
fun principal_is_returned_in_full_even_when_fully_staked() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 100 * SUI_1);

    // Build several rungs so principal is genuinely delegated.
    let mut i = 0;
    while (i < 4) {
        harvest(&mut sc);
        gtu::advance_epoch_with_reward_amounts(0, 400, &mut sc);
        i = i + 1;
    };

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::staked_principal(&v) > 0, 0);
        assert!(sv::liquid_value(&v) < 100 * SUI_1, 1); // buffer alone cannot cover it
        ts::return_shared(v);
    };

    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let mut state = sc.take_shared<SuiSystemState>();
        let acct = sc.take_from_sender<SocialAccount>();

        let out = sv::withdraw(&mut v, &acct, 100 * SUI_1, &mut state, sc.ctx());

        // Exactly what was deposited. Not less, and not after a waiting period.
        assert!(out.value() == 100 * SUI_1, 2);
        assert!(sv::total_principal(&v) == 0, 3);
        assert!(sv::principal_of(&v, FAN) == 0, 4);
        assert!(sv::is_solvent(&v), 5);

        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(state);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// The solvency invariant holds through a mixed sequence of deposits, harvests and withdrawals.
fun the_vault_stays_solvent_through_churn() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 50 * SUI_1);
    deposit(&mut sc, FAN2, 30 * SUI_1);

    let mut round = 0;
    while (round < 3) {
        harvest(&mut sc);
        gtu::advance_epoch_with_reward_amounts(0, 400, &mut sc);

        sc.next_tx(FAN);
        {
            let mut v = sc.take_shared<StakeVault>();
            let mut state = sc.take_shared<SuiSystemState>();
            let acct = sc.take_from_sender<SocialAccount>();
            let out = sv::withdraw(&mut v, &acct, 5 * SUI_1, &mut state, sc.ctx());
            assert!(out.value() == 5 * SUI_1, 0);
            assert!(sv::is_solvent(&v), 1);
            coin::burn_for_testing(out);
            sc.return_to_sender(acct);
            ts::return_shared(state);
            ts::return_shared(v);
        };

        deposit(&mut sc, FAN2, 10 * SUI_1);
        round = round + 1;
    };

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::is_solvent(&v), 2);
        assert!(sv::principal_of(&v, FAN) == 35 * SUI_1, 3);
        assert!(sv::principal_of(&v, FAN2) == 60 * SUI_1, 4);
        assert!(sv::total_principal(&v) == 95 * SUI_1, 5);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EInsufficientPrincipal)]
fun a_depositor_cannot_withdraw_more_than_they_deposited() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 10 * SUI_1);

    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let mut state = sc.take_shared<SuiSystemState>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::withdraw(&mut v, &acct, 10 * SUI_1 + 1, &mut state, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(state);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
/// Deposits can be closed; withdrawals and rebate claims cannot. Same asymmetry as the flow leg.
fun closing_deposits_does_not_close_withdrawals() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 10 * SUI_1);

    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        sv::set_accepting(&mut v, &cap, false);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let mut state = sc.take_shared<SuiSystemState>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::withdraw(&mut v, &acct, 10 * SUI_1, &mut state, sc.ctx());
        assert!(out.value() == 10 * SUI_1, 0);
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(state);
        ts::return_shared(v);
    };
    sc.end();
}

// === The rebate ===

#[test]
/// Rebate accrues pro rata to principal, and only to deposits present when it was earned.
fun the_rebate_is_shared_in_proportion_to_principal() {
    let mut sc = setup();

    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        sv::set_rebate_bps(&mut v, &cap, 10_000); // creator gives away all of their yield
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    // 75 / 25 split of the pool.
    deposit(&mut sc, FAN, 75 * SUI_1);
    deposit(&mut sc, FAN2, 25 * SUI_1);

    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::rebate_pool_value(&v) > 0, 0);
        // The creator kept nothing, having set a 100% rebate.
        assert!(sv::creator_yield_value(&v) == 0, 1);

        let a = sv::claimable_rebate(&v, FAN);
        let b = sv::claimable_rebate(&v, FAN2);
        assert!(a > 0 && b > 0, 2);
        // 75:25. Compared as a ratio with a one-unit tolerance for floor division rather than as
        // an exact equality, because the accumulator floors twice.
        assert!(a >= b * 3 - 1 && a <= b * 3 + 1, 3);
        ts::return_shared(v);
    };

    // And it can actually be taken out.
    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let expected = sv::claimable_rebate(&v, FAN);
        let out = sv::claim_rebate(&mut v, &acct, sc.ctx());
        assert!(out.value() == expected, 4);
        assert!(sv::claimable_rebate(&v, FAN) == 0, 5);
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// A depositor who arrives after a harvest must not be paid a rebate they were not there to earn.
fun a_late_depositor_does_not_share_earlier_yield() {
    let mut sc = setup();

    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        sv::set_rebate_bps(&mut v, &cap, 10_000);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    deposit(&mut sc, FAN, 50 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc); // yield earned entirely by FAN

    deposit(&mut sc, FAN2, 50 * SUI_1); // arrives afterwards

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::claimable_rebate(&v, FAN) > 0, 0);
        assert!(sv::claimable_rebate(&v, FAN2) == 0, 1);
        ts::return_shared(v);
    };

    sc.end();
}

// === Claims ===

#[test]
fun the_creator_and_platform_can_take_their_yield() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 100 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    let creator_due;
    let platform_due;
    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        creator_due = sv::creator_yield_value(&v);
        platform_due = sv::platform_yield_value(&v);
        assert!(creator_due > 0 && platform_due > 0, 0);
        ts::return_shared(v);
    };

    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        let out = sv::claim_creator_yield(&mut v, &cap, creator_due, sc.ctx());
        assert!(out.value() == creator_due, 1);
        assert!(sv::creator_yield_value(&v) == 0, 2);
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    sc.next_tx(ADMIN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<PlatformCap>();
        let out = sv::claim_platform_yield(&mut v, &cap, platform_due, sc.ctx());
        assert!(out.value() == platform_due, 3);
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// Yield claims must never be able to reach principal. Both parties drain everything they are
/// owed; the depositor must still be able to take their full deposit afterwards.
fun draining_all_yield_cannot_touch_principal() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 100 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        let amt = sv::creator_yield_value(&v);
        let out = sv::claim_creator_yield(&mut v, &cap, amt, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.next_tx(ADMIN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<PlatformCap>();
        let amt = sv::platform_yield_value(&v);
        let out = sv::claim_platform_yield(&mut v, &cap, amt, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let mut state = sc.take_shared<SuiSystemState>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::withdraw(&mut v, &acct, 100 * SUI_1, &mut state, sc.ctx());
        assert!(out.value() == 100 * SUI_1, 0);
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(state);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EDepositTooSmall)]
fun a_dust_deposit_is_refused() {
    let mut sc = setup();
    deposit(&mut sc, FAN, sv::min_deposit_mist() - 1);
    sc.end();
}

/// The August 2026 audit finding: a deposit must not earn the harvest it walks into.
///
/// Before the fix the accumulator divided the rebate by *all* principal, so principal deposited
/// moments earlier — still sitting in `liquid`, never delegated, having earned nothing — took a
/// share proportional to its size. Deposit big, harvest, claim, withdraw, all in one transaction,
/// at no cost, every epoch. The money came out of the depositors the rebate exists to reward.
#[test]
fun a_deposit_does_not_earn_the_harvest_it_walks_into() {
    let mut sc = setup();

    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        sv::set_rebate_bps(&mut v, &cap, 10_000); // the attack is only armed when a rebate exists
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    // An honest depositor, staked and earning.
    deposit(&mut sc, FAN, 50 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);

    // The attacker arrives with ten times the honest stake, immediately before the harvest.
    deposit(&mut sc, FAN2, 500 * SUI_1);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        // The whole finding, in two lines.
        assert!(sv::claimable_rebate(&v, FAN2) == 0, 0);
        assert!(sv::claimable_rebate(&v, FAN) > 0, 1);
        ts::return_shared(v);
    };

    // And the fix must not confiscate — once the money has actually been delegated through a
    // harvest, it earns like anybody else's.
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::claimable_rebate(&v, FAN2) > 0, 2);
        ts::return_shared(v);
    };

    sc.end();
}

/// `StakeCap` has `store`, so it can be transferred, sold or lost — and `migrate` was the only
/// way to advance a vault's version. Since every entry point begins with `assert_version`,
/// including `withdraw`, a creator who loses their cap would strand their depositors' access to
/// their own principal the moment a new version shipped. `migrate_as_platform` is the second door.
///
/// It cannot be exercised at the current version, so this pins the gate the same way
/// `platform_tests` pins its own: calling it when there is nothing to migrate is a named refusal
/// rather than a silent no-op.
#[test]
#[expected_failure(abort_code = projectx_social::stake_vault::ENotUpgraded)]
fun the_platform_door_refuses_a_vault_already_at_version() {
    let mut sc = setup();
    sc.next_tx(ADMIN);
    let mut v = sc.take_shared<StakeVault>();
    let p = sc.take_shared<Platform>();
    let cap = sc.take_from_sender<PlatformCap>();
    sv::migrate_as_platform(&mut v, &p, &cap);
    sc.return_to_sender(cap);
    ts::return_shared(p);
    ts::return_shared(v);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::ERebateAboveMax)]
/// A rebate share above 100% of the creator's post-fee yield must be refused.
fun a_rebate_above_one_hundred_percent_is_refused() {
    let mut sc = setup();
    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        // 10_001 bps is above the 10_000 bps ceiling.
        sv::set_rebate_bps(&mut v, &cap, 10_001);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.end();
}

// === Adversarial sequences ===
//
// `a_deposit_does_not_earn_the_harvest_it_walks_into` proves the one known timing attack;
// these drive the class — adversarially timed sequences trying to beat an honest holder.

fun set_full_rebate(sc: &mut Scenario) {
    sc.next_tx(CREATOR);
    let mut v = sc.take_shared<StakeVault>();
    let cap = sc.take_from_sender<StakeCap>();
    sv::set_rebate_bps(&mut v, &cap, 10_000);
    sc.return_to_sender(cap);
    ts::return_shared(v);
}

fun withdraw_exact(sc: &mut Scenario, who: address, amount: u64) {
    sc.next_tx(who);
    let mut v = sc.take_shared<StakeVault>();
    let mut state = sc.take_shared<SuiSystemState>();
    let acct = sc.take_from_sender<SocialAccount>();
    let out = sv::withdraw(&mut v, &acct, amount, &mut state, sc.ctx());
    assert!(out.value() == amount, 99);
    coin::burn_for_testing(out);
    sc.return_to_sender(acct);
    ts::return_shared(state);
    ts::return_shared(v);
}

#[test]
/// Churning the same principal in and out around harvests must never out-earn holding it.
///
/// The holder commits once, before anyone else, and waits. The churner deposits the same
/// amount immediately before each harvest and withdraws immediately after, three cycles in a
/// row — the rational strategy if timing could beat commitment. Every epoch the churner is
/// present the holder is present too, and the holder is also there for the opening harvest the
/// churner missed, so the holder must end strictly ahead.
fun churning_around_harvests_beats_nobody() {
    let mut sc = setup();
    set_full_rebate(&mut sc);

    deposit(&mut sc, FAN, 100 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);                      // the holder's head start, earned alone

    let mut cycle = 0;
    while (cycle < 3) {
        deposit(&mut sc, FAN2, 100 * SUI_1);
        harvest(&mut sc);
        advance_to_maturity(&mut sc);
        harvest(&mut sc);
        withdraw_exact(&mut sc, FAN2, 100 * SUI_1);
        cycle = cycle + 1;
    };

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        let holder = sv::claimable_rebate(&v, FAN);
        let churner = sv::claimable_rebate(&v, FAN2);
        assert!(holder > 0, 0);
        assert!(churner < holder, 1);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
/// A second claim in the same state takes nothing. The guard is accounting, not an abort: the
/// first claim zeroes `pending`, so the second returns an empty coin rather than a double
/// payment — and the pool balance is untouched by the repeat.
fun a_second_claim_in_the_same_state_takes_nothing() {
    let mut sc = setup();
    set_full_rebate(&mut sc);
    deposit(&mut sc, FAN, 50 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let first = sv::claim_rebate(&mut v, &acct, sc.ctx());
        assert!(first.value() > 0, 0);
        let pool_after_first = sv::rebate_pool_value(&v);
        let second = sv::claim_rebate(&mut v, &acct, sc.ctx());
        assert!(second.value() == 0, 1);
        assert!(sv::rebate_pool_value(&v) == pool_after_first, 2);
        coin::burn_for_testing(first);
        coin::destroy_zero(second);
        sc.return_to_sender(acct);
        ts::return_shared(v);
    };
    sc.end();
}

// === Freshness markers must follow principal out ===
//
// `deposit` writes two markers — `Fresh{who}` and `FreshTotal` — recording money that arrived
// inside the current harvest window and has therefore not earned yet. Until 2026-09-01 `withdraw`
// reduced the principal and left both markers where they were, and the three tests below are the
// three ways that one omission was reachable. None of them needs an attacker; the first is what an
// ordinary depositor does by changing their mind.

/// Returns what came back, so a test can assert the amount rather than assume it —
/// `withdraw_exact` above asserts it internally and is used where that is all a test needs.
fun withdraw_returning(sc: &mut Scenario, who: address, amount: u64): u64 {
    sc.next_tx(who);
    let mut v = sc.take_shared<StakeVault>();
    let mut state = sc.take_shared<SuiSystemState>();
    let acct = sc.take_from_sender<SocialAccount>();
    let out = sv::withdraw(&mut v, &acct, amount, &mut state, sc.ctx());
    let got = out.value();
    coin::burn_for_testing(out);
    sc.return_to_sender(acct);
    ts::return_shared(state);
    ts::return_shared(v);
    got
}

#[test]
/// The one that costs a depositor their money.
///
/// Deposit, then take part of it back before the next harvest. The stale `Fresh` marker was folded
/// into `rebate_debt` at the next settle, and `accrue_on`'s `entitled - rebate_debt` then
/// underflowed. Every route out of a position runs that line — `deposit`, `withdraw` and
/// `claim_rebate` — so the remaining principal was unreachable from then on, permanently, with no
/// administrative rescue anywhere in the module.
fun a_partial_withdrawal_inside_one_window_does_not_strand_the_rest() {
    let mut sc = setup();
    set_full_rebate(&mut sc);

    // Somebody else earning, so the accumulator actually moves. With a single depositor it stays
    // at zero and the defect is not armed — which is why it survived the original suite.
    deposit(&mut sc, FAN2, 100 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::claimable_rebate(&v, FAN2) > 0, 0); // the precondition is real
        ts::return_shared(v);
    };

    // Deposit and change your mind, inside the same window.
    deposit(&mut sc, FAN, 50 * SUI_1);
    assert!(withdraw_returning(&mut sc, FAN, 10 * SUI_1) == 10 * SUI_1, 1);

    // The marker must have come down with the principal: 90 SUI is FAN2's 100 minus FAN's 40 fresh
    // — FAN's remaining 40 all arrived this window and none of it is eligible yet.
    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::principal_of(&v, FAN) == 40 * SUI_1, 2);
        assert!(sv::eligible_total(&v) == 100 * SUI_1, 3);
        ts::return_shared(v);
    };

    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    // The line under test. Before the fix this aborted with an arithmetic error and every retry
    // aborted the same way.
    assert!(withdraw_returning(&mut sc, FAN, 40 * SUI_1) == 40 * SUI_1, 4);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::principal_of(&v, FAN) == 0, 5);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// The one that costs everybody else theirs.
///
/// A round trip in a single window — deposit and withdraw the same amount, cost: gas — left
/// `FreshTotal` claiming money the vault no longer held. `eligible_total` is the denominator the
/// rebate is divided by, so it fell below the principal actually earning and `acc_rebate_per_unit`
/// grew past anything `rebate_pool` could pay. Honest depositors' claims then aborted on the
/// balance check and never recovered, because the accumulator only ever increases.
fun a_round_trip_cannot_inflate_the_accumulator() {
    let mut sc = setup();
    set_full_rebate(&mut sc);

    deposit(&mut sc, FAN, 100 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    // In and straight back out, same window.
    deposit(&mut sc, FAN2, 100 * SUI_1);
    assert!(withdraw_returning(&mut sc, FAN2, 100 * SUI_1) == 100 * SUI_1, 0);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::principal_of(&v, FAN2) == 0, 1);
        // The whole finding. This read 0 before the fix, because a stale `FreshTotal` of 100
        // covered the entire vault.
        assert!(sv::eligible_total(&v) == 100 * SUI_1, 2);
        ts::return_shared(v);
    };

    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    // The rebate must still be payable out of the pool that was funded for it. An inflated
    // accumulator shows up here as a claim larger than the pool, which aborts.
    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let due = sv::claimable_rebate(&v, FAN);
        assert!(due > 0, 3);
        assert!(due <= sv::rebate_pool_value(&v), 4);
        let out = sv::claim_rebate(&mut v, &acct, sc.ctx());
        assert!(out.value() == due, 5);
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// And the fix must not become a gift.
///
/// A withdrawal comes out of MATURED principal first, so the marker only shrinks once what remains
/// cannot cover it. The other order would let anyone deposit and immediately withdraw the same
/// amount of older principal, and the new money would start earning as though it had sat through a
/// harvest. Here 100 is mature and 50 is fresh; withdrawing 50 must leave the 50 fresh still
/// ineligible, not convert it.
fun a_withdrawal_comes_out_of_matured_principal_first() {
    let mut sc = setup();
    set_full_rebate(&mut sc);

    deposit(&mut sc, FAN, 100 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    deposit(&mut sc, FAN, 50 * SUI_1);
    assert!(withdraw_returning(&mut sc, FAN, 50 * SUI_1) == 50 * SUI_1, 0);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::principal_of(&v, FAN) == 100 * SUI_1, 1);
        // 100 principal, 50 of it still fresh. Not 100, which is what taking from the fresh side
        // first would have produced.
        assert!(sv::eligible_total(&v) == 50 * SUI_1, 2);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// A withdrawal that has to unwind must be paid for the rebate its own principal funded.
///
/// `withdraw` binds `acc = vault.acc_rebate_per_unit` before the unwind loop, and every
/// `credit_proceeds` inside that loop can raise the same field — the unwind realises staking
/// rewards, and `eligible_total` still counts the withdrawer's principal while it does, because
/// `vault.total_principal` is not reduced until afterwards. Until 2026-09-01 the re-baseline at the
/// end used the stale binding, so the withdrawer's principal sat in the denominator that funded the
/// increment and their debt was reset as though it had never happened. The difference stayed in
/// `rebate_pool` with no claimant.
///
/// FAN2 stays in so the accumulator has somewhere to go and the pool has a second claimant; what
/// is asserted is that FAN's share is not left behind.
fun an_unwinding_withdrawal_is_paid_the_rebate_it_funded() {
    let mut sc = setup();
    set_full_rebate(&mut sc);

    deposit(&mut sc, FAN, 100 * SUI_1);
    deposit(&mut sc, FAN2, 100 * SUI_1);

    // Run the ladder to convergence so the buffer cannot cover the withdrawal on its own, and
    // through a maturity so there is realised yield and a non-zero accumulator. The bound is the
    // ladder's own depth rather than a number, so a depth change moves this with it.
    let mut i = 0;
    while (i < 4 * (ladder::ladder_depth() + 1)) {
        harvest(&mut sc);
        gtu::advance_epoch_with_reward_amounts(0, 400, &mut sc);
        i = i + 1;
    };

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::staked_principal(&v) > 0, 0);
        // The precondition the test exists for: the buffer alone cannot pay FAN out, so `withdraw`
        // must unwind, and the unwind is what moves the accumulator mid-function.
        assert!(sv::liquid_value(&v) < 100 * SUI_1, 1);
        assert!(sv::claimable_rebate(&v, FAN) > 0, 6); // the rebate is live before we start
        ts::return_shared(v);
    };

    // FAN exits in full. The unwind this forces realises yield, and part of that yield is FAN's.
    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let mut state = sc.take_shared<SuiSystemState>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::withdraw(&mut v, &acct, 100 * SUI_1, &mut state, sc.ctx());
        assert!(out.value() == 100 * SUI_1, 2);
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(state);
        ts::return_shared(v);
    };

    // THE ASSERTION, and it is an equality rather than a threshold on purpose.
    //
    // FAN and FAN2 deposited the same amount at the same moment and were eligible together for
    // every harvest since, including the increment FAN's own unwind produced — `eligible_total`
    // still counted FAN's principal when `credit_proceeds` divided by it. So their two shares are
    // the same number. A stale accumulator does not make FAN's claim zero, which is why a
    // `fan_due > 0` check passes against the defect and proves nothing; it makes FAN's claim
    // strictly SMALLER than FAN2's by exactly the increment FAN was not credited for, and leaves
    // that difference in `rebate_pool` with nobody able to claim it.
    let fan_due;
    let fan2_due;
    let pool;
    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        fan_due = sv::claimable_rebate(&v, FAN);
        fan2_due = sv::claimable_rebate(&v, FAN2);
        pool = sv::rebate_pool_value(&v);
        ts::return_shared(v);
    };
    assert!(pool > 0, 3);
    assert!(fan_due > 0, 4);
    assert!(fan_due == fan2_due, 5);

    // And the pool must actually empty. What is left after both claims is integer-division dust,
    // not a share somebody was owed — the defect left FAN's whole missing increment sitting here.
    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::claim_rebate(&mut v, &acct, sc.ctx());
        assert!(out.value() == fan_due, 7);
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(v);
    };
    sc.next_tx(FAN2);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::claim_rebate(&mut v, &acct, sc.ctx());
        coin::burn_for_testing(out);
        // Under a thousand MIST against a pool measured in millions: rounding, not a share.
        assert!(sv::rebate_pool_value(&v) < 1_000, 8);
        sc.return_to_sender(acct);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// A harvest that realises nothing must not age anybody's money.
///
/// `harvest` is permissionless by design — an absent creator must not be able to stall the vault —
/// and `vault.harvests` is the maturity clock. Until 2026-09-01 the counter incremented on every
/// call regardless of whether the call realised any yield, so the two together let anyone deposit
/// and then mature their own deposit on the spot for the price of gas. That defeats
/// `a_deposit_does_not_earn_the_harvest_it_walks_into` by the cheapest route there is: deposit
/// straight after a real harvest, call `harvest` again while nothing has matured so it realises
/// zero, and arrive at the next real harvest already eligible for yield that accrued before the
/// money existed in the vault.
fun a_harvest_that_realises_nothing_matures_nothing() {
    let mut sc = setup();
    set_full_rebate(&mut sc);

    // An honest depositor, staked and earning.
    deposit(&mut sc, FAN, 50 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    let harvests_before;
    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        harvests_before = sv::harvests(&v);
        ts::return_shared(v);
    };

    // The attacker arrives with ten times the honest stake, then pays gas to age it. Nothing has
    // matured since the harvest above, so these calls realise zero.
    deposit(&mut sc, FAN2, 500 * SUI_1);
    harvest(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        // The counter did not move, so the marker written by the deposit is still current.
        assert!(sv::harvests(&v) == harvests_before, 0);
        assert!(sv::eligible_total(&v) == 50 * SUI_1, 1);
        ts::return_shared(v);
    };

    // The next REAL harvest. The attacker must take nothing from it, exactly as if they had not
    // called `harvest` at all.
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::harvests(&v) == harvests_before + 1, 2);
        assert!(sv::claimable_rebate(&v, FAN2) == 0, 3); // the whole finding
        assert!(sv::claimable_rebate(&v, FAN) > 0, 4);
        ts::return_shared(v);
    };

    // And the money still matures on its own once a real harvest has passed under it — the fix
    // must delay the attacker, not confiscate from them.
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::claimable_rebate(&v, FAN2) > 0, 5);
        ts::return_shared(v);
    };

    sc.end();
}

#[test]
/// The pause promise, tested rather than trusted.
///
/// `platform.move` states it without qualification: "No pause switch in this package can block a
/// claim, a withdrawal, or an entitlement read." That is a claim in prose, and prose cannot be
/// mutation-tested — a guard could be added to any of these paths tomorrow and nothing would fail.
/// So every switch in the package is thrown at once and every stake-side money path out is
/// exercised against them.
///
/// Withdrawals and claims must all succeed. The other half — that the switches DO stop a deposit —
/// is pinned by `a_deposit_is_refused_while_payments_are_paused` and
/// `a_deposit_is_refused_once_the_vault_stops_accepting`; here the switches are read back at the
/// end so a test that paused nothing could not pass.
fun no_pause_can_block_a_withdrawal_or_a_claim() {
    let mut sc = setup();
    set_full_rebate(&mut sc);
    deposit(&mut sc, FAN, 100 * SUI_1);
    harvest(&mut sc);
    advance_to_maturity(&mut sc);
    harvest(&mut sc);

    // Every switch this package has, all on at once.
    sc.next_tx(ADMIN);
    {
        let mut p = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_creation_paused(&mut p, &cap, true);
        platform::set_payments_paused(&mut p, &cap, true);
        sc.return_to_sender(cap);
        ts::return_shared(p);
    };
    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        sv::set_accepting(&mut v, &cap, false);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    // The depositor's rebate.
    sc.next_tx(FAN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let due = sv::claimable_rebate(&v, FAN);
        assert!(due > 0, 0);
        let out = sv::claim_rebate(&mut v, &acct, sc.ctx());
        assert!(out.value() == due, 1);
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(v);
    };

    // The creator's yield.
    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        let amt = sv::creator_yield_value(&v);
        let out = sv::claim_creator_yield(&mut v, &cap, amt, sc.ctx());
        assert!(out.value() == amt, 2);
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    // The platform's own yield, claimed while the platform's own switches are on.
    sc.next_tx(ADMIN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<PlatformCap>();
        let amt = sv::platform_yield_value(&v);
        let out = sv::claim_platform_yield(&mut v, &cap, amt, sc.ctx());
        assert!(out.value() == amt, 3);
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };

    // And the principal, in full, with everything paused and every unit of it delegated.
    assert!(withdraw_returning(&mut sc, FAN, 100 * SUI_1) == 100 * SUI_1, 4);

    // The other side of the boundary. Without this, a test that pauses nothing would also pass.
    sc.next_tx(ADMIN);
    {
        let p = sc.take_shared<Platform>();
        assert!(platform::payments_paused(&p), 5);
        assert!(platform::creation_paused(&p), 6);
        ts::return_shared(p);
    };

    sc.end();
}

// === Doors that must refuse ===
//
// The 2026-09-01 mutation pass ran 164 mutations over this package and the survivors were almost
// all one shape: an authorization or ownership check that exists, runs on every call, and whose
// removal left the whole suite green because no test had ever presented the wrong object to it.
// Every test in this section names the line it exists for, and each was checked against that line
// blanked — it fails, for the right reason, when the guard is gone. A test that passes with its
// guard removed is not a test of the guard.

/// The platform `setup` opened the vault on. Read before a second deployment exists: the vault
/// does not expose its platform, and once two are shared they can only be told apart by exclusion.
fun home_platform_id(sc: &mut Scenario): ID {
    sc.next_tx(ADMIN);
    let p = sc.take_shared<Platform>();
    let id = object::id(&p);
    ts::return_shared(p);
    id
}

/// A second deployment beside the one `setup` built — mainnet and staging is the real case, and
/// its objects are indistinguishable from the first's in a wallet. Returns the new platform's ID.
fun open_another_deployment(sc: &mut Scenario): ID {
    sc.next_tx(ADMIN);
    { platform::init_for_testing(sc.ctx()); };
    sc.next_tx(ADMIN);
    ts::most_recent_id_shared<Platform>().destroy_some()
}

/// The `PlatformCap` governing `platform_id`, from ADMIN's wallet, whichever order it arrived in.
/// Call from an ADMIN transaction.
fun cap_for(sc: &mut Scenario, platform_id: ID): PlatformCap {
    let mut ids = ts::ids_for_sender<PlatformCap>(sc);
    let mut found = option::none<PlatformCap>();
    while (!ids.is_empty()) {
        let cap = sc.take_from_sender_by_id<PlatformCap>(ids.pop_back());
        if (platform::cap_platform_id(&cap) == platform_id) {
            found.fill(cap);
        } else {
            sc.return_to_sender(cap);
        };
    };
    ids.destroy_empty();
    found.destroy_some()
}

/// The vault `setup` opened. Read before a second vault exists, for the same reason as
/// `home_platform_id`.
fun home_vault_id(sc: &mut Scenario): ID {
    sc.next_tx(ADMIN);
    let v = sc.take_shared<StakeVault>();
    let id = object::id(&v);
    ts::return_shared(v);
    id
}

/// A second stake vault on the same platform, opened by FAN2, who then holds its `StakeCap`.
fun open_another_vault(sc: &mut Scenario) {
    sc.next_tx(FAN2);
    let mut p = sc.take_shared<Platform>();
    let acct = sc.take_from_sender<SocialAccount>();
    let cap = sv::open(&mut p, &acct, VALIDATOR, sc.ctx());
    transfer::public_transfer(cap, FAN2);
    sc.return_to_sender(acct);
    ts::return_shared(p);
}

/// One deposit, staked and matured once, so every yield balance is non-zero.
fun earn_one_harvest(sc: &mut Scenario) {
    deposit(sc, FAN, 100 * SUI_1);
    harvest(sc);
    advance_to_maturity(sc);
    harvest(sc);
}

// --- Somebody else's account ---
//
// A `SocialAccount` has no `store`, so no on-chain path hands one to a stranger today. The scenario
// constructs that holder deliberately, exactly as `account_tests` does for `close`: this call is
// the only thing standing between a named account and the vault if any such path ever appears,
// and an untested last line is the one that rots.

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ENotOwner)]
/// Kills stake_vault.move:619 — `withdraw` must authenticate the account against the sender.
///
/// The first finding of the 2026-09-01 mutation report. With the line blanked the stranger is
/// still refused, but for the wrong reason — `ENoPosition`, because `who` is the sender rather
/// than the account's owner — which is precisely the kind of green a suite cannot see through.
fun a_stranger_cannot_withdraw_with_somebody_elses_account() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 10 * SUI_1);

    sc.next_tx(FAN2);
    {
        let mut v = sc.take_shared<StakeVault>();
        let mut state = sc.take_shared<SuiSystemState>();
        let acct = sc.take_from_address<SocialAccount>(FAN);
        let out = sv::withdraw(&mut v, &acct, 10 * SUI_1, &mut state, sc.ctx());
        coin::burn_for_testing(out);
        ts::return_to_address(FAN, acct);
        ts::return_shared(state);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ENotOwner)]
/// Kills stake_vault.move:562 — `deposit` must authenticate the account against the sender.
fun a_stranger_cannot_deposit_with_somebody_elses_account() {
    let mut sc = setup();

    sc.next_tx(FAN2);
    {
        let p = sc.take_shared<Platform>();
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_address<SocialAccount>(FAN);
        let funds = coin::mint_for_testing<SUI>(10 * SUI_1, sc.ctx());
        sv::deposit(&p, &mut v, &acct, funds, sc.ctx());
        ts::return_to_address(FAN, acct);
        ts::return_shared(v);
        ts::return_shared(p);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ENotOwner)]
/// Kills stake_vault.move:252 — `open` must authenticate the creator's account against the sender.
fun a_stranger_cannot_open_a_vault_with_somebody_elses_account() {
    let mut sc = setup();

    sc.next_tx(FAN);
    {
        let mut p = sc.take_shared<Platform>();
        let acct = sc.take_from_address<SocialAccount>(CREATOR);
        let cap = sv::open(&mut p, &acct, VALIDATOR, sc.ctx());
        transfer::public_transfer(cap, FAN);
        ts::return_to_address(CREATOR, acct);
        ts::return_shared(p);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ENotOwner)]
/// The fourth door of the same shape, stake_vault.move:713 in `claim_rebate`. Not a row in the
/// mutation table — that line was never mutated — but it is the same call on the same kind of
/// path, and proven the same way.
fun a_stranger_cannot_claim_a_rebate_with_somebody_elses_account() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 10 * SUI_1);

    sc.next_tx(FAN2);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_address<SocialAccount>(FAN);
        let out = sv::claim_rebate(&mut v, &acct, sc.ctx());
        coin::burn_for_testing(out);
        ts::return_to_address(FAN, acct);
        ts::return_shared(v);
    };
    sc.end();
}

// --- The wrong capability ---

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EWrongVault)]
/// Kills stake_vault.move:964 — `assert_cap`, the one line that is the whole stake cap model.
///
/// Two vaults on one platform; the second vault's cap is presented to the first. Every `set_*`
/// door and `claim_creator_yield` run through this line, so with it blanked any `StakeCap` holder
/// governs every stake vault in the package.
fun a_cap_from_another_vault_cannot_set_its_rebate() {
    let mut sc = setup();
    let home = home_vault_id(&mut sc);
    open_another_vault(&mut sc);

    sc.next_tx(FAN2);
    {
        let mut v = sc.take_shared_by_id<StakeVault>(home);
        let cap = sc.take_from_sender<StakeCap>();
        assert!(sv::cap_vault_id(&cap) != home, 0); // the precondition: this cap is not the vault's
        sv::set_rebate_bps(&mut v, &cap, 10_000);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EWrongVault)]
/// Kills stake_vault.move:896 — the `assert_cap` call in `claim_creator_yield`, the door that
/// moves the creator's money. The vault has real yield and the claim asks for all of it, so with
/// the call removed the whole balance leaves to the holder of the wrong cap.
fun a_cap_from_another_vault_cannot_claim_its_creator_yield() {
    let mut sc = setup();
    earn_one_harvest(&mut sc);
    let home = home_vault_id(&mut sc);
    open_another_vault(&mut sc);

    sc.next_tx(FAN2);
    {
        let mut v = sc.take_shared_by_id<StakeVault>(home);
        let cap = sc.take_from_sender<StakeCap>();
        let due = sv::creator_yield_value(&v);
        assert!(due > 0, 0);
        let out = sv::claim_creator_yield(&mut v, &cap, due, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EWrongPlatform)]
/// Kills stake_vault.move:916 — `claim_platform_yield` binds the `PlatformCap` to the vault's
/// platform. A staging deployment's cap must not drain a mainnet vault's platform yield.
fun a_cap_from_another_deployment_cannot_claim_platform_yield() {
    let mut sc = setup();
    earn_one_harvest(&mut sc);
    let other = open_another_deployment(&mut sc);

    sc.next_tx(ADMIN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = cap_for(&mut sc, other);
        let due = sv::platform_yield_value(&v);
        assert!(due > 0, 0);
        let out = sv::claim_platform_yield(&mut v, &cap, due, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EWrongPlatform)]
/// Kills stake_vault.move:951 — `migrate_as_platform` refuses a platform that is not the vault's.
///
/// The cap is the right one; only the platform object is foreign. With the line blanked the cap
/// check still passes and the call falls through to `ENotUpgraded`, a different refusal.
fun the_platform_door_refuses_another_deployments_platform() {
    let mut sc = setup();
    let home = home_platform_id(&mut sc);
    let other = open_another_deployment(&mut sc);

    sc.next_tx(ADMIN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let foreign = sc.take_shared_by_id<Platform>(other);
        let cap = cap_for(&mut sc, home);
        sv::migrate_as_platform(&mut v, &foreign, &cap);
        sc.return_to_sender(cap);
        ts::return_shared(foreign);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EWrongPlatform)]
/// Kills stake_vault.move:952 — `migrate_as_platform` refuses a cap that does not govern the
/// vault's platform. The mirror of the test above: the platform is right, the cap is foreign.
fun the_platform_door_refuses_another_deployments_cap() {
    let mut sc = setup();
    let home = home_platform_id(&mut sc);
    let other = open_another_deployment(&mut sc);

    sc.next_tx(ADMIN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let p = sc.take_shared_by_id<Platform>(home);
        let cap = cap_for(&mut sc, other);
        sv::migrate_as_platform(&mut v, &p, &cap);
        sc.return_to_sender(cap);
        ts::return_shared(p);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::ENotUpgraded)]
/// Kills stake_vault.move:931 — the creator's own `migrate` at the current version is a named
/// refusal, not a silent no-op. The twin of `the_platform_door_refuses_a_vault_already_at_version`;
/// `migrate` itself had no test.
fun migrating_a_current_vault_is_refused() {
    let mut sc = setup();
    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        sv::migrate(&mut v, &cap);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.end();
}

// --- The deposit door ---

#[test]
#[expected_failure(abort_code = ::projectx_social::platform::EPaymentsPaused)]
/// Kills stake_vault.move:557 — `deposit` consults the platform's payments pause.
///
/// The creator side has `a_payments_pause_does_block_a_new_payment`; the stake side had only the
/// promise that the pause does NOT block withdrawals, which is the other half.
fun a_deposit_is_refused_while_payments_are_paused() {
    let mut sc = setup();
    sc.next_tx(ADMIN);
    {
        let mut p = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_payments_paused(&mut p, &cap, true);
        sc.return_to_sender(cap);
        ts::return_shared(p);
    };
    deposit(&mut sc, FAN, 10 * SUI_1);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EWrongPlatform)]
/// Kills stake_vault.move:558 — `deposit` refuses a platform that is not the vault's.
///
/// The account is the depositor's own and is bound to the vault's platform, so the account check
/// downstream passes; only this line stands between a deposit and a foreign platform's pause and
/// fee state.
fun a_deposit_is_refused_through_another_deployment() {
    let mut sc = setup();
    let other = open_another_deployment(&mut sc);

    sc.next_tx(FAN);
    {
        let foreign = sc.take_shared_by_id<Platform>(other);
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let funds = coin::mint_for_testing<SUI>(10 * SUI_1, sc.ctx());
        sv::deposit(&foreign, &mut v, &acct, funds, sc.ctx());
        sc.return_to_sender(acct);
        ts::return_shared(v);
        ts::return_shared(foreign);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::ENotAccepting)]
/// Kills stake_vault.move:559 — a vault that has stopped accepting refuses the deposit.
/// `closing_deposits_does_not_close_withdrawals` proves the switch spares withdrawals; nothing
/// proved it stops deposits.
fun a_deposit_is_refused_once_the_vault_stops_accepting() {
    let mut sc = setup();
    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        sv::set_accepting(&mut v, &cap, false);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    deposit(&mut sc, FAN, 10 * SUI_1);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::platform::ECreationPaused)]
/// Kills stake_vault.move:248 — `open` consults the platform's creation pause. The account and
/// creator sides each test this on their own `open`; the stake vault's was untested.
fun a_vault_cannot_be_opened_while_creation_is_paused() {
    let mut sc = setup();
    sc.next_tx(ADMIN);
    {
        let mut p = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_creation_paused(&mut p, &cap, true);
        sc.return_to_sender(cap);
        ts::return_shared(p);
    };
    sc.next_tx(FAN);
    {
        let mut p = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();
        let cap = sv::open(&mut p, &acct, VALIDATOR, sc.ctx());
        transfer::public_transfer(cap, FAN);
        sc.return_to_sender(acct);
        ts::return_shared(p);
    };
    sc.end();
}

#[test]
/// Kills the boundary at stake_vault.move:565 and at stake_ladder.move:211 together.
///
/// `a_dust_deposit_is_refused` pins one MIST below the minimum; nothing pinned the minimum itself,
/// so `>=` could become `>` and the suite stayed green. The two floors are the same number by
/// design — the module says so — and this proves they agree: exactly one SUI opens a position AND
/// is large enough for the ladder to stake, so `available < MIN_STAKE_MIST` becoming `<=` fails
/// here too, on the tranche count.
fun a_deposit_of_exactly_the_minimum_is_accepted_and_staked() {
    let mut sc = setup();
    let min = sv::min_deposit_mist();
    assert!(min == ladder::min_stake_mist(), 0);
    deposit(&mut sc, FAN, min);

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::principal_of(&v, FAN) == min, 1);
        ts::return_shared(v);
    };

    harvest(&mut sc);
    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::tranche_count(&v) == 1, 2);
        assert!(sv::staked_principal(&v) == min, 3);
        ts::return_shared(v);
    };
    sc.end();
}

// --- No position, and more than the balance ---

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::ENoPosition)]
/// Kills stake_vault.move:620 — `withdraw` names the refusal. Without the line the table borrow
/// aborts inside `sui::dynamic_field`, which a caller cannot tell from any other missing field.
fun withdrawing_without_a_position_is_refused() {
    let mut sc = setup();
    sc.next_tx(FAN2);
    {
        let mut v = sc.take_shared<StakeVault>();
        let mut state = sc.take_shared<SuiSystemState>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::withdraw(&mut v, &acct, 1, &mut state, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(state);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::ENoPosition)]
/// Kills stake_vault.move:714 — the same refusal on `claim_rebate`.
fun claiming_a_rebate_without_a_position_is_refused() {
    let mut sc = setup();
    sc.next_tx(FAN2);
    {
        let mut v = sc.take_shared<StakeVault>();
        let acct = sc.take_from_sender<SocialAccount>();
        let out = sv::claim_rebate(&mut v, &acct, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(acct);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::ENoPosition)]
/// Kills stake_vault.move:1013 — `principal_of` on an address with no position. `has_position`
/// is the read to prefer; this one is the abort a client must be able to name.
fun reading_the_principal_of_a_stranger_is_refused() {
    let mut sc = setup();
    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        sv::principal_of(&v, FAN2);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EInsufficientBalance)]
/// Kills stake_vault.move:897 — one MIST more than the creator's yield. Without the line
/// `Balance::split` aborts in `sui::balance` instead, anonymously.
fun the_creator_cannot_claim_more_yield_than_accrued() {
    let mut sc = setup();
    earn_one_harvest(&mut sc);
    sc.next_tx(CREATOR);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<StakeCap>();
        let due = sv::creator_yield_value(&v);
        assert!(due > 0, 0);
        let out = sv::claim_creator_yield(&mut v, &cap, due + 1, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::stake_vault::EInsufficientBalance)]
/// Kills stake_vault.move:917 — the same boundary on the platform's yield.
fun the_platform_cannot_claim_more_yield_than_accrued() {
    let mut sc = setup();
    earn_one_harvest(&mut sc);
    sc.next_tx(ADMIN);
    {
        let mut v = sc.take_shared<StakeVault>();
        let cap = sc.take_from_sender<PlatformCap>();
        let due = sv::platform_yield_value(&v);
        assert!(due > 0, 0);
        let out = sv::claim_platform_yield(&mut v, &cap, due + 1, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(v);
    };
    sc.end();
}

// === Guards no honest caller can reach ===
//
// Seven mutations in the 2026-09-01 pass survived in these two modules because the guard cannot
// fire through the public surface with an honest `sui_system` harness — not because nothing
// checks the property. They are recorded here rather than given a test that would pass with the
// line blanked; a test like that is green because it proves nothing, which is the most expensive
// kind of wrong. Each names the invariant that makes it unreachable and the test that pins that
// invariant from the other side, so a change that makes one reachable has a written claim to
// contradict. (The eighth, `creator.move:682`, is documented in `creator_tests.move`.)
//
// stake_ladder.move:171 and :252 — `withdrawn.value() >= principal`, on the harvest and unwind
//   paths. `request_withdraw_stake_non_entry` returns principal plus rewards for an activated
//   stake and exactly principal for one that never activated; Sui does not slash, and
//   `governance_test_utils` cannot produce a loss. Pinned from the other side by
//   `a_matured_tranche_actually_yields` (strictly more than principal came back) and
//   `principal_is_returned_in_full_even_when_fully_staked` (an unwind returned exactly it). The
//   guard is there because the alternative to aborting, should the staking system ever return
//   less than it was given, is a `u64` wrap crediting a phantom yield of ~1.8e19 MIST.
//
// stake_ladder.move:209 — `available <= liquid.value()`. `stake_one_rung` has one caller,
//   `harvest`, and it passes `vault.liquid.value()` as `available`. Pinned by every harvest in
//   this file; `the_ladder_stakes_at_most_one_rung_per_epoch` is the one that counts rungs.
//
// stake_ladder.move:212 — `tranches.length() >= MAX_TRANCHES` (16). One rung per epoch, and a
//   matured rung is withdrawn before the next is staked, so the ladder holds at most `RUNGS` (7)
//   at once and `harvest` never approaches the cap; the unwind in `withdraw` only removes.
//   Pinned by `the_ladder_never_holds_more_than_its_rungs`, below, on every epoch of a run
//   four ladders long with a deposit landing mid-way.
//
// stake_vault.move:543 — `backing >= total_principal` (`EInsolvent`). Every path moves
//   principal and backing by the same amount: `deposit` joins the payment to `liquid` and adds
//   it to `total_principal`; `withdraw` splits and subtracts the same `amount`; `harvest` moves
//   principal between `liquid` and a tranche whose `staked_sui_amount` is that principal, and
//   `credit_proceeds` returns exactly `principal` to `liquid` before it touches yield. Backing
//   equals principal at every point, so `<` needs a loss on staked SUI — which is :171 above.
//   Pinned by `the_vault_stays_solvent_through_churn` and every `is_solvent` assertion here.
//
// stake_vault.move:637 — `!tranches.is_empty()` (`ECannotRaiseLiquidity`). The loop runs while
//   `liquid < amount`, and `amount <= position.principal <= total_principal <= liquid + staked`
//   by :628 and :543. With no tranches `staked == 0`, so `liquid >= amount` and the loop is
//   never entered. Pinned by `principal_is_returned_in_full_even_when_fully_staked`, which
//   drains a ladder to pay a withdrawal and is made whole.
//
// stake_vault.move:728 — `rebate_pool.value() >= amount` (`EInsufficientBalance` in
//   `claim_rebate`). `amount` is the position's `pending`, credited as
//   `eligible_i * acc / ACC_SCALE` floored, and `acc` advances by `rebate_cut * ACC_SCALE /
//   eligible` floored each time `rebate_cut` is joined to the pool. Summed over depositors the
//   credits never exceed `rebate_cut`, so the pool always covers every claim; the one way past
//   was a stale `FreshTotal` inflating `acc`, closed on 2026-09-01. Pinned by
//   `a_round_trip_cannot_inflate_the_accumulator` (`due <= rebate_pool_value`) and
//   `an_unwinding_withdrawal_is_paid_the_rebate_it_funded` (the pool empties to dust).
//
// The seven version gates — `assert_version` and its callers in all three modules, including
// stake_vault.move:556 and :960 — are unreachable at `VERSION = 1` by construction and are
// documented once, in `platform_tests.move`.

#[test]
/// The ladder never holds more than `RUNGS` tranches at once, whatever the deposit flow.
///
/// Pins the invariant that keeps `stake_ladder.move:212` — the `MAX_TRANCHES` cap of 16 — out of
/// reach through `harvest`: one rung per epoch, and a matured rung is withdrawn before the next is
/// staked, so the count climbs to `rungs()` and stays there. A seven-fold deposit lands after the
/// ladder has converged to show that size changes rung size, not rung count. Asserted on every
/// epoch, not just at the end.
fun the_ladder_never_holds_more_than_its_rungs() {
    let mut sc = setup();
    deposit(&mut sc, FAN, 100 * SUI_1);

    let mut i = 0;
    while (i < 4 * ladder::rungs()) {
        harvest(&mut sc);
        sc.next_tx(ADMIN);
        {
            let v = sc.take_shared<StakeVault>();
            assert!(sv::tranche_count(&v) <= ladder::rungs(), 0);
            ts::return_shared(v);
        };
        if (i == ladder::rungs()) { deposit(&mut sc, FAN2, 700 * SUI_1); };
        gtu::advance_epoch_with_reward_amounts(0, 400, &mut sc);
        i = i + 1;
    };

    sc.next_tx(ADMIN);
    {
        let v = sc.take_shared<StakeVault>();
        assert!(sv::tranche_count(&v) == ladder::rungs(), 1);
        assert!(sv::total_principal(&v) == 800 * SUI_1, 2);
        assert!(sv::is_solvent(&v), 3);
        ts::return_shared(v);
    };
    sc.end();
}
