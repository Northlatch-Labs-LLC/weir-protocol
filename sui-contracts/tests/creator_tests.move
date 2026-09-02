// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/// End-to-end tests for the payment lifecycle.
///
/// The suite is organised around the properties that must hold rather than around the functions
/// that exist, because the defects worth catching here are the ones that live between functions —
/// value that leaves a buyer and arrives nowhere, a pause that traps a withdrawal, a fee that
/// changes under a creator who already agreed to a different one.
#[test_only]
module projectx_social::creator_tests;

use projectx_social::account::{Self, Registry, SocialAccount};
use projectx_social::creator::{Self, CreatorVault, CreatorCap};
use projectx_social::entitlement::{Self, Subscription, Unlock};
use projectx_social::platform::{Self, Platform, PlatformCap};
use sui::clock::{Self, Clock};
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts, Scenario};

/// Stands in for USDC. Only the type identity matters to the contract — the number of decimals
/// is never read on chain, which is exactly why clients must read it from `CoinMetadata`.
public struct USD has drop {}

const ADMIN: address = @0xAD;
const CREATOR: address = @0xC1;
const FAN: address = @0xFA;
const REFERRER: address = @0xEF;
/// A second creator, with a vault and a cap of their own. Exists to present them to CREATOR's vault.
const RIVAL: address = @0xC2;
/// A second fan. Exists to present FAN's account and FAN's subscription as their own.
const OTHER_FAN: address = @0xFB;
/// Publishes the second deployment. Mainnet beside staging is the real case: two `Platform`s, two
/// `PlatformCap`s, indistinguishable in a wallet.
const OTHER_ADMIN: address = @0xAE;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const MONTH_MS: u64 = 30 * 24 * 60 * 60 * 1000;

// === Fixtures ===

/// Publish the package and register three identities: a creator, a fan referred by nobody, and
/// a referrer. Returns a scenario positioned at ADMIN.
fun setup(): (Scenario, Clock) {
    let mut sc = ts::begin(ADMIN);
    {
        let ctx = sc.ctx();
        platform::init_for_testing(ctx);
        account::init_for_testing(ctx);
    };
    // The platform publishes shut, so a fixture has to open it exactly as a real deployment
    // does. Doing this in the fixture rather than hiding it in `init_for_testing` keeps the
    // deploy sequence honest: if the default changes, these break.
    sc.next_tx(ADMIN);
    {
        let mut p = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_creation_paused(&mut p, &cap, false);
        sc.return_to_sender(cap);
        ts::return_shared(p);
    };
    let clock = clock::create_for_testing(sc.ctx());
    (sc, clock)
}

fun open_account(sc: &mut Scenario, who: address, handle: vector<u8>, referrer: Option<address>) {
    sc.next_tx(who);
    let mut platform = sc.take_shared<Platform>();
    let mut registry = sc.take_shared<Registry>();
    let clock = clock::create_for_testing(sc.ctx());
    account::open(
        &mut platform,
        &mut registry,
        handle.to_string(),
        referrer,
        &clock,
        sc.ctx(),
    );
    clock::destroy_for_testing(clock);
    ts::return_shared(platform);
    ts::return_shared(registry);
}

fun set_fees(sc: &mut Scenario, fee_bps: u64, referral_share_bps: u64, creation_fee: u64) {
    sc.next_tx(ADMIN);
    let mut platform = sc.take_shared<Platform>();
    let cap = sc.take_from_sender<PlatformCap>();
    platform::set_fees(&mut platform, &cap, fee_bps, referral_share_bps, creation_fee);
    sc.return_to_sender(cap);
    ts::return_shared(platform);
}

/// Open a USD vault for CREATOR with one monthly tier priced at `price`.
fun open_vault_with_tier(sc: &mut Scenario, price: u64) {
    sc.next_tx(CREATOR);
    {
        let mut platform = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();
        let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
        let (cap, change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
        transfer::public_transfer(cap, CREATOR);
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(platform);
    };
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::add_tier(&mut vault, &cap, b"Monthly".to_string(), price, MONTH_MS);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
}

/// Open a bare USD vault — no tiers — for `who`, who must already hold an account, and return its
/// id. Every test about a capability or an entitlement presented to the WRONG vault needs a second
/// vault beside the one `open_vault_with_tier` opens for CREATOR; this is that vault.
fun open_vault_for(sc: &mut Scenario, who: address): ID {
    sc.next_tx(who);
    let mut platform = sc.take_shared<Platform>();
    let acct = sc.take_from_sender<SocialAccount>();
    let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
    let (cap, change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
    let vault_id = creator::cap_vault_id(&cap);
    transfer::public_transfer(cap, who);
    coin::burn_for_testing(change);
    sc.return_to_sender(acct);
    ts::return_shared(platform);
    vault_id
}

/// A second deployment, published by OTHER_ADMIN and opened for creation the way `setup` opens the
/// first. Returns its id.
///
/// Call it AFTER every fixture that resolves `take_shared<Platform>()`: that helper takes the most
/// recently created platform, so once this exists the other fixtures would land on it. Tests that
/// deploy a second platform address both by id from then on.
fun deploy_second_platform(sc: &mut Scenario): ID {
    sc.next_tx(OTHER_ADMIN);
    platform::init_for_testing(sc.ctx());
    sc.next_tx(OTHER_ADMIN);
    let mut p = sc.take_shared<Platform>();
    let cap = sc.take_from_sender<PlatformCap>();
    platform::set_creation_paused(&mut p, &cap, false);
    let id = object::id(&p);
    sc.return_to_sender(cap);
    ts::return_shared(p);
    id
}

/// The id of the vault `open_vault_with_tier` just opened. Advances a transaction first: the
/// inventory `most_recent_id_shared` reads is rebuilt at each `next_tx`, and that fixture returns
/// the vault inside the transaction that added its tier, where it is not yet visible again.
fun the_vault(sc: &mut Scenario): ID {
    sc.next_tx(CREATOR);
    ts::most_recent_id_shared<CreatorVault<USD>>().destroy_some()
}

/// `who` subscribes to tier 0 of `vault_id`, paying its price exactly. The `Subscription` lands in
/// `who`'s inventory.
fun subscribe_to(sc: &mut Scenario, who: address, vault_id: ID, clock: &Clock) {
    sc.next_tx(who);
    let platform = sc.take_shared<Platform>();
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let acct = sc.take_from_sender<SocialAccount>();
    let payment = coin::mint_for_testing<USD>(creator::tier_price(&vault, 0), sc.ctx());
    let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, clock, sc.ctx());
    assert!(change.value() == 0, 0);
    coin::burn_for_testing(change);
    sc.return_to_sender(acct);
    ts::return_shared(vault);
    ts::return_shared(platform);
}

// === Conservation of value ===

#[test]
/// The property the whole module exists for: every unit the fan pays lands somewhere.
fun a_subscription_conserves_every_unit() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 1_000, 5_000, 0); // 10% platform, half of it referred
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, REFERRER, b"referrer", option::none());
    open_account(&mut sc, FAN, b"fan", option::some(REFERRER));
    open_vault_with_tier(&mut sc, 10_000_000); // 10 USDC at 6dp

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());

        let change = creator::subscribe(
            &platform, &mut vault, &acct, 0, payment, &clock, sc.ctx(),
        );

        assert!(change.value() == 0, 0);
        coin::burn_for_testing(change);

        // 10 USDC: 9 to the creator, 0.5 to the platform, 0.5 to the referrer.
        assert!(creator::earnings_value(&vault) == 9_000_000, 1);
        assert!(creator::platform_fees_value(&vault) == 500_000, 2);
        assert!(creator::gross_volume(&vault) == 10_000_000, 3);

        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    // The referrer's leg left the vault, so it is checked as a coin in their wallet. Vault
    // balances alone would not prove conservation — the missing unit could simply be gone.
    sc.next_tx(REFERRER);
    {
        let paid = sc.take_from_sender<Coin<USD>>();
        assert!(paid.value() == 500_000, 4);
        // 9_000_000 + 500_000 + 500_000 == 10_000_000
        sc.return_to_sender(paid);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
/// With no referrer, the referral leg must fold into the platform's cut rather than vanish.
fun an_unreferred_payment_gives_the_whole_fee_to_the_platform() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 1_000, 5_000, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none()); // organic signup
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);

        assert!(creator::earnings_value(&vault) == 9_000_000, 0);
        // The full 10%, not 5%, because there was nobody to refer to.
        assert!(creator::platform_fees_value(&vault) == 1_000_000, 1);

        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

