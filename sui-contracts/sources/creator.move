// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// The creator vault — where every payment on ProjectX Social is split and settled.
///
/// One vault per creator per coin type. It holds the creator's price list, their claimable
/// earnings, and the platform's claimable commission, and it is the only place in this package
/// where value changes hands.
///
/// # The defect class this module exists to make impossible
///
/// In the system this replaces, paying for a video call debited the buyer's wallet, wrote a
/// transaction row recording what the creator had earned, and **never credited the creator**.
/// There is no `increment('balance', …)` anywhere in either call controller. The money left the
/// buyer and arrived nowhere. It survived because the debit, the ledger row and the credit were
/// three separate statements, and nothing failed when the third was missing.
///
/// Here they are one operation. `settle` takes the buyer's coin and cannot return without having
/// placed every unit of it somewhere: creator earnings, platform commission, or the referrer's
/// address. A `Balance` that does not balance is not a bug you can ship — the transaction aborts.
/// The split is asserted exhaustive in `compute_split`, and the test suite checks the identity on
/// every payment path.
///
/// # Fees are snapshotted, and the creator holds the only key to changing them
///
/// `fee_bps_snapshot` is copied from the platform when the vault opens and never read from the
/// platform again. ProjectX cannot raise the commission on a creator who is already earning.
/// `accept_current_terms` lets a creator opt in to the platform's present schedule — which is how
/// a fee *reduction* reaches existing vaults — and only the creator can call it.
///
/// # Money is integers, in the coin's own minor units
///
/// Every amount here is a `u64` in `T`'s smallest unit. Nothing in this package knows how many
/// decimals `T` has and nothing needs to: the split is proportional, so it is exact at any scale.
/// Clients must read decimals from `CoinMetadata` — assuming a common value is how an amount ends
/// up wrong by a factor of a thousand.
module projectx_social::creator;

use projectx_social::account::{Self, SocialAccount};
use projectx_social::entitlement::{Self, Subscription};
use projectx_social::platform::{Self, Platform, PlatformCap};
use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::sui::SUI;
use sui::table::{Self, Table};

const VERSION: u64 = 1;
const BPS_DENOMINATOR: u64 = 10_000;

/// Upper bound on tiers per vault. Bounded because `tiers` is a `vector` that is scanned by
/// index, and an unbounded list is an unbounded gas cost that the creator imposes on every one of
/// their subscribers rather than on themselves.
const MAX_TIERS: u64 = 16;

/// Thirty days, in milliseconds, and exactly one Seal content period.
///
/// The floor on a subscription period. A period of a few seconds would turn renewal into a
/// griefing tool and make the price list meaningless, but that is no longer the binding reason:
/// `entitlement` releases access in fixed 30-day quanta, so a term shorter than one quantum
/// cannot be expressed by the access rule at all. See `EPeriodNotWholeSealPeriods` for what that
/// mismatch cost before the two were tied together, and `the_tier_floor_is_exactly_one_seal_period`
/// for the drift test that now fails if they part company again.
///
/// This doc said "one day" until 2026-09-01. The constant had been raised to thirty and the
/// sentence above it had not, which is the kind of comment that survives review precisely because
/// nobody re-reads a line that is not in the diff.
const MIN_PERIOD_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// Roughly ten years. The ceiling on a period, so a fat-fingered value cannot sell a
/// subscription that outlives the platform.
const MAX_PERIOD_MS: u64 = 3_650 * 24 * 60 * 60 * 1000;

// === Payment kinds, recorded on every settlement event ===

const KIND_SUBSCRIPTION: u8 = 1;
const KIND_RENEWAL: u8 = 2;
const KIND_TIP: u8 = 3;
const KIND_UNLOCK: u8 = 4;

// === Errors ===

const EWrongVersion: u64 = 1;
/// The capability presented governs a different vault.
const EWrongVault: u64 = 2;
/// The vault belongs to a different platform than the one supplied.
const EWrongPlatform: u64 = 3;
/// The creator has stopped accepting payments.
const ENotAccepting: u64 = 4;
/// The coin supplied does not cover the price.
const EInsufficientPayment: u64 = 5;
/// No tier exists at that index.
const ENoSuchTier: u64 = 6;
/// The tier exists but the creator has retired it.
const ETierInactive: u64 = 7;
/// `MAX_TIERS` reached.
const ETooManyTiers: u64 = 8;
/// The subscription period is outside `MIN_PERIOD_MS`..`MAX_PERIOD_MS`.
const EBadPeriod: u64 = 9;
/// A price of zero was set for something that is meant to be sold.
const EZeroPrice: u64 = 10;
/// The tip is below the creator's minimum.
const EBelowMinTip: u64 = 11;
/// This content has no price and is therefore not for sale.
const EContentNotForSale: u64 = 12;
/// A creator may not pay their own vault.
const ESelfPayment: u64 = 13;
/// More was claimed than the balance holds.
const EInsufficientBalance: u64 = 14;
/// The subscription presented is for a different vault.
const ESubscriptionVaultMismatch: u64 = 15;
/// An empty tier name, or an empty content key. Neither can be audited.
const EEmptyName: u64 = 16;
/// `migrate` was called when the stored version already matches the package.
const ENotUpgraded: u64 = 17;

