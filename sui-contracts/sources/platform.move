// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// The ProjectX Social platform object — global economic policy for the social network.
///
/// One `Platform` exists per deployment. It holds three things and nothing else: the fee schedule
/// that new creator vaults are stamped with, the SUI collected from creation fees, and the two
/// pause switches. It deliberately does **not** hold user data, creator earnings, or entitlements
/// — those live in objects owned by the people they belong to.
///
/// # What a pause may and may not do
///
/// This is the invariant that matters most in this module, so it is stated before the code:
///
/// > **No pause switch in this package can block a claim, a withdrawal, or an entitlement read.**
///
/// The sibling vault factory learned this the hard way and documents the same rule: a pause that
/// can trap capital is a pause that will eventually trap capital.
///
/// # Why the fee schedule starts at zero
module projectx_social::platform;

use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::display;
use sui::event;
use sui::package;
use sui::sui::SUI;

/// State-schema version, compared against `Platform.version` on every mutating call.
/// Raising this requires `migrate` to exist first — see the note on `migrate`.
const VERSION: u64 = 1;

/// Basis-point denominator. 10_000 bps = 100%.
const BPS_DENOMINATOR: u64 = 10_000;

// === Fee ceilings ===
//
// Hard bounds on what `PlatformCap` may set, enforced at the setter. These are compiled
// constants, so raising one costs a package upgrade and is visible on chain — as opposed to a
// quiet transaction that nobody watching the explorer would think to question.
//
// The ceiling exists because a capability that can set a 100% fee is a capability that can
// confiscate a creator's revenue. This bounds the damage a compromised or careless platform key
// can do, which is the same reason the vault factory bounds its own.

const MAX_PLATFORM_FEE_BPS: u64 = 3_000;

/// 50% — of the platform's own cut, never of the creator's. See `referral_share_bps`.
const MAX_REFERRAL_SHARE_BPS: u64 = 5_000;

/// 100 SUI. The third value `set_fees` writes, and until 2026-09-01 the only one with no bound.
///
/// The two above it were capped for a stated reason — a capability that can set a 100% fee can
/// confiscate a creator's revenue — and the same argument applies here with one word changed. An
/// unbounded creation fee cannot take anybody's money, but it can set a price nobody will pay, and
/// `collect_creation_fee` runs on every `account::open` and every `creator::open_vault`. Set it
/// high enough and the platform is closed: no new accounts, no new vaults, no error that says why,
/// and nothing on an explorer that looks like a fee change rather than a number.
///
/// 100 SUI is far above any fee this platform would charge — it is 0 today — and far below the
/// range where the setting becomes a switch. The bound is on the setter, so raising it costs a
/// package upgrade and is visible on chain, which is the whole point of putting it here rather
/// than in a runbook.
const MAX_CREATION_FEE_MIST: u64 = 100_000_000_000;

// === Errors ===

/// `Platform.version` does not match the package `VERSION`. Run `migrate`.
const EWrongVersion: u64 = 1;
/// The capability presented governs a different platform.
const EWrongPlatform: u64 = 2;
/// A fee rate above its compiled ceiling was requested.
const EFeeAboveCeiling: u64 = 3;
/// Creation of new accounts and vaults is paused.
const ECreationPaused: u64 = 4;
/// New payments are paused. Claims and withdrawals are deliberately unaffected.
const EPaymentsPaused: u64 = 5;
/// The SUI supplied does not cover the creation fee.
const EInsufficientFee: u64 = 6;
/// A treasury sweep was requested for more than the treasury holds.
const EInsufficientTreasury: u64 = 7;
/// `migrate` was called when the stored version already matches the package.
const ENotUpgraded: u64 = 8;

// === One-time witness ===

/// Claims the `Publisher` that Sui Object Display requires.
///
/// Taken here because `init` is the only moment it can be taken. A previous deployment in this
/// estate shipped an `init` with no one-time witness, could therefore never register Display, and
/// could only be fixed by redeploying.
public struct PLATFORM has drop {}

// === Types ===

/// Platform authority. Sets fees, pauses, sweeps the creation-fee treasury, migrates state.
///
/// Has `store` so it can be placed inside a multisig-owned object, which is where it belongs.
/// That is the only reason it has `store` — it is not meant to be handed to anyone.
public struct PlatformCap has key, store {
    id: UID,
    platform: ID,
}

/// The platform. A shared object: anyone may read it, and anyone may register through it.
public struct Platform has key {
    id: UID,
    version: u64,

    // --- economic terms, snapshotted into each creator vault at creation ---
    /// The platform's cut of every payment, in basis points of the gross.
    fee_bps: u64,
    /// The referrer's share **of the platform's cut**, in basis points of that cut.
    referral_share_bps: u64,

    /// Charged in SUI when a creator vault is opened. Accounts are always free — see `account`.
    creation_fee_mist: u64,