// === Pauses must never trap money ===

#[test]
/// The invariant stated at the top of `platform.move`, tested rather than asserted in prose.
fun neither_pause_can_block_a_claim() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 1_000, 0, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    // Everything that can be switched off, switched off.
    sc.next_tx(ADMIN);
    {
        let mut platform = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_creation_paused(&mut platform, &cap, true);
        platform::set_payments_paused(&mut platform, &cap, true);
        sc.return_to_sender(cap);
        ts::return_shared(platform);
    };
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::set_accepting(&mut vault, &cap, false);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    // The creator still gets paid.
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        let out = creator::claim_earnings(&mut vault, &cap, 9_000_000, sc.ctx());
        assert!(out.value() == 9_000_000, 0);
        assert!(creator::earnings_value(&vault) == 0, 1);
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    // And so does the platform.
    sc.next_tx(ADMIN);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<PlatformCap>();
        let out = creator::claim_platform_fees(&mut vault, &cap, 1_000_000, sc.ctx());
        assert!(out.value() == 1_000_000, 2);
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::platform::EPaymentsPaused)]
fun a_payments_pause_does_block_a_new_payment() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(ADMIN);
    {
        let mut platform = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_payments_paused(&mut platform, &cap, true);
        sc.return_to_sender(cap);
        ts::return_shared(platform);
    };

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

// === Fee snapshotting ===

#[test]
/// ProjectX raises the platform fee. A vault that already exists must keep its original rate.
fun the_platform_cannot_raise_a_fee_on_an_existing_vault() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 500, 0, 0); // 5% at vault creation
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    set_fees(&mut sc, 3_000, 0, 0); // platform raises to the 30% ceiling afterwards

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();

        assert!(platform::fee_bps(&platform) == 3_000, 0);
        assert!(creator::fee_bps_snapshot(&vault) == 500, 1);

        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);

        // Charged at 5%, the rate the creator agreed to.
        assert!(creator::earnings_value(&vault) == 9_500_000, 2);
        assert!(creator::platform_fees_value(&vault) == 500_000, 3);

        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
/// A creator may opt in to the current schedule, which is how a fee cut reaches existing vaults.
fun a_creator_can_adopt_the_current_terms() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 3_000, 0, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    set_fees(&mut sc, 100, 0, 0); // platform cuts the fee to 1%

    sc.next_tx(CREATOR);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();

        assert!(creator::fee_bps_snapshot(&vault) == 3_000, 0);
        creator::accept_current_terms(&mut vault, &cap, &platform);
        assert!(creator::fee_bps_snapshot(&vault) == 100, 1);

        sc.return_to_sender(cap);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

// === Entitlements ===