/// A tier term that is not a whole number of Seal content periods.
///
/// Access is released in fixed 30-day quanta by `entitlement::seal_approve_subscription`, while
/// tier terms used to be free-form from one day to ten years. A one-day tier bought in the 24
/// hours before a period boundary satisfied both of that function's time checks and released the
/// whole next 30-day period — thirty days of content for one day of payment — while the same tier
/// bought at any other time released nothing at all. The two models now agree by construction.
const EPeriodNotWholeSealPeriods: u64 = 18;

/// A tier priced out of order against its neighbours.
///
/// `entitlement::seal_approve_subscription` ranks access by `subscription.tier`, which is the
/// INDEX into `tiers`. Nothing tied that index to the price until 2026-09-01, so a cheap tier
/// added or repriced after the expensive ones outranked them and its subscribers could derive keys
/// for content they had not bought. Seal keys cannot be revoked, so there was no way back.
/// Enforced by `add_tier` and `update_tier` alike; the second was the one that made it reachable
/// by an ordinary repricing rather than only at launch.
const ETierPriceNotAscending: u64 = 19;

/// The subscription presented for renewal is held by somebody other than the payer.
///
/// `renew` used to raise `ESubscriptionVaultMismatch` (15) here, which told a caller that the
/// subscription belonged to a different vault when in fact it belonged to a different person.
/// The two refusals now carry different codes, so a client can tell "wrong vault" from
/// "not yours" without re-deriving the check.
const ENotSubscriber: u64 = 20;
/// A Seal identity that is not the one this vault, tier and period produce.
const EWrongIdentity: u64 = 21;
/// The tier asked for costs more than this subscription pays. C3 (2026-09-01): access is ranked
/// by the PRICE PAID, never by the tier index, so a cheap tier at a high index reads nothing above
/// its price — including on vaults whose tiers were ordered before `ETierPriceNotAscending`.
const ETierNotPaidFor: u64 = 22;
/// The period asked for is outside what this subscription paid for (see `entitlement::covers_period`).
const EPeriodNotPaid: u64 = 23;

// === Types ===

/// One purchasable subscription level.
public struct Tier has copy, drop, store {
    name: String,
    /// Price per period, in `T`'s minor units.
    price: u64,
    period_ms: u64,
    /// Retired tiers stay in the vector so existing subscribers keep a valid `tier` index.
    /// Removing one would renumber the rest and silently move every subscriber to a different
    /// price level.
    active: bool,
}

/// The creator's authority over exactly one vault.
public struct CreatorCap has key, store {
    id: UID,
    vault: ID,
}

/// A creator's economic object. Shared, so anyone can pay into it.
public struct CreatorVault<phantom T> has key {
    id: UID,
    version: u64,
    platform: ID,
    /// The creator's address. Where claimed earnings can be sent, and the identity that may not
    /// pay this vault.
    owner: address,
    /// The creator's `SocialAccount`, recorded so a vault can be traced to an identity.
    account: ID,

    // --- terms, snapshotted at creation ---
    fee_bps_snapshot: u64,
    referral_share_bps_snapshot: u64,

    // --- creator-set policy ---
    tiers: vector<Tier>,
    /// Content key -> price. Absence means "not for sale", which is the safe default: a post
    /// nobody priced cannot be bought for zero, it simply cannot be bought.
    content_prices: Table<vector<u8>, u64>,
    min_tip: u64,
    /// The creator's own switch. Independent of the platform's, and it likewise cannot block a
    /// claim — see `claim_earnings`.
    accepting: bool,

    // --- money ---
    /// The creator's, claimable with `CreatorCap`.
    earnings: Balance<T>,
    /// The platform's, claimable with `PlatformCap`.
    platform_fees: Balance<T>,

    // --- counters, for display only ---
    gross_volume: u64,
    subscriptions_sold: u64,
    unlocks_sold: u64,
    tips_received: u64,
}

// === Events ===

public struct VaultOpened has copy, drop {
    vault: ID,
    platform: ID,
    owner: address,
    account: ID,
    fee_bps_snapshot: u64,
    referral_share_bps_snapshot: u64,
}

/// Emitted on every settlement. The three legs plus the gross are all present so an indexer never
/// has to re-derive the split and risk deriving it differently from the contract.
public struct PaymentSettled has copy, drop {
    vault: ID,
    payer: address,
    kind: u8,
    gross: u64,
    creator_net: u64,
    platform_net: u64,
    referral_cut: u64,
    referrer: Option<address>,
}