    // --- switches ---
    /// Blocks new accounts and new creator vaults. Never blocks payments or claims.
    creation_paused: bool,
    /// Blocks new payments. Never blocks claims, withdrawals or entitlement reads.
    payments_paused: bool,

    // --- treasury and counters ---
    /// Creation fees in SUI, awaiting sweep. Creator revenue and platform commission accrue in
    /// the creator vaults, denominated in the vault's coin type, and are swept separately.
    treasury: Balance<SUI>,
    accounts_created: u64,
    vaults_created: u64,
}

// === Events ===

public struct PlatformCreated has copy, drop {
    platform: ID,
    publisher: address,
}

public struct FeesUpdated has copy, drop {
    platform: ID,
    fee_bps: u64,
    referral_share_bps: u64,
    creation_fee_mist: u64,
}

public struct CreationPauseSet has copy, drop {
    platform: ID,
    paused: bool,
}

public struct PaymentsPauseSet has copy, drop {
    platform: ID,
    paused: bool,
}

public struct TreasurySwept has copy, drop {
    platform: ID,
    amount_mist: u64,
    recipient: address,
}

// === Initialisation ===

/// Publish-time setup. Runs once.
///
/// The platform is shared; `PlatformCap` and the `Publisher` go to the publisher.
///
/// # Why the platform publishes closed
///
/// Every economic parameter starts at zero, and **`creation_paused` starts `true`**. The second
/// half is not symmetry for its own sake — it closes a window that is otherwise permanent.
///
/// Fees are snapshotted into each vault at creation and cannot be raised afterwards. That is a
/// deliberate creator protection, and it means a vault opened before `set_fees` runs would carry
/// `fee_bps = 0` **for the life of the vault**. Publishing and configuring cannot be one
/// transaction, so between them there is a gap in which anyone watching for new packages could
/// open a vault that never pays a fee. The gap is short and the deployment is unannounced, which
/// is exactly the reasoning that makes this kind of hole survive review.
///
/// So the platform ships shut. The deploy sequence is: publish, move `PlatformCap` to multisig,
/// `set_fees`, verify the rate reads back, then `set_creation_paused(false)`. Opening the platform
/// is the last step and a deliberate one.
fun init(otw: PLATFORM, ctx: &mut TxContext) {
    let publisher = package::claim(otw, ctx);

    let mut platform_display = display::new<Platform>(&publisher, ctx);
    platform_display.add(b"name".to_string(), b"ProjectX Social".to_string());
    platform_display.add(
        b"description".to_string(),
        b"The economic backbone of the ProjectX social platform on Sui.".to_string(),
    );
    platform_display.add(b"creator".to_string(), b"ProjectX Protocol".to_string());
    platform_display.update_version();

    let platform = Platform {
        id: object::new(ctx),
        version: VERSION,
        fee_bps: 0,
        referral_share_bps: 0,
        creation_fee_mist: 0,
        // Ships shut. See the note on `init` — a vault opened before `set_fees` would snapshot a
        // zero fee permanently, so the platform must not be open before it is configured.
        creation_paused: true,
        payments_paused: false,
        treasury: balance::zero(),
        accounts_created: 0,
        vaults_created: 0,
    };
    let platform_id = object::id(&platform);

    let cap = PlatformCap { id: object::new(ctx), platform: platform_id };

    event::emit(PlatformCreated { platform: platform_id, publisher: ctx.sender() });

    // `Display` has no `drop` and must be kept. Held by the publisher, which is what allows the
    // rendered name to be corrected later without a redeploy.
    transfer::public_transfer(platform_display, ctx.sender());
    transfer::public_transfer(publisher, ctx.sender());
    transfer::public_transfer(cap, ctx.sender());
    transfer::share_object(platform);
}

// === Administration ===

/// Set the whole fee schedule at once.
public fun set_fees(
    platform: &mut Platform,
    cap: &PlatformCap,
    fee_bps: u64,
    referral_share_bps: u64,
    creation_fee_mist: u64,
) {
    assert_version(platform);
    assert_cap(platform, cap);
    assert!(fee_bps <= MAX_PLATFORM_FEE_BPS, EFeeAboveCeiling);
    assert!(referral_share_bps <= MAX_REFERRAL_SHARE_BPS, EFeeAboveCeiling);
    assert!(creation_fee_mist <= MAX_CREATION_FEE_MIST, EFeeAboveCeiling);

    platform.fee_bps = fee_bps;
    platform.referral_share_bps = referral_share_bps;
    platform.creation_fee_mist = creation_fee_mist;

    event::emit(FeesUpdated {
        platform: object::id(platform),
        fee_bps,
        referral_share_bps,
        creation_fee_mist,
    });
}