#[test]
fun a_subscription_expires_on_time_and_renewal_extends_from_the_expiry() {
    let (mut sc, mut clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    let vault_id;
    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        vault_id = object::id(&vault);
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    sc.next_tx(FAN);
    {
        let sub = sc.take_from_sender<Subscription>();
        assert!(entitlement::is_active(&sub, vault_id, FAN, &clock), 0);
        assert!(entitlement::expires_at_ms(&sub) == MONTH_MS, 1);

        // One millisecond before expiry: still active. The boundary is tested from both sides
        // because an off-by-one here is a free day for every subscriber on the platform.
        clock.set_for_testing(MONTH_MS - 1);
        assert!(entitlement::is_active(&sub, vault_id, FAN, &clock), 2);

        // Exactly at expiry: not active. `expires_at_ms` is exclusive.
        clock.set_for_testing(MONTH_MS);
        assert!(!entitlement::is_active(&sub, vault_id, FAN, &clock), 3);

        sc.return_to_sender(sub);
    };

    // Renew ten days after expiry. The new expiry runs a full month from *now*, not from the
    // stale expiry — otherwise the fan pays for a month and receives twenty days.
    sc.next_tx(FAN);
    {
        clock.set_for_testing(MONTH_MS + 10 * DAY_MS);
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let mut sub = sc.take_from_sender<Subscription>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());

        let change = creator::renew(
            &platform, &mut vault, &acct, &mut sub, payment, &clock, sc.ctx(),
        );
        coin::burn_for_testing(change);

        assert!(entitlement::renewals(&sub) == 1, 4);
        assert!(entitlement::expires_at_ms(&sub) == MONTH_MS + 10 * DAY_MS + MONTH_MS, 5);
        assert!(entitlement::is_active(&sub, vault_id, FAN, &clock), 6);

        sc.return_to_sender(sub);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
/// Renewing early must add a period rather than reset the clock, or the fan loses the remainder.
fun renewing_early_does_not_discard_time_already_paid_for() {
    let (mut sc, mut clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    sc.next_tx(FAN);
    {
        clock.set_for_testing(DAY_MS); // one day in, 29 remaining
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let mut sub = sc.take_from_sender<Subscription>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::renew(&platform, &mut vault, &acct, &mut sub, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);

        // Two months from the original start, not one month from today.
        assert!(entitlement::expires_at_ms(&sub) == MONTH_MS * 2, 0);

        sc.return_to_sender(sub);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

// === Unlocks ===

#[test]
fun unlocking_content_pays_the_creator_and_grants_permanent_access() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 1_000, 0, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    let key = b"post:0191f3c7";

    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        assert!(!creator::is_for_sale(&vault, key), 0); // unpriced means unbuyable
        creator::set_content_price(&mut vault, &cap, key, 2_000_000);
        assert!(creator::content_price(&vault, key) == 2_000_000, 1);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    let vault_id;
    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        vault_id = object::id(&vault);

        // Overpay deliberately: the change must come back rather than become a donation.
        let payment = coin::mint_for_testing<USD>(5_000_000, sc.ctx());
        let change = creator::unlock(&platform, &mut vault, &acct, key, payment, &clock, sc.ctx());
        assert!(change.value() == 3_000_000, 2);
        coin::burn_for_testing(change);

        assert!(creator::earnings_value(&vault) == 1_800_000, 3);
        assert!(creator::platform_fees_value(&vault) == 200_000, 4);
        assert!(creator::unlocks_sold(&vault) == 1, 5);

        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    // Delisting must not revoke what somebody already bought.
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::unprice_content(&mut vault, &cap, key);
        assert!(!creator::is_for_sale(&vault, key), 6);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    sc.next_tx(FAN);
    {
        let unlock = sc.take_from_sender<Unlock>();
        assert!(entitlement::unlocks(&unlock, vault_id, FAN, key), 7);
        // ...but it does not unlock a different post.
        assert!(!entitlement::unlocks(&unlock, vault_id, FAN, b"post:other"), 8);
        sc.return_to_sender(unlock);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EContentNotForSale)]
fun unpriced_content_cannot_be_bought() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(9_999_999, sc.ctx());
        let change = creator::unlock(
            &platform, &mut vault, &acct, b"never:priced", payment, &clock, sc.ctx(),
        );
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

// === Tips ===

#[test]
fun a_tip_takes_the_whole_coin_and_respects_the_minimum() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 1_000, 0, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(1_500_000, sc.ctx());
        creator::tip(&platform, &mut vault, &acct, payment, sc.ctx());

        assert!(creator::earnings_value(&vault) == 1_350_000, 0);
        assert!(creator::platform_fees_value(&vault) == 150_000, 1);
        assert!(creator::tips_received(&vault) == 1, 2);

        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EBelowMinTip)]
fun a_tip_below_the_minimum_is_refused() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::set_min_tip(&mut vault, &cap, 1_000_000);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(999_999, sc.ctx());
        creator::tip(&platform, &mut vault, &acct, payment, sc.ctx());
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

// === Authorisation ===

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ESelfPayment)]
fun a_creator_cannot_pay_their_own_vault() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(CREATOR);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EInsufficientPayment)]
fun underpaying_a_subscription_aborts() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(9_999_999, sc.ctx()); // one unit short
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EInsufficientBalance)]
fun a_creator_cannot_claim_more_than_they_earned() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        let out = creator::claim_earnings(&mut vault, &cap, 1, sc.ctx());
        coin::burn_for_testing(out);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    clock::destroy_for_testing(clock);
    sc.end();
}

// === Tier terms must be whole Seal content periods ===
//
// Access is released in fixed 30-day quanta by `entitlement::seal_approve_subscription`, but tier
// terms were free-form. A one-day tier bought in the 24 hours before a period boundary satisfied
// both of that function's time checks and released the entire next 30-day period — thirty days of
// content for one day of payment — while the same tier bought at any other moment released
// nothing. Sold monthly, charged daily. These three tests pin the two models together.

#[test]
/// The guard is the whole finding: a term that is not a whole number of periods is refused.
#[expected_failure(abort_code = projectx_social::creator::EPeriodNotWholeSealPeriods)]
fun a_tier_term_that_is_not_whole_periods_is_refused() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    // Six weeks: longer than a period, but not a multiple of one.
    creator::add_tier(&mut vault, &cap, b"Six weeks".to_string(), 1_000, MONTH_MS + 12 * DAY_MS);
    sc.return_to_sender(cap);
    ts::return_shared(vault);
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
/// Multi-period terms stay legal — the fix constrains the shape, not the length.
fun a_multi_period_tier_term_is_accepted() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        // Priced above the 10_000_000 tier the fixture opens with, and above each other. This
        // test is about the period length, but tiers are now required to ascend in price because
        // the index is what Seal ranks access by — see `ETierPriceNotAscending`.
        creator::add_tier(&mut vault, &cap, b"Quarterly".to_string(), 30_000_000, 3 * MONTH_MS);
        creator::add_tier(&mut vault, &cap, b"Annual".to_string(), 120_000_000, 12 * MONTH_MS);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
/// A drift test. `creator` and `entitlement` must keep agreeing about how wide a period is; the
/// original defect was precisely that they did not, and nothing failed when they diverged.
fun the_tier_floor_is_exactly_one_seal_period() {
    assert!(creator::min_period_ms() == entitlement::seal_period_ms(), 0);
    assert!(creator::min_period_ms() % entitlement::seal_period_ms() == 0, 1);
}

#[test]
#[expected_failure(abort_code = projectx_social::creator::ETierInactive)]
/// A tier the creator has retired must refuse new subscriptions.
fun a_retired_tier_cannot_be_subscribed_to() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());

    sc.next_tx(CREATOR);
    {
        let mut platform = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();
        let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
        let (cap, change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
        transfer::public_transfer(cap, CREATOR);
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(platform);
    };
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::add_tier(&mut vault, &cap, b"Monthly".to_string(), 10_000_000, MONTH_MS);
        // Retire the tier.
        creator::update_tier(&mut vault, &cap, 0, 10_000_000, MONTH_MS, false);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENotAccepting)]