public struct TiersUpdated has copy, drop {
    vault: ID,
    tier_count: u64,
}

public struct ContentPriced has copy, drop {
    vault: ID,
    content_key: vector<u8>,
    price: u64,
}

public struct ContentUnpriced has copy, drop {
    vault: ID,
    content_key: vector<u8>,
}

public struct EarningsClaimed has copy, drop {
    vault: ID,
    amount: u64,
    recipient: address,
}

public struct PlatformFeesClaimed has copy, drop {
    vault: ID,
    amount: u64,
    recipient: address,
}

public struct TermsAccepted has copy, drop {
    vault: ID,
    previous_fee_bps: u64,
    fee_bps: u64,
    previous_referral_share_bps: u64,
    referral_share_bps: u64,
}

public struct AcceptingSet has copy, drop {
    vault: ID,
    accepting: bool,
}

// === The split ===

/// Divide `gross` into (creator, platform, referrer).
///
/// Pure, public, and the single definition of this arithmetic. It is public so that a client can
/// call it to display a breakdown, and so a drift test in another language can assert its own
/// copy against it rather than against a number somebody transcribed.
///
/// The order of operations is load-bearing and must be mirrored exactly by any reimplementation:
/// multiply first, then floor-divide. Dividing first loses the remainder and disagrees with this
/// function at the last unit, which is enough to make an exact-amount check abort.
///
/// Intermediates are `u128`. `gross * fee_bps` overflows `u64` for a gross above roughly
/// 6.1e15 at the maximum fee — reachable for a six-decimal coin at around 6.1 billion units of
/// value, which is not a comfortable margin to rely on.
///
/// # `has_referrer` is a parameter rather than something the caller applies afterwards
///
/// When there is no referrer, the referral share does not disappear — it stays with the platform,
/// because it was carved out of the platform's cut in the first place. Folding it here rather than
/// leaving it to the caller is deliberate: the first version of this function returned the
/// proportional split and left `settle` to handle the absent-referrer case, and `settle` handled
/// it by paying the unclaimed share to the *creator*. Conservation still held, so every
/// sum-to-gross assertion passed; the money was simply going to the wrong party. Making the
/// condition an argument means there is exactly one place this can be got wrong, and it is tested.
///
/// The identity `creator + platform + referrer == gross` holds exactly, at every input, with no
/// rounding leak. That is a consequence of the shape rather than of the rounding: the creator's
/// share is defined as the *remainder* after the platform's cut, and the referrer's share is
/// carved out of that cut rather than taken separately from the gross. Nothing is computed twice
/// and compared.
public fun compute_split(
    gross: u64,
    fee_bps: u64,
    referral_share_bps: u64,
    has_referrer: bool,
): (u64, u64, u64) {
    let platform_fee = (((gross as u128) * (fee_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64;
    let referral_cut = if (has_referrer) {
        (((platform_fee as u128) * (referral_share_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64
    } else {
        0
    };

    let platform_net = platform_fee - referral_cut;
    let creator_net = gross - platform_fee;

    (creator_net, platform_net, referral_cut)
}

// === Opening a vault ===

/// Open a creator vault for coin type `T`.
///
/// The creator's `SocialAccount` is required, which is what ties a vault to a registered
/// identity: there is no way to open one anonymously, and the account cannot be transferred to
/// someone else afterwards.
///
/// Returns the `CreatorCap` and the change from the creation fee. The vault is shared here rather
/// than returned because a `CreatorVault` has no `store` and the caller could not share it
/// themselves.
public fun open_vault<T>(
    platform: &mut Platform,
    creator_account: &SocialAccount,
    payment: Coin<SUI>,
    ctx: &mut TxContext,
): (CreatorCap, Coin<SUI>) {
    platform.assert_can_create();

    let platform_id = object::id(platform);
    let owner = ctx.sender();
    account::assert_authenticates(creator_account, owner, platform_id);

    let change = platform.collect_creation_fee(payment, ctx);

    let vault = CreatorVault<T> {
        id: object::new(ctx),
        version: VERSION,
        platform: platform_id,
        owner,
        account: object::id(creator_account),
        fee_bps_snapshot: platform.fee_bps(),
        referral_share_bps_snapshot: platform.referral_share_bps(),
        tiers: vector[],
        content_prices: table::new(ctx),
        min_tip: 1,
        accepting: true,
        earnings: balance::zero(),
        platform_fees: balance::zero(),
        gross_volume: 0,
        subscriptions_sold: 0,
        unlocks_sold: 0,
        tips_received: 0,
    };
    let vault_id = object::id(&vault);

    event::emit(VaultOpened {
        vault: vault_id,
        platform: platform_id,
        owner,
        account: object::id(creator_account),
        fee_bps_snapshot: vault.fee_bps_snapshot,
        referral_share_bps_snapshot: vault.referral_share_bps_snapshot,
    });

    platform.record_vault_created();
    transfer::share_object(vault);

    (CreatorCap { id: object::new(ctx), vault: vault_id }, change)
}

// === Creator configuration ===

/// Add a tier. It must cost more than the one before it.
///
/// # Why price and rank cannot be separated
///
/// `entitlement::seal_approve_subscription` decides access with `subscription.tier >= tier`, and
/// `subscription.tier` is this vector's INDEX. The index is therefore the rank, and nothing here
/// tied the rank to the price until 2026-09-01.
///
/// A creator launching Basic at index 0 and VIP at index 1 and then adding a cheap Trial got it at
/// index 2, outranking both — and every Trial subscriber could derive VIP keys. Permanently, since
/// a Seal key cannot be revoked, and invisibly, since nothing in the flow said anything was wrong.
/// The creator had no way to see it coming and no way to undo it afterwards.
///
/// Strictly increasing rather than non-decreasing: two tiers at the same price would rank against
/// each other, and which one won would be an accident of the order they were created in.
///
/// Retired tiers still count. They keep their index so existing subscribers keep a valid `tier`,
/// which means they keep their rank, which means they must keep their place in the ordering.
public fun add_tier<T>(
    vault: &mut CreatorVault<T>,
    cap: &CreatorCap,
    name: String,
    price: u64,
    period_ms: u64,
) {
    assert_version(vault);
    assert_cap(vault, cap);
    assert!(vault.tiers.length() < MAX_TIERS, ETooManyTiers);
    assert!(name.as_bytes().length() > 0, EEmptyName);
    assert!(price > 0, EZeroPrice);
    assert!(period_ms >= MIN_PERIOD_MS && period_ms <= MAX_PERIOD_MS, EBadPeriod);
    assert!(period_ms % entitlement::seal_period_ms() == 0, EPeriodNotWholeSealPeriods);
    let n = vault.tiers.length();
    if (n > 0) {
        assert!(price > vault.tiers[n - 1].price, ETierPriceNotAscending);
    };

    vault.tiers.push_back(Tier { name, price, period_ms, active: true });
    event::emit(TiersUpdated { vault: object::id(vault), tier_count: vault.tiers.length() });
}

/// Reprice or retire a tier.
///
/// Existing subscribers are unaffected until they renew: their `Subscription` carries the price
/// they agreed, and `renew` charges the tier's price at the time of renewal. A creator can
/// therefore raise a price without retroactively charging anyone, and a subscriber can see the
/// new price before choosing to renew.
public fun update_tier<T>(
    vault: &mut CreatorVault<T>,
    cap: &CreatorCap,
    index: u64,
    price: u64,
    period_ms: u64,
    active: bool,
) {
    assert_version(vault);
    assert_cap(vault, cap);
    let n = vault.tiers.length();
    assert!(index < n, ENoSuchTier);
    assert!(price > 0, EZeroPrice);
    assert!(period_ms >= MIN_PERIOD_MS && period_ms <= MAX_PERIOD_MS, EBadPeriod);
    assert!(period_ms % entitlement::seal_period_ms() == 0, EPeriodNotWholeSealPeriods);
    // The ordering `add_tier` establishes has to survive a reprice. Inverting two prices here
    // would silently swap the ranks of everybody already subscribed to them — the same defect as
    // an out-of-order `add_tier`, reached from the other direction and easier to do by accident,
    // because repricing a tier reads like a pricing decision rather than an access one.
    if (index > 0) {
        assert!(price > vault.tiers[index - 1].price, ETierPriceNotAscending);
    };
    if (index + 1 < n) {
        assert!(price < vault.tiers[index + 1].price, ETierPriceNotAscending);
    };

    let tier = &mut vault.tiers[index];
    tier.price = price;
    tier.period_ms = period_ms;
    tier.active = active;

    event::emit(TiersUpdated { vault: object::id(vault), tier_count: vault.tiers.length() });
}

/// Put a piece of content up for sale at `price`.
public fun set_content_price<T>(
    vault: &mut CreatorVault<T>,
    cap: &CreatorCap,
    content_key: vector<u8>,
    price: u64,
) {
    assert_version(vault);
    assert_cap(vault, cap);
    assert!(content_key.length() > 0, EEmptyName);
    assert!(price > 0, EZeroPrice);

    if (vault.content_prices.contains(content_key)) {
        *vault.content_prices.borrow_mut(content_key) = price;
    } else {
        vault.content_prices.add(content_key, price);
    };

    event::emit(ContentPriced { vault: object::id(vault), content_key, price });
}

/// Withdraw content from sale. Existing `Unlock` objects remain valid — someone who has already
/// paid does not lose what they bought because the creator delisted it.
public fun unprice_content<T>(
    vault: &mut CreatorVault<T>,
    cap: &CreatorCap,
    content_key: vector<u8>,
) {
    assert_version(vault);
    assert_cap(vault, cap);
    assert!(vault.content_prices.contains(content_key), EContentNotForSale);

    vault.content_prices.remove(content_key);
    event::emit(ContentUnpriced { vault: object::id(vault), content_key });
}

public fun set_min_tip<T>(vault: &mut CreatorVault<T>, cap: &CreatorCap, min_tip: u64) {
    assert_version(vault);
    assert_cap(vault, cap);
    assert!(min_tip > 0, EZeroPrice);
    vault.min_tip = min_tip;
}

/// Stop or resume accepting payments into this vault.
///
/// Cannot block `claim_earnings`. A creator who closes their vault still gets their money.
public fun set_accepting<T>(vault: &mut CreatorVault<T>, cap: &CreatorCap, accepting: bool) {
    assert_version(vault);
    assert_cap(vault, cap);
    vault.accepting = accepting;
    event::emit(AcceptingSet { vault: object::id(vault), accepting });
}

/// Adopt the platform's current fee schedule.
///
/// Only the creator can call this, which is the whole safety argument: the platform cannot raise
/// a fee on an existing vault, and this function does not change that. It exists so a fee
/// *reduction* can reach vaults that already exist, which otherwise would keep paying the old
/// higher rate for ever. A creator adopting a worse schedule is doing so deliberately, with the
/// old and new values both emitted.
public fun accept_current_terms<T>(
    vault: &mut CreatorVault<T>,
    cap: &CreatorCap,
    platform: &Platform,
) {
    assert_version(vault);
    assert_cap(vault, cap);
    assert!(vault.platform == object::id(platform), EWrongPlatform);

    let previous_fee_bps = vault.fee_bps_snapshot;
    let previous_referral_share_bps = vault.referral_share_bps_snapshot;

    vault.fee_bps_snapshot = platform.fee_bps();
    vault.referral_share_bps_snapshot = platform.referral_share_bps();

    event::emit(TermsAccepted {
        vault: object::id(vault),
        previous_fee_bps,
        fee_bps: vault.fee_bps_snapshot,
        previous_referral_share_bps,
        referral_share_bps: vault.referral_share_bps_snapshot,
    });
}

// === Settlement ===

/// Split `payment` three ways and place every unit of it.
///
/// The creator's and platform's legs join balances held in this vault. The referrer's leg, if
/// any, is transferred to them immediately — a per-referrer ledger would need a table keyed by
/// address on every vault, and referral amounts are small and infrequent enough that an immediate
/// transfer is both cheaper and impossible to get wrong.
///
/// `payment` is consumed. There is no path out of this function that drops value.
fun settle<T>(
    vault: &mut CreatorVault<T>,
    payment: Coin<T>,
    payer: address,
    referrer: Option<address>,
    kind: u8,
    ctx: &mut TxContext,
) {
    let gross = payment.value();
    let has_referrer = referrer.is_some();
    let (creator_net, platform_net, referral_cut) = compute_split(
        gross,
        vault.fee_bps_snapshot,
        vault.referral_share_bps_snapshot,
        has_referrer,
    );

    let mut funds = payment.into_balance();

    // Referrer first, because it is the only leg that leaves the vault. Taking it from `funds`
    // before anything joins a stored balance keeps the arithmetic on one value.
    if (referral_cut > 0) {
        transfer::public_transfer(
            coin::from_balance(funds.split(referral_cut), ctx),
            *referrer.borrow(),
        );
    };

    vault.platform_fees.join(funds.split(platform_net));

    // Whatever remains is the creator's. Deliberately not `funds.split(creator_net)` followed by
    // destroying a supposedly-zero remainder: joining the rest makes the conservation of value
    // structural rather than something the arithmetic has to get exactly right.
    vault.earnings.join(funds);

    vault.gross_volume = vault.gross_volume + gross;

    event::emit(PaymentSettled {
        vault: object::id(vault),
        payer,
        kind,
        gross,
        creator_net,
        platform_net,
        // Already zero when there is no referrer — `compute_split` folds that case rather than
        // leaving it to be corrected here. The three legs always sum to `gross`.
        referral_cut,
        referrer,
    });
}

/// Shared preconditions for every paying entry point.
fun assert_payable<T>(
    platform: &Platform,
    vault: &CreatorVault<T>,
    buyer: &SocialAccount,
    ctx: &TxContext,
): address {
    assert_version(vault);
    platform.assert_can_pay();
    assert!(vault.platform == object::id(platform), EWrongPlatform);
    assert!(vault.accepting, ENotAccepting);

    let payer = ctx.sender();
    account::assert_authenticates(buyer, payer, vault.platform);
    // Self-payment is blocked because it would let a creator inflate `gross_volume` — a number
    // shown to prospective subscribers — at a cost of only the platform's cut.
    assert!(payer != vault.owner, ESelfPayment);

    payer
}

/// Take exactly `price` from `payment`, returning the change.
fun take_price<T>(payment: &mut Coin<T>, price: u64, ctx: &mut TxContext): Coin<T> {
    assert!(payment.value() >= price, EInsufficientPayment);
    payment.split(price, ctx)
}

// === Paying ===

/// Subscribe to `tier`, receiving a `Subscription` object.
///
/// Change is returned rather than absorbed: overpaying a subscription should not be a donation.
/// A caller who wants to give more should tip, which is a separate function that says so.
public fun subscribe<T>(
    platform: &Platform,
    vault: &mut CreatorVault<T>,
    buyer: &SocialAccount,
    tier_index: u64,
    mut payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    let payer = assert_payable(platform, vault, buyer, ctx);

    assert!(tier_index < vault.tiers.length(), ENoSuchTier);
    let tier = vault.tiers[tier_index];
    assert!(tier.active, ETierInactive);

    let due = take_price(&mut payment, tier.price, ctx);
    settle(vault, due, payer, buyer.referrer(), KIND_SUBSCRIPTION, ctx);

    vault.subscriptions_sold = vault.subscriptions_sold + 1;

    entitlement::new_subscription(
        object::id(vault),
        payer,
        tier_index,
        tier.price,
        tier.period_ms,
        clock,
        ctx,
    );

    payment
}

/// Extend an existing subscription by one period at the tier's current price.
public fun renew<T>(
    platform: &Platform,
    vault: &mut CreatorVault<T>,
    buyer: &SocialAccount,
    subscription: &mut Subscription,
    mut payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    let payer = assert_payable(platform, vault, buyer, ctx);

    assert!(entitlement::subscription_vault(subscription) == object::id(vault), ESubscriptionVaultMismatch);
    assert!(entitlement::subscriber(subscription) == payer, ENotSubscriber);

    let tier_index = entitlement::tier(subscription);
    assert!(tier_index < vault.tiers.length(), ENoSuchTier);
    let tier = vault.tiers[tier_index];
    assert!(tier.active, ETierInactive);

    let due = take_price(&mut payment, tier.price, ctx);
    settle(vault, due, payer, buyer.referrer(), KIND_RENEWAL, ctx);

    entitlement::extend(subscription, tier.price, tier.period_ms, clock);

    payment
}

/// Send the whole of `payment` to the creator as a tip.
public fun tip<T>(
    platform: &Platform,
    vault: &mut CreatorVault<T>,
    buyer: &SocialAccount,
    payment: Coin<T>,
    ctx: &mut TxContext,
) {
    let payer = assert_payable(platform, vault, buyer, ctx);
    assert!(payment.value() >= vault.min_tip, EBelowMinTip);

    settle(vault, payment, payer, buyer.referrer(), KIND_TIP, ctx);
    vault.tips_received = vault.tips_received + 1;
}

/// Buy permanent access to one piece of content, receiving an `Unlock`.
///
/// The price comes from the vault, not from the caller. A client-supplied price would let a buyer
/// name their own, and a client-supplied price checked against the vault would be the same read
/// done twice.
public fun unlock<T>(
    platform: &Platform,
    vault: &mut CreatorVault<T>,
    buyer: &SocialAccount,
    content_key: vector<u8>,
    mut payment: Coin<T>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    let payer = assert_payable(platform, vault, buyer, ctx);
    assert!(vault.content_prices.contains(content_key), EContentNotForSale);

    let price = *vault.content_prices.borrow(content_key);
    let due = take_price(&mut payment, price, ctx);
    settle(vault, due, payer, buyer.referrer(), KIND_UNLOCK, ctx);

    vault.unlocks_sold = vault.unlocks_sold + 1;

    entitlement::new_unlock(object::id(vault), payer, content_key, price, clock, ctx);

    payment
}

// === Claiming ===

/// Withdraw earnings.
///
/// Consults no pause switch — not the platform's, not the creator's own. This is the guarantee
/// that makes the rest of the switches safe to have.
///
/// There is no approval queue and no processing delay. The system this replaces made a creator
/// file a withdrawal request, decremented their balance immediately, and left an administrator to
/// pay them off-platform by hand; a rejected request credited the balance back, and a refund
/// issued against a creator with a zero balance was clawed back out of their *pending withdrawal*
/// at the buyer's gross rather than the creator's net — over-recovering the platform's own
/// commission from the creator. None of that machinery exists here because none of it can: the
/// money is already the creator's, in an object only their capability opens.
public fun claim_earnings<T>(
    vault: &mut CreatorVault<T>,
    cap: &CreatorCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert_version(vault);
    assert_cap(vault, cap);
    assert!(vault.earnings.value() >= amount, EInsufficientBalance);

    event::emit(EarningsClaimed { vault: object::id(vault), amount, recipient: ctx.sender() });

    coin::from_balance(vault.earnings.split(amount), ctx)
}

/// Withdraw the platform's accrued commission from this vault.
///
/// Per-vault rather than pooled. Sweeping many vaults is many transactions, which is the cost of
/// the guarantee that a creator's earnings and the platform's commission are never in the same
/// balance where an arithmetic error could pay one from the other.
public fun claim_platform_fees<T>(
    vault: &mut CreatorVault<T>,
    cap: &PlatformCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<T> {
    assert_version(vault);
    assert!(cap.cap_platform_id() == vault.platform, EWrongPlatform);
    assert!(vault.platform_fees.value() >= amount, EInsufficientBalance);

    event::emit(PlatformFeesClaimed { vault: object::id(vault), amount, recipient: ctx.sender() });

    coin::from_balance(vault.platform_fees.split(amount), ctx)
}

/// Bring a vault created under an older schema up to the current `VERSION`.
public fun migrate<T>(vault: &mut CreatorVault<T>, cap: &CreatorCap) {
    assert_cap(vault, cap);
    assert!(vault.version < VERSION, ENotUpgraded);
    vault.version = VERSION;
}

/// The same migration, reachable by the platform when the creator's cap is not.
///
/// # Why a second door is necessary rather than tidy
///
/// `CreatorCap` has `store`, so it can be transferred, sold, or simply lost, and `migrate` above
/// was the only way to advance a vault's stored version. Every entry point in this module begins
/// with `assert_version` — including `claim_earnings` and `claim_platform_fees`. So the moment a
/// new version ships, a creator who has lost their cap can no longer reach their own earnings
/// through the current package, AND the platform can no longer reach its commission from that
/// vault, because both claims run through the same version gate on the same object.
///
/// `stake_vault::migrate_as_platform` exists for exactly this reason and its comment says so. The
/// creator vault — which is where the subscription and content money actually sits — never got the
/// same door. That asymmetry is the whole finding.
///
/// This grants the platform nothing else. Version is the only field it touches; earnings, fees,
/// tiers, prices and the fee snapshot are all out of reach, and the version it migrates to is the
/// same one the creator's own `migrate` would have reached. It is deliberately not gated on
/// `assert_version`, because a vault already at the current version is the one case where there is
/// nothing to do — `ENotUpgraded` names that rather than silently succeeding.
public fun migrate_as_platform<T>(
    vault: &mut CreatorVault<T>,
    platform: &Platform,
    cap: &PlatformCap,
) {
    assert!(vault.platform == object::id(platform), EWrongPlatform);
    assert!(cap.cap_platform_id() == vault.platform, EWrongPlatform);
    assert!(vault.version < VERSION, ENotUpgraded);
    vault.version = VERSION;
}

// === Assertions ===

fun assert_version<T>(vault: &CreatorVault<T>) {
    assert!(vault.version == VERSION, EWrongVersion);
}

fun assert_cap<T>(vault: &CreatorVault<T>, cap: &CreatorCap) {
    assert!(cap.vault == object::id(vault), EWrongVault);
}

// === Reads ===

public fun cap_vault_id(cap: &CreatorCap): ID { cap.vault }

public fun version<T>(vault: &CreatorVault<T>): u64 { vault.version }

public fun owner<T>(vault: &CreatorVault<T>): address { vault.owner }

public fun account_id<T>(vault: &CreatorVault<T>): ID { vault.account }

public fun vault_platform_id<T>(vault: &CreatorVault<T>): ID { vault.platform }

public fun fee_bps_snapshot<T>(vault: &CreatorVault<T>): u64 { vault.fee_bps_snapshot }

public fun referral_share_bps_snapshot<T>(vault: &CreatorVault<T>): u64 {
    vault.referral_share_bps_snapshot
}

public fun accepting<T>(vault: &CreatorVault<T>): bool { vault.accepting }

public fun min_tip<T>(vault: &CreatorVault<T>): u64 { vault.min_tip }

/// Release the key for one creator-period to a subscriber who paid at least that tier's price.
///
/// # Ranked by price, not by index — C3
///
/// `entitlement::seal_approve_subscription` (retired) compared tier INDICES. The index only means
/// "more expensive" when the vault's prices ascend with it, which `add_tier` and `update_tier`
/// enforce since 2026-09-01 — but vaults opened before that carry a cheap tier above an expensive
/// one, and a 0.50 USDC subscriber was deriving 10 USDC keys. Seal keys are permanent, so the only
/// fix is a policy that is right for every vault regardless of order: the subscriber may read a
/// tier priced at or below what they paid per period, `Subscription.price_paid`, which
/// `subscribe` and `renew` write from the vault's own price.
///
/// # Why the vault is an argument
///
/// The tier's price lives in the vault, so the approval takes `&CreatorVault<T>` beside the
/// subscription. The key servers execute this with the reader as sender; the vault is shared and
/// read-only here. The subscription must belong to this vault, or a subscriber to a cheap vault
/// would present their subscription against an expensive one's prices.
///
/// # What did not change
///
/// The identity (`entitlement::period_identity(vault, tier, period)`), the period rule
/// (`entitlement::covers_period`) and the holder rule. Content sealed before this upgrade stays
/// readable by exactly the subscribers who paid for it; what closes is the cross-tier reach.
entry fun seal_approve_subscription<T>(
    id: vector<u8>,
    tier: u64,
    period: u64,
    vault: &CreatorVault<T>,
    subscription: &Subscription,
    ctx: &TxContext,
) {
    assert!(entitlement::subscriber(subscription) == ctx.sender(), ENotSubscriber);
    assert!(entitlement::subscription_vault(subscription) == object::id(vault), ESubscriptionVaultMismatch);
    assert!(id == entitlement::period_identity(object::id(vault), tier, period), EWrongIdentity);
    assert!(tier < vault.tiers.length(), ENoSuchTier);
    assert!(vault.tiers[tier].price <= entitlement::subscription_price_paid(subscription), ETierNotPaidFor);
    assert!(entitlement::covers_period(subscription, period), EPeriodNotPaid);
}

#[test_only]
/// Append a tier WITHOUT the ascending-price guard, to build the shape mainnet vaults opened before
/// `ETierPriceNotAscending` still have. Exists only so the price-ranked approval is tested against
/// the case it was written for; no production path can create this shape any more.
public fun add_tier_unordered_for_testing<T>(
    vault: &mut CreatorVault<T>,
    cap: &CreatorCap,
    name: String,
    price: u64,
    period_ms: u64,
) {
    assert_cap(vault, cap);
    vault.tiers.push_back(Tier { name, price, period_ms, active: true });
}

#[test_only]
public fun approve_subscription_for_testing<T>(
    id: vector<u8>,
    tier: u64,
    period: u64,
    vault: &CreatorVault<T>,
    subscription: &Subscription,
    ctx: &TxContext,
) {
    seal_approve_subscription(id, tier, period, vault, subscription, ctx)
}

public fun tier_count<T>(vault: &CreatorVault<T>): u64 { vault.tiers.length() }

public fun tier_price<T>(vault: &CreatorVault<T>, index: u64): u64 {
    assert!(index < vault.tiers.length(), ENoSuchTier);
    vault.tiers[index].price
}

public fun tier_period_ms<T>(vault: &CreatorVault<T>, index: u64): u64 {
    assert!(index < vault.tiers.length(), ENoSuchTier);
    vault.tiers[index].period_ms
}

public fun tier_active<T>(vault: &CreatorVault<T>, index: u64): bool {
    assert!(index < vault.tiers.length(), ENoSuchTier);
    vault.tiers[index].active
}

public fun tier_name<T>(vault: &CreatorVault<T>, index: u64): &String {
    assert!(index < vault.tiers.length(), ENoSuchTier);
    &vault.tiers[index].name
}

public fun is_for_sale<T>(vault: &CreatorVault<T>, content_key: vector<u8>): bool {
    vault.content_prices.contains(content_key)
}

/// The price of a piece of content. Aborts if it is not for sale — callers that do not know
/// should ask `is_for_sale` first, which is the read a storefront does anyway.
public fun content_price<T>(vault: &CreatorVault<T>, content_key: vector<u8>): u64 {
    assert!(vault.content_prices.contains(content_key), EContentNotForSale);
    *vault.content_prices.borrow(content_key)
}

public fun earnings_value<T>(vault: &CreatorVault<T>): u64 { vault.earnings.value() }

public fun platform_fees_value<T>(vault: &CreatorVault<T>): u64 { vault.platform_fees.value() }

public fun gross_volume<T>(vault: &CreatorVault<T>): u64 { vault.gross_volume }

public fun subscriptions_sold<T>(vault: &CreatorVault<T>): u64 { vault.subscriptions_sold }

public fun unlocks_sold<T>(vault: &CreatorVault<T>): u64 { vault.unlocks_sold }

public fun tips_received<T>(vault: &CreatorVault<T>): u64 { vault.tips_received }

public fun max_tiers(): u64 { MAX_TIERS }

public fun min_period_ms(): u64 { MIN_PERIOD_MS }

public fun max_period_ms(): u64 { MAX_PERIOD_MS }

public fun bps_denominator(): u64 { BPS_DENOMINATOR }

public fun kind_subscription(): u8 { KIND_SUBSCRIPTION }

public fun kind_renewal(): u8 { KIND_RENEWAL }

public fun kind_tip(): u8 { KIND_TIP }

public fun kind_unlock(): u8 { KIND_UNLOCK }