/// Stop or resume creation of new accounts and creator vaults.
public fun set_creation_paused(platform: &mut Platform, cap: &PlatformCap, paused: bool) {
    assert_version(platform);
    assert_cap(platform, cap);
    platform.creation_paused = paused;
    event::emit(CreationPauseSet { platform: object::id(platform), paused });
}

/// Stop or resume new payments.
///
/// This is the emergency switch. It stops value entering the system; it cannot stop value
/// leaving it, because no claim path consults it. That asymmetry is the point.
public fun set_payments_paused(platform: &mut Platform, cap: &PlatformCap, paused: bool) {
    assert_version(platform);
    assert_cap(platform, cap);
    platform.payments_paused = paused;
    event::emit(PaymentsPauseSet { platform: object::id(platform), paused });
}

/// Withdraw collected creation fees to the caller.
public fun sweep_treasury(
    platform: &mut Platform,
    cap: &PlatformCap,
    amount_mist: u64,
    ctx: &mut TxContext,
): Coin<SUI> {
    assert_version(platform);
    assert_cap(platform, cap);
    assert!(platform.treasury.value() >= amount_mist, EInsufficientTreasury);

    event::emit(TreasurySwept {
        platform: object::id(platform),
        amount_mist,
        recipient: ctx.sender(),
    });

    coin::from_balance(platform.treasury.split(amount_mist), ctx)
}

/// Bring a platform created under an older schema up to the current `VERSION`.
///
/// This function is the reason `VERSION` can ever be raised. A sibling protocol in this estate
/// shipped a version check with no migration path; bumping the constant would have frozen every
/// guarded call — withdrawals included — with no recovery. Deliberately not repeated here.
public fun migrate(platform: &mut Platform, cap: &PlatformCap) {
    assert_cap(platform, cap);
    assert!(platform.version < VERSION, ENotUpgraded);
    platform.version = VERSION;
}

// === Package-internal hooks ===
//
// These are how `account` and `creator` consult and update platform state. They are
// `public(package)` so that no external caller can increment a counter or take a fee without
// going through the module that actually does the work.

/// Collect the creation fee from `payment`, returning the change.
///
/// Change is returned rather than absorbed: overpaying a creation fee should not be a donation.
public(package) fun collect_creation_fee(
    platform: &mut Platform,
    mut payment: Coin<SUI>,
    ctx: &mut TxContext,
): Coin<SUI> {
    let due = platform.creation_fee_mist;
    assert!(payment.value() >= due, EInsufficientFee);
    if (due > 0) {
        platform.treasury.join(payment.split(due, ctx).into_balance());
    };
    payment
}

public(package) fun record_account_created(platform: &mut Platform) {
    platform.accounts_created = platform.accounts_created + 1;
}

public(package) fun record_vault_created(platform: &mut Platform) {
    platform.vaults_created = platform.vaults_created + 1;
}

public(package) fun assert_can_create(platform: &Platform) {
    assert_version(platform);
    assert!(!platform.creation_paused, ECreationPaused);
}

public(package) fun assert_can_pay(platform: &Platform) {
    assert_version(platform);
    assert!(!platform.payments_paused, EPaymentsPaused);
}

// === Assertions ===

fun assert_version(platform: &Platform) {
    assert!(platform.version == VERSION, EWrongVersion);
}

fun assert_cap(platform: &Platform, cap: &PlatformCap) {
    assert!(cap.platform == object::id(platform), EWrongPlatform);
}

// === Reads ===

/// Which platform a capability governs.
///
/// Exposed so a holder can verify before signing that the cap in their wallet is the one for the
/// deployment they think they are administering. With a mainnet and a staging deployment alive at
/// once, two caps are otherwise indistinguishable in a wallet.
public fun cap_platform_id(cap: &PlatformCap): ID { cap.platform }

public fun version(platform: &Platform): u64 { platform.version }

public fun fee_bps(platform: &Platform): u64 { platform.fee_bps }

public fun referral_share_bps(platform: &Platform): u64 { platform.referral_share_bps }

public fun creation_fee_mist(platform: &Platform): u64 { platform.creation_fee_mist }

public fun creation_paused(platform: &Platform): bool { platform.creation_paused }

public fun payments_paused(platform: &Platform): bool { platform.payments_paused }

public fun treasury_value(platform: &Platform): u64 { platform.treasury.value() }

public fun accounts_created(platform: &Platform): u64 { platform.accounts_created }

public fun vaults_created(platform: &Platform): u64 { platform.vaults_created }

public fun max_platform_fee_bps(): u64 { MAX_PLATFORM_FEE_BPS }

public fun max_referral_share_bps(): u64 { MAX_REFERRAL_SHARE_BPS }

public fun max_creation_fee_mist(): u64 { MAX_CREATION_FEE_MIST }

public fun bps_denominator(): u64 { BPS_DENOMINATOR }

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(PLATFORM {}, ctx)
}