/// A vault that has stopped accepting payments must refuse new ones.
fun a_vault_that_has_stopped_accepting_refuses_new_payments() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());

    sc.next_tx(CREATOR);
    {
        let mut platform = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();
        let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
        let (cap, change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
        transfer::public_transfer(cap, CREATOR);
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(platform);
    };
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::add_tier(&mut vault, &cap, b"Monthly".to_string(), 10_000_000, MONTH_MS);
        // Stop accepting payments.
        creator::set_accepting(&mut vault, &cap, false);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
        let change = creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx());
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = projectx_social::creator::EZeroPrice)]
/// A tier with a zero price must be refused — a free tier is a free subscription to everything.
fun a_tier_with_a_zero_price_is_refused() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());

    sc.next_tx(CREATOR);
    {
        let mut platform = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();
        let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
        let (cap, change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
        transfer::public_transfer(cap, CREATOR);
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(platform);
    };
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::add_tier(&mut vault, &cap, b"Free".to_string(), 0, MONTH_MS);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

// === Tier rank is price rank ===
//
// `entitlement::seal_approve_subscription` grants access with `subscription.tier >= tier`, and
// `subscription.tier` is the INDEX into `tiers`. The index is therefore the rank. Nothing tied the
// rank to the price until 2026-09-01, so a cheap tier sitting at a high index outranked the
// expensive ones below it and its subscribers could derive their keys — permanently, because a
// Seal key cannot be revoked, and silently, because nothing in the flow said anything was wrong.

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ETierPriceNotAscending)]
/// The launch shape of the defect: Basic, then VIP, then a cheap Trial added later that outranks
/// both. This is the one a creator falls into by growing their pricing.
fun a_cheaper_tier_cannot_be_added_above_an_expensive_one() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000); // index 0, "Basic"
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::add_tier(&mut vault, &cap, b"VIP".to_string(), 100_000_000, MONTH_MS);
    // Index 2, and cheaper than both. Before the fix its subscribers outranked VIP.
    creator::add_tier(&mut vault, &cap, b"Trial".to_string(), 1_000_000, MONTH_MS);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ETierPriceNotAscending)]
/// The sibling, and the one that would have survived a fix confined to `add_tier`. Repricing reads
/// like a pricing decision, so this is the easier of the two to do by accident — and it inverts the
/// rank of everybody already subscribed to the two tiers involved.
fun a_reprice_cannot_invert_two_tiers() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::add_tier(&mut vault, &cap, b"VIP".to_string(), 100_000_000, MONTH_MS);
    // Lift index 0 above index 1. Every index-0 subscriber would then outrank nobody, and every
    // index-1 subscriber would keep reading index-0's newly premium content for the old price.
    creator::update_tier(&mut vault, &cap, 0, 500_000_000, MONTH_MS, true);
    abort 0
}

#[test]
/// And the rule must not block ordinary pricing work. Adding upwards, repricing inside the gap
/// between neighbours, and retiring a tier all have to keep working — a rule that stops a creator
/// running their business would be traded away the first time it got in the way.
fun ordinary_pricing_still_works_under_the_ordering_rule() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();

        creator::add_tier(&mut vault, &cap, b"Plus".to_string(), 50_000_000, MONTH_MS);
        creator::add_tier(&mut vault, &cap, b"VIP".to_string(), 100_000_000, MONTH_MS);

        // Reprice the middle tier anywhere strictly between its neighbours.
        creator::update_tier(&mut vault, &cap, 1, 60_000_000, MONTH_MS, true);
        assert!(creator::tier_price(&vault, 1) == 60_000_000, 0);

        // Retire it. A retired tier keeps its index, so it keeps its rank and its place in the
        // ordering — but retiring is not a repricing and must not be refused.
        creator::update_tier(&mut vault, &cap, 1, 60_000_000, MONTH_MS, false);
        assert!(!creator::tier_active(&vault, 1), 1);

        // The top tier can still go up.
        creator::update_tier(&mut vault, &cap, 2, 200_000_000, MONTH_MS, true);
        assert!(creator::tier_price(&vault, 2) == 200_000_000, 2);

        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENotUpgraded)]
/// `CreatorCap` has `store` — it can be transferred, sold or lost — and `migrate` was the only way
/// to advance a creator vault's version. Every entry point begins with `assert_version`, including
/// `claim_earnings` and `claim_platform_fees`, so a lost cap would strand BOTH the creator's
/// earnings and the platform's own commission behind the version gate the moment a new version
/// shipped. `stake_vault` has had this second door since it shipped and its comment says why; the
/// vault holding the subscription money did not.
///
/// It cannot be exercised at the current version, so this pins the gate the way `stake_vault`'s
/// twin does: called with nothing to migrate, it is a named refusal rather than a silent no-op.
fun the_platform_door_refuses_a_creator_vault_already_at_version() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(ADMIN);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let platform = sc.take_shared<Platform>();
    let cap = sc.take_from_sender<PlatformCap>();
    creator::migrate_as_platform(&mut vault, &platform, &cap);
    abort 0
}

// === The capability model ===
//
// `assert_cap` is one line — `cap.vault == object::id(vault)` — and it is the whole of a creator's
// authority: every `set_*` door, `add_tier`, `update_tier` and `claim_earnings` run through it. The
// 2026-09-01 mutation sweep deleted that line and the suite stayed green, because no test had ever
// presented one vault's cap to another vault. A `CreatorCap` has `store`; a rival holding a real one
// is the ordinary case, not a contrived one.

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongVault)]
/// Kills creator.move:831 — `assert!(cap.vault == object::id(vault), EWrongVault)`.
fun a_cap_for_another_vault_cannot_configure_this_one() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, RIVAL, b"rival", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let mine = the_vault(&mut sc);
    open_vault_for(&mut sc, RIVAL);

    // RIVAL's cap is genuine. It governs RIVAL's vault and must open nothing else.
    sc.next_tx(RIVAL);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(mine);
    let cap = sc.take_from_sender<CreatorCap>();
    creator::add_tier(&mut vault, &cap, b"Hijacked".to_string(), 20_000_000, MONTH_MS);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongVault)]
/// Kills creator.move:758 — the `assert_cap` call in `claim_earnings`. The money door, pinned
/// separately from the configuration doors: a rival with a cap of their own must not withdraw one
/// unit of somebody else's earnings.
fun a_cap_for_another_vault_cannot_claim_its_earnings() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, RIVAL, b"rival", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let mine = the_vault(&mut sc);
    open_vault_for(&mut sc, RIVAL);
    subscribe_to(&mut sc, FAN, mine, &clock);

    sc.next_tx(RIVAL);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(mine);
    let cap = sc.take_from_sender<CreatorCap>();
    assert!(creator::earnings_value(&vault) == 10_000_000, 0);
    coin::burn_for_testing(creator::claim_earnings(&mut vault, &cap, 1, sc.ctx()));
    abort 0
}

// === Two deployments ===
//
// Mainnet beside staging. A `Platform`, a `PlatformCap` and a `SocialAccount` from one must be
// refused by the other at every door, or a staging cap sweeps mainnet commission and a staging
// account pays into mainnet vaults. Every one of these checks was deleted in the 2026-09-01 sweep
// with the suite green.

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongPlatform)]
/// Kills creator.move:778 — `claim_platform_fees` with the other deployment's cap.
fun a_cap_from_another_platform_cannot_claim_the_fees() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 1_000, 0, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    subscribe_to(&mut sc, FAN, vault_id, &clock);
    deploy_second_platform(&mut sc);

    sc.next_tx(OTHER_ADMIN);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    // OTHER_ADMIN holds exactly one cap, and it is the second deployment's.
    let cap = sc.take_from_sender<PlatformCap>();
    assert!(creator::platform_fees_value(&vault) == 1_000_000, 0);
    coin::burn_for_testing(creator::claim_platform_fees(&mut vault, &cap, 1_000_000, sc.ctx()));
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongPlatform)]
/// Kills creator.move:819 — `migrate_as_platform` with the right platform and the wrong cap.
fun the_platform_door_refuses_a_cap_from_another_platform() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    let platform_a = ts::most_recent_id_shared<Platform>().destroy_some();
    deploy_second_platform(&mut sc);

    sc.next_tx(OTHER_ADMIN);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let platform = sc.take_shared_by_id<Platform>(platform_a);
    let cap = sc.take_from_sender<PlatformCap>();
    creator::migrate_as_platform(&mut vault, &platform, &cap);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongPlatform)]
/// Kills creator.move:818 — `migrate_as_platform` with the right cap and the wrong platform object.
fun the_platform_door_refuses_another_platform_object() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    let platform_b = deploy_second_platform(&mut sc);

    sc.next_tx(ADMIN);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let platform = sc.take_shared_by_id<Platform>(platform_b);
    let cap = sc.take_from_sender<PlatformCap>();
    creator::migrate_as_platform(&mut vault, &platform, &cap);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongPlatform)]
/// Kills creator.move:522 — `accept_current_terms` against a platform that did not issue the vault.
/// The second deployment publishes at a zero fee; without this line a creator could snapshot it.
fun terms_cannot_be_adopted_from_another_platform() {
    let (mut sc, _clock) = setup();
    set_fees(&mut sc, 3_000, 0, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    let platform_b = deploy_second_platform(&mut sc);

    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let platform = sc.take_shared_by_id<Platform>(platform_b);
    let cap = sc.take_from_sender<CreatorCap>();
    creator::accept_current_terms(&mut vault, &cap, &platform);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongPlatform)]
/// Kills creator.move:609 — the platform check in `assert_payable`, reached through `subscribe`.
/// The other deployment's pause switches would otherwise govern this vault's payments.
fun a_payment_cannot_be_routed_through_another_platform() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    let platform_b = deploy_second_platform(&mut sc);

    sc.next_tx(FAN);
    let platform = sc.take_shared_by_id<Platform>(platform_b);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let acct = sc.take_from_sender<SocialAccount>();
    let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
    coin::burn_for_testing(
        creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx()),
    );
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EWrongPlatform)]
/// Kills account.move:271 — the platform half of `assert_authenticates`, reached through
/// `open_vault`. `assert_authenticates` is `public(package)`, so it can only be tested through the
/// `creator` doors that call it; that is why this lives here and not in `account_tests`.
fun an_account_from_another_platform_cannot_open_a_vault() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    let platform_b = deploy_second_platform(&mut sc);

    sc.next_tx(CREATOR);
    let mut platform = sc.take_shared_by_id<Platform>(platform_b);
    let acct = sc.take_from_sender<SocialAccount>();
    let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
    let (_cap, _change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
    abort 0
}

// === Authentication at the creator's doors ===

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ENotOwner)]
/// Kills account.move:270 and creator.move:613 — the owner half of `assert_authenticates`, reached
/// through `subscribe`. A `SocialAccount` has no `store`, so no on-chain path hands one to OTHER_FAN
/// today; the scenario constructs the impossible holder deliberately, because this line is the
/// last one between a borrowed reference and somebody else's referrer being paid on your money.
fun a_fan_cannot_pay_with_somebody_elses_account() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_account(&mut sc, OTHER_FAN, b"other_fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(OTHER_FAN);
    let platform = sc.take_shared<Platform>();
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let acct = sc.take_from_address<SocialAccount>(FAN);
    let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
    coin::burn_for_testing(
        creator::subscribe(&platform, &mut vault, &acct, 0, payment, &clock, sc.ctx()),
    );
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ENotOwner)]
/// Kills creator.move:332 — the `assert_authenticates` call in `open_vault`. RIVAL has no account
/// and presents CREATOR's; the vault that would open would carry CREATOR's identity and RIVAL's cap.
fun a_vault_cannot_be_opened_on_somebody_elses_account() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());

    sc.next_tx(RIVAL);
    let mut platform = sc.take_shared<Platform>();
    let acct = sc.take_from_address<SocialAccount>(CREATOR);
    let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
    let (_cap, _change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::platform::ECreationPaused)]
/// Kills creator.move:328 — the creation pause, reached through `open_vault` rather than by calling
/// `assert_can_create` directly, which is what the existing platform test does.
fun no_vault_can_be_opened_while_creation_is_paused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());

    sc.next_tx(ADMIN);
    {
        let mut platform = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_creation_paused(&mut platform, &cap, true);
        sc.return_to_sender(cap);
        ts::return_shared(platform);
    };

    sc.next_tx(CREATOR);
    let mut platform = sc.take_shared<Platform>();
    let acct = sc.take_from_sender<SocialAccount>();
    let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
    let (_cap, _change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
    abort 0
}

// === Renewal presents the right subscription ===

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ESubscriptionVaultMismatch)]
/// Kills creator.move:678 — a subscription minted by one vault presented to another for renewal.
/// RIVAL's vault has a tier at the same price, so nothing but this line stands in the way.
fun a_subscription_cannot_be_renewed_at_another_vault() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, RIVAL, b"rival", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let mine = the_vault(&mut sc);
    let theirs = open_vault_for(&mut sc, RIVAL);
    sc.next_tx(RIVAL);
    {
        let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(theirs);
        let cap = sc.take_from_sender<CreatorCap>();
        creator::add_tier(&mut vault, &cap, b"Monthly".to_string(), 10_000_000, MONTH_MS);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
    subscribe_to(&mut sc, FAN, mine, &clock);

    sc.next_tx(FAN);
    let platform = sc.take_shared<Platform>();
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(theirs);
    let acct = sc.take_from_sender<SocialAccount>();
    let mut sub = sc.take_from_sender<Subscription>();
    let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
    coin::burn_for_testing(
        creator::renew(&platform, &mut vault, &acct, &mut sub, payment, &clock, sc.ctx()),
    );
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENotSubscriber)]
/// Kills creator.move:679 — somebody else's subscription renewed from the renewer's own account.
/// `Subscription` is soulbound, so the scenario constructs the impossible holder deliberately, as
/// `a_fan_cannot_pay_with_somebody_elses_account` does with the account.
fun a_subscription_cannot_be_renewed_by_somebody_else() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_account(&mut sc, OTHER_FAN, b"other_fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    subscribe_to(&mut sc, FAN, vault_id, &clock);

    sc.next_tx(OTHER_FAN);
    let platform = sc.take_shared<Platform>();
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let acct = sc.take_from_sender<SocialAccount>();
    let mut sub = sc.take_from_address<Subscription>(FAN);
    let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
    coin::burn_for_testing(
        creator::renew(&platform, &mut vault, &acct, &mut sub, payment, &clock, sc.ctx()),
    );
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ETierInactive)]
/// Kills creator.move:684 — renewing onto a tier the creator has since retired. The `subscribe`
/// side is `a_retired_tier_cannot_be_subscribed_to`; this is the other door onto the same tier.
fun a_retired_tier_cannot_be_renewed() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    subscribe_to(&mut sc, FAN, vault_id, &clock);

    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
        let cap = sc.take_from_sender<CreatorCap>();
        creator::update_tier(&mut vault, &cap, 0, 10_000_000, MONTH_MS, false);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    sc.next_tx(FAN);
    let platform = sc.take_shared<Platform>();
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let acct = sc.take_from_sender<SocialAccount>();
    let mut sub = sc.take_from_sender<Subscription>();
    let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
    coin::burn_for_testing(
        creator::renew(&platform, &mut vault, &acct, &mut sub, payment, &clock, sc.ctx()),
    );
    abort 0
}

/*
  creator.move:682 — `assert!(tier_index < vault.tiers.length(), ENoSuchTier)` in `renew` — is
  DEFENSIVE and deliberately has no test.

  `Subscription.tier` is written once, in `subscribe`, from a `tier_index` that creator.move:644 has
  already bounded, and tiers are append-only: `update_tier` retires a tier in place precisely so
  that no subscriber's index is ever renumbered (see `Tier.active`). A subscription's index can
  therefore never exceed its own vault's tier count, and creator.move:678 refuses a subscription
  from any other vault before line 682 is reached. The invariant is pinned from the other side by
  `subscribing_to_a_tier_that_does_not_exist_is_refused` (bounded at birth) and
  `ordinary_pricing_still_works_under_the_ordering_rule` (retiring keeps the index). Tripping the
  line would need a seam that forges a `Subscription` with an out-of-range tier, and a guard only a
  forged object can reach is not one a test should claim to cover.
*/

// === Balances ===

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EInsufficientBalance)]
/// Kills creator.move:779 — the platform cannot claim one unit more than the vault holds for it.
/// The creator's twin is `a_creator_cannot_claim_more_than_they_earned`.
fun the_platform_cannot_claim_more_than_its_fees() {
    let (mut sc, clock) = setup();
    set_fees(&mut sc, 1_000, 0, 0);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    subscribe_to(&mut sc, FAN, vault_id, &clock);

    sc.next_tx(ADMIN);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let cap = sc.take_from_sender<PlatformCap>();
    assert!(creator::platform_fees_value(&vault) == 1_000_000, 0);
    coin::burn_for_testing(creator::claim_platform_fees(&mut vault, &cap, 1_000_001, sc.ctx()));
    abort 0
}

// === Tier and content validation ===
//
// One refusal per guard, and every exact boundary from both sides. Each of these lines was deleted
// in the 2026-09-01 mutation sweep and the suite stayed green: the happy path had been tested and
// not one of the refusals.

#[test]
/// The accepted side of creator.move:401 — exactly `MAX_TIERS` tiers are legal.
fun sixteen_tiers_are_accepted() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    let vault_id = open_vault_for(&mut sc, CREATOR);

    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
        let cap = sc.take_from_sender<CreatorCap>();
        let mut i = 0;
        while (i < creator::max_tiers()) {
            creator::add_tier(&mut vault, &cap, b"Tier".to_string(), (i + 1) * 1_000_000, MONTH_MS);
            i = i + 1;
        };
        assert!(creator::max_tiers() == 16, 0);
        assert!(creator::tier_count(&vault) == 16, 1);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ETooManyTiers)]
/// Kills creator.move:401 — the seventeenth tier, from both the deletion and the `<=` boundary.
fun a_seventeenth_tier_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    let vault_id = open_vault_for(&mut sc, CREATOR);

    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let cap = sc.take_from_sender<CreatorCap>();
    let mut i = 0;
    while (i < creator::max_tiers()) {
        creator::add_tier(&mut vault, &cap, b"Tier".to_string(), (i + 1) * 1_000_000, MONTH_MS);
        i = i + 1;
    };
    creator::add_tier(&mut vault, &cap, b"One too many".to_string(), 17_000_000, MONTH_MS);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EEmptyName)]
/// Kills creator.move:402 — a tier with no name cannot be audited.
fun a_tier_with_an_empty_name_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::add_tier(&mut vault, &cap, b"".to_string(), 20_000_000, MONTH_MS);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EBadPeriod)]
/// Kills creator.move:404, the floor. Zero is a whole number of Seal periods, so only this guard
/// can refuse it — a term of one day would be caught by `EPeriodNotWholeSealPeriods` first.
fun a_tier_term_of_zero_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::add_tier(&mut vault, &cap, b"Instant".to_string(), 20_000_000, 0);
    abort 0
}

#[test]
/// The accepted side of the ceiling in creator.move:404. `MAX_PERIOD_MS` is 3,650 days, which is
/// not itself a whole number of 30-day periods, so the real boundary the two rules compose to is
/// 121 periods (3,630 days) accepted, 122 (3,660 days) refused.
fun the_longest_whole_period_term_under_the_ceiling_is_accepted() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        assert!(121 * MONTH_MS <= creator::max_period_ms(), 0);
        creator::add_tier(&mut vault, &cap, b"Decade".to_string(), 20_000_000, 121 * MONTH_MS);
        assert!(creator::tier_period_ms(&vault, 1) == 121 * MONTH_MS, 1);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EBadPeriod)]
/// Kills creator.move:404, the ceiling — the first whole-period term over `MAX_PERIOD_MS`.
fun the_first_whole_period_term_over_the_ceiling_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    assert!(122 * MONTH_MS > creator::max_period_ms(), 0);
    creator::add_tier(&mut vault, &cap, b"Too long".to_string(), 20_000_000, 122 * MONTH_MS);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENoSuchTier)]
/// Kills creator.move:432 — `update_tier` at `tier_count`, the first index that does not exist.
fun updating_a_tier_that_does_not_exist_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    let missing = creator::tier_count(&vault);
    creator::update_tier(&mut vault, &cap, missing, 20_000_000, MONTH_MS, true);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EZeroPrice)]
/// Kills creator.move:433 — the `update_tier` twin of `a_tier_with_a_zero_price_is_refused`.
fun a_tier_cannot_be_repriced_to_zero() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::update_tier(&mut vault, &cap, 0, 0, MONTH_MS, true);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EBadPeriod)]
/// Kills creator.move:434 — the `update_tier` twin of `a_tier_term_of_zero_is_refused`.
fun a_tier_term_cannot_be_updated_to_zero() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::update_tier(&mut vault, &cap, 0, 10_000_000, 0, true);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EPeriodNotWholeSealPeriods)]
/// Kills creator.move:435 — the `update_tier` twin of `a_tier_term_that_is_not_whole_periods_is_refused`.
/// A reprice that could slip a six-week term past the rule would reopen the defect from the side
/// `add_tier` had closed.
fun a_tier_term_cannot_be_updated_to_a_fraction_of_a_period() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::update_tier(&mut vault, &cap, 0, 10_000_000, MONTH_MS + 12 * DAY_MS, true);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ETierPriceNotAscending)]
/// Kills creator.move:441 — the predecessor comparison. `a_reprice_cannot_invert_two_tiers` lifts
/// a tier ABOVE its successor and only reaches line 444; this drops one BELOW its predecessor.
fun a_reprice_cannot_drop_a_tier_below_its_predecessor() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::add_tier(&mut vault, &cap, b"Plus".to_string(), 50_000_000, MONTH_MS);
    creator::add_tier(&mut vault, &cap, b"VIP".to_string(), 100_000_000, MONTH_MS);
    // Still below VIP, so the successor check passes; only the predecessor check can refuse it.
    creator::update_tier(&mut vault, &cap, 1, 5_000_000, MONTH_MS, true);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EEmptyName)]
/// Kills creator.move:464 — content with an empty key cannot be priced.
fun content_with_an_empty_key_cannot_be_priced() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::set_content_price(&mut vault, &cap, b"", 1_000_000);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EZeroPrice)]
/// Kills creator.move:465 — a zero price is not "free", it is a paid unlock for nothing.
fun content_cannot_be_priced_at_zero() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::set_content_price(&mut vault, &cap, b"post:1", 0);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EContentNotForSale)]
/// Kills creator.move:485 — `unprice_content` on a key that was never priced. Without the guard the
/// table removal aborts anyway, but with a `sui::table` code and no name a client can act on.
fun content_that_was_never_priced_cannot_be_unpriced() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::unprice_content(&mut vault, &cap, b"never:priced");
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EZeroPrice)]
/// Kills creator.move:494 — a zero minimum would let `tip` settle an empty coin.
fun the_minimum_tip_cannot_be_zero() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::set_min_tip(&mut vault, &cap, 0);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENoSuchTier)]
/// Kills creator.move:644 — `subscribe` at `tier_count`, the first index that does not exist.
fun subscribing_to_a_tier_that_does_not_exist_is_refused() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(FAN);
    let platform = sc.take_shared<Platform>();
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let acct = sc.take_from_sender<SocialAccount>();
    let missing = creator::tier_count(&vault);
    let payment = coin::mint_for_testing<USD>(10_000_000, sc.ctx());
    coin::burn_for_testing(
        creator::subscribe(&platform, &mut vault, &acct, missing, payment, &clock, sc.ctx()),
    );
    abort 0
}

#[test]
/// The accepted side of creator.move:703 — a tip of exactly the minimum settles.
/// `a_tip_below_the_minimum_is_refused` is one unit under; between them a `>=` cannot become `>`.
fun a_tip_of_exactly_the_minimum_is_accepted() {
    let (mut sc, clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);

    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::set_min_tip(&mut vault, &cap, 1_000_000);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };

    sc.next_tx(FAN);
    {
        let platform = sc.take_shared<Platform>();
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let acct = sc.take_from_sender<SocialAccount>();
        let payment = coin::mint_for_testing<USD>(1_000_000, sc.ctx());
        creator::tip(&platform, &mut vault, &acct, payment, sc.ctx());
        assert!(creator::tips_received(&vault) == 1, 0);
        // No fee was set, so the whole coin is the creator's.
        assert!(creator::earnings_value(&vault) == 1_000_000, 1);
        sc.return_to_sender(acct);
        ts::return_shared(vault);
        ts::return_shared(platform);
    };
    clock::destroy_for_testing(clock);
    sc.end();
}

// === Reads that must refuse ===
//
// A getter that reads past the end of `tiers` aborts on the vector index either way; these pin the
// NAMED refusal, so a storefront asking about a tier that does not exist gets `ENoSuchTier` and not
// a bare VM error it cannot show a user.

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENoSuchTier)]
/// Kills creator.move:859.
fun reading_the_price_of_a_tier_that_does_not_exist_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let vault = sc.take_shared<CreatorVault<USD>>();
    let _ = creator::tier_price(&vault, creator::tier_count(&vault));
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENoSuchTier)]
/// Kills creator.move:864.
fun reading_the_period_of_a_tier_that_does_not_exist_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let vault = sc.take_shared<CreatorVault<USD>>();
    let _ = creator::tier_period_ms(&vault, creator::tier_count(&vault));
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENoSuchTier)]
/// Kills creator.move:869.
fun reading_whether_a_tier_that_does_not_exist_is_active_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let vault = sc.take_shared<CreatorVault<USD>>();
    let _ = creator::tier_active(&vault, creator::tier_count(&vault));
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENoSuchTier)]
/// Kills creator.move:874.
fun reading_the_name_of_a_tier_that_does_not_exist_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let vault = sc.take_shared<CreatorVault<USD>>();
    let _ = creator::tier_name(&vault, creator::tier_count(&vault));
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EContentNotForSale)]
/// Kills creator.move:885 — `content_price` on a key that is not for sale. `is_for_sale` is the
/// read that does not abort, and the existing unlock test already asks it first.
fun reading_the_price_of_unpriced_content_is_refused() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let vault = sc.take_shared<CreatorVault<USD>>();
    let _ = creator::content_price(&vault, b"never:priced");
    abort 0
}

// === The creator's own migrate door ===

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENotUpgraded)]
/// Kills creator.move:789 — `migrate` with the creator's own cap on a vault already at `VERSION`.
/// The platform door has `the_platform_door_refuses_a_creator_vault_already_at_version`; this is
/// the creator's, pinned the same way: a named refusal, not a silent no-op.
fun the_creator_door_refuses_a_vault_already_at_version() {
    let (mut sc, _clock) = setup();
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    sc.next_tx(CREATOR);
    let mut vault = sc.take_shared<CreatorVault<USD>>();
    let cap = sc.take_from_sender<CreatorCap>();
    creator::migrate(&mut vault, &cap);
    abort 0
}

// === Subscription keys are ranked by the price paid (C3) ===

/// A vault with the C3 shape: an expensive tier at index 0 and a cheap one at index 1. Legal on
/// mainnet for vaults opened before `ETierPriceNotAscending`; here it is built through the
/// test-only door so the policy is exercised against exactly that shape.
fun open_vault_expensive_then_cheap(sc: &mut Scenario) {
    sc.next_tx(CREATOR);
    {
        let mut platform = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();
        let fee = coin::mint_for_testing<SUI>(1_000_000_000, sc.ctx());
        let (cap, change) = creator::open_vault<USD>(&mut platform, &acct, fee, sc.ctx());
        transfer::public_transfer(cap, CREATOR);
        coin::burn_for_testing(change);
        sc.return_to_sender(acct);
        ts::return_shared(platform);
    };
    sc.next_tx(CREATOR);
    {
        let mut vault = sc.take_shared<CreatorVault<USD>>();
        let cap = sc.take_from_sender<CreatorCap>();
        creator::add_tier(&mut vault, &cap, b"Monthly".to_string(), 10_000_000, MONTH_MS);
        creator::add_tier_unordered_for_testing(&mut vault, &cap, b"Supporter".to_string(), 500_000, MONTH_MS);
        sc.return_to_sender(cap);
        ts::return_shared(vault);
    };
}

/// `who` subscribes to `tier` of `vault_id`, paying that tier's price exactly.
fun subscribe_to_tier(sc: &mut Scenario, who: address, vault_id: ID, tier: u64, clock: &Clock) {
    sc.next_tx(who);
    let platform = sc.take_shared<Platform>();
    let mut vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let acct = sc.take_from_sender<SocialAccount>();
    let payment = coin::mint_for_testing<USD>(creator::tier_price(&vault, tier), sc.ctx());
    let change = creator::subscribe(&platform, &mut vault, &acct, tier, payment, clock, sc.ctx());
    coin::burn_for_testing(change);
    sc.return_to_sender(acct);
    ts::return_shared(vault);
    ts::return_shared(platform);
}

fun approve_as(sc: &mut Scenario, who: address, vault_id: ID, tier: u64, period: u64) {
    sc.next_tx(who);
    let vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let sub = sc.take_from_sender<Subscription>();
    creator::approve_subscription_for_testing(
        entitlement::period_identity(vault_id, tier, period), tier, period, &vault, &sub, sc.ctx(),
    );
    sc.return_to_sender(sub);
    ts::return_shared(vault);
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ETierNotPaidFor)]
/// C3 itself: the 0.50 tier sits at index 1, above the 10.00 tier at index 0. Under the retired
/// index comparison this subscriber read Monthly content; under the price rule they do not.
fun a_cheap_tier_at_a_higher_index_cannot_read_the_expensive_tier() {
    let (mut sc, mut clock) = setup();
    clock.set_for_testing(10 * MONTH_MS + 1);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_expensive_then_cheap(&mut sc);
    let vault_id = the_vault(&mut sc);
    subscribe_to_tier(&mut sc, FAN, vault_id, 1, &clock);
    approve_as(&mut sc, FAN, vault_id, 0, 11);
    abort 0
}

#[test]
/// The same subscriber reads their own tier, and an expensive subscriber reads the cheap one.
fun a_subscriber_reads_every_tier_priced_at_or_below_what_they_paid() {
    let (mut sc, mut clock) = setup();
    clock.set_for_testing(10 * MONTH_MS + 1);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_account(&mut sc, OTHER_FAN, b"other_fan", option::none());
    open_vault_expensive_then_cheap(&mut sc);
    let vault_id = the_vault(&mut sc);
    subscribe_to_tier(&mut sc, FAN, vault_id, 1, &clock);
    subscribe_to_tier(&mut sc, OTHER_FAN, vault_id, 0, &clock);
    approve_as(&mut sc, FAN, vault_id, 1, 11);
    approve_as(&mut sc, OTHER_FAN, vault_id, 0, 11);
    approve_as(&mut sc, OTHER_FAN, vault_id, 1, 11);
    clock.destroy_for_testing();
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EPeriodNotPaid)]
fun a_subscription_key_is_refused_for_a_period_before_it_started() {
    let (mut sc, mut clock) = setup();
    clock.set_for_testing(10 * MONTH_MS + 1);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    subscribe_to(&mut sc, FAN, vault_id, &clock);
    // Period 10 started before the subscription: back catalogue, not included.
    approve_as(&mut sc, FAN, vault_id, 0, 10);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EPeriodNotPaid)]
fun a_subscription_key_is_refused_for_a_period_after_it_expires() {
    let (mut sc, mut clock) = setup();
    clock.set_for_testing(10 * MONTH_MS + 1);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    subscribe_to(&mut sc, FAN, vault_id, &clock);
    // Paid until 11P+1, so period 12 (starting 12P) is not included.
    approve_as(&mut sc, FAN, vault_id, 0, 12);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ESubscriptionVaultMismatch)]
fun a_subscription_to_one_vault_cannot_present_against_another() {
    let (mut sc, mut clock) = setup();
    clock.set_for_testing(10 * MONTH_MS + 1);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_account(&mut sc, OTHER_FAN, b"other_fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    let other_vault = open_vault_for(&mut sc, OTHER_FAN);
    subscribe_to(&mut sc, FAN, vault_id, &clock);
    let period = 11;
    sc.next_tx(FAN);
    let vault = sc.take_shared_by_id<CreatorVault<USD>>(other_vault);
    let sub = sc.take_from_sender<Subscription>();
    creator::approve_subscription_for_testing(
        entitlement::period_identity(other_vault, 0, period), 0, period, &vault, &sub, sc.ctx(),
    );
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::ENotSubscriber)]
fun somebody_else_cannot_present_a_subscription_they_do_not_hold() {
    let (mut sc, mut clock) = setup();
    clock.set_for_testing(10 * MONTH_MS + 1);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_account(&mut sc, OTHER_FAN, b"other_fan", option::none());
    open_vault_with_tier(&mut sc, 10_000_000);
    let vault_id = the_vault(&mut sc);
    subscribe_to(&mut sc, FAN, vault_id, &clock);
    let period = 11;
    sc.next_tx(OTHER_FAN);
    let vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let sub = sc.take_from_address<Subscription>(FAN);
    creator::approve_subscription_for_testing(
        entitlement::period_identity(vault_id, 0, period), 0, period, &vault, &sub, sc.ctx(),
    );
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::creator::EWrongIdentity)]
fun a_subscription_key_is_refused_for_an_identity_naming_another_tier() {
    let (mut sc, mut clock) = setup();
    clock.set_for_testing(10 * MONTH_MS + 1);
    open_account(&mut sc, CREATOR, b"creator", option::none());
    open_account(&mut sc, FAN, b"fan", option::none());
    open_vault_expensive_then_cheap(&mut sc);
    let vault_id = the_vault(&mut sc);
    subscribe_to_tier(&mut sc, FAN, vault_id, 1, &clock);
    let period = 11;
    sc.next_tx(FAN);
    let vault = sc.take_shared_by_id<CreatorVault<USD>>(vault_id);
    let sub = sc.take_from_sender<Subscription>();
    // Asks for tier 1 in the arguments and tier 0 in the identity: the bytes must match.
    creator::approve_subscription_for_testing(
        entitlement::period_identity(vault_id, 0, period), 1, period, &vault, &sub, sc.ctx(),
    );
    abort 0
}
