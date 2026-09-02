// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/// What a payment buys: subscriptions and one-off content unlocks.
///
/// # Why entitlement is an object rather than a query
///
/// In the platform this replaces, the answer to "may this person see this post" was a chain of
/// `@if` conditions repeated six times inside one Blade template, with a seventh, independently
/// written copy of the same predicate in the controller that streams video. Two copies of a rule
/// drift; these had, and the result was that locked images were served to anyone who knew the
/// filename because one of the copies did not check at all.
///
/// Here the entitlement **is** an object the buyer holds. There is one rule, it is
/// `is_active`, and every surface that gates content calls it. A renderer cannot forget to check,
/// because without the object there is nothing to render from.
///
/// # Why entitlements are soulbound
///
/// `Subscription` and `Unlock` both have `key` without `store`. A transferable subscription is a
/// subscription that can be rented: one buyer, many viewers, sequentially, for as long as the
/// period lasts. A transferable unlock is a resale market for content the creator sold once.
/// Neither is a hypothetical — both are the obvious first thing to try — and the type system
/// closes both without a runtime check.
///
/// # Expiry is a timestamp, not a job
module projectx_social::entitlement;

use sui::clock::Clock;
use sui::event;

// === Errors ===

/// The entitlement presented belongs to a different holder than the transaction sender.
const ENotHolder: u64 = 1;
/// The entitlement presented was issued by a different creator vault.
const EWrongVault: u64 = 2;
/// The entitlement has expired.
const EExpired: u64 = 3;
/// The unlock presented is for different content.
const EWrongContent: u64 = 4;

// === Types ===

/// A time-bounded right to a creator's subscriber-only content. Soulbound.
public struct Subscription has key {
    id: UID,
    /// The creator vault this subscribes to. Prevents one creator's subscription from
    /// authenticating against another's content.
    vault: ID,
    subscriber: address,
    /// Index into the vault's tier list at the time of purchase.
    tier: u64,
    /// The price actually paid per period, recorded so a renewal cannot be silently repriced
    /// and so a client can show what the next renewal will cost without trusting its own cache.
    price_paid: u64,
    started_at_ms: u64,
    expires_at_ms: u64,
    /// How many times this subscription has been renewed. Zero on first purchase.
    renewals: u64,
}

/// A permanent right to one piece of content. Soulbound.
///
/// Permanent because it is a purchase, not a rental. A pay-per-view that expired would be a
/// subscription with extra steps, and the buyer was not told they were renting.
public struct Unlock has key {
    id: UID,
    vault: ID,
    buyer: address,
    /// Opaque content identifier, matched byte-for-byte. The contract never interprets it — it
    /// is whatever the application uses to name a post, a message, or a stored blob.
    content_key: vector<u8>,
    price_paid: u64,
    purchased_at_ms: u64,
}

// === Events ===

public struct SubscriptionStarted has copy, drop {
    subscription: ID,
    vault: ID,
    subscriber: address,
    tier: u64,
    price_paid: u64,
    expires_at_ms: u64,
}

public struct SubscriptionRenewed has copy, drop {
    subscription: ID,
    vault: ID,
    subscriber: address,
    price_paid: u64,
    expires_at_ms: u64,
    renewals: u64,
}

public struct ContentUnlocked has copy, drop {
    unlock: ID,
    vault: ID,
    buyer: address,
    content_key: vector<u8>,
    price_paid: u64,
}

// === Construction ===
//
// `public(package)` throughout: only `creator` mints these, and only after money has actually
// moved. An entitlement that could be constructed by any caller would be a free subscription.

public(package) fun new_subscription(
    vault: ID,
    subscriber: address,
    tier: u64,
    price_paid: u64,
    period_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let now = clock.timestamp_ms();
    let subscription = Subscription {
        id: object::new(ctx),
        vault,
        subscriber,
        tier,
        price_paid,
        started_at_ms: now,
        expires_at_ms: now + period_ms,
        renewals: 0,
    };

    event::emit(SubscriptionStarted {
        subscription: object::id(&subscription),
        vault,
        subscriber,
        tier,
        price_paid,
        expires_at_ms: subscription.expires_at_ms,
    });

    transfer::transfer(subscription, subscriber);
}

/// Extend a subscription by one period.
///
/// Extends from whichever is later: now, or the current expiry. Renewing early therefore adds a
/// full period rather than resetting the clock and discarding the time already paid for — the
/// opposite behaviour silently confiscates whatever remained.
///
/// # A renewal after a lapse restarts the term
///
/// `seal_approve_subscription` grants a period when `started_at_ms <= period_start <
/// expires_at_ms`. That is one contiguous window, and it is the only shape this struct can hold —
/// a Move upgrade cannot add a field, so there is nowhere to record a set of paid intervals with
/// a gap in it.
///
/// Until 2026-09-01 `extend` moved only the far end of that window. Subscribe in January, stop
/// paying, come back eleven months later and pay for one month, and the window became the whole
/// eleven months: every period in the gap satisfied both bounds. One month's price bought a year
/// of back catalogue, and because a Seal key once derived cannot be revoked, the creator had no
/// way to undo it.
///
/// So a renewal that arrives after the subscription has actually lapsed moves the near end too.
/// The subscriber keeps every key they already derived — nothing is taken back, because nothing
/// can be — but they cannot derive new keys for periods they did not pay for, including the ones
/// before the gap. That is deliberately the under-granting direction, the same one
/// `seal_approve_subscription` already chose for the same reason: over-granting a permanent key is
/// irreversible, and under-granting has a remedy the creator already has, which is to sell the
/// missing periods as `Unlock`s.
public(package) fun extend(
    subscription: &mut Subscription,
    price_paid: u64,
    period_ms: u64,
    clock: &Clock,
) {
    let now = clock.timestamp_ms();
    let lapsed = now > subscription.expires_at_ms;
    let base = if (subscription.expires_at_ms > now) { subscription.expires_at_ms } else { now };

    if (lapsed) { subscription.started_at_ms = now };
    subscription.expires_at_ms = base + period_ms;
    subscription.price_paid = price_paid;
    subscription.renewals = subscription.renewals + 1;

    event::emit(SubscriptionRenewed {
        subscription: object::id(subscription),
        vault: subscription.vault,
        subscriber: subscription.subscriber,
        price_paid,
        expires_at_ms: subscription.expires_at_ms,
        renewals: subscription.renewals,
    });
}

public(package) fun new_unlock(
    vault: ID,
    buyer: address,
    content_key: vector<u8>,
    price_paid: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let unlock = Unlock {
        id: object::new(ctx),
        vault,
        buyer,
        content_key,
        price_paid,
        purchased_at_ms: clock.timestamp_ms(),
    };

    event::emit(ContentUnlocked {
        unlock: object::id(&unlock),
        vault,
        buyer,
        content_key: unlock.content_key,
        price_paid,
    });

    transfer::transfer(unlock, buyer);
}

// === The access rules ===
//
// These four functions are the whole authorisation surface. Anything that gates content calls one
// of them; nothing reimplements the predicate.

/// Is this subscription currently valid for this vault and this holder?
///
/// Returns a bool rather than aborting, because a feed renderer asks this about many creators at
/// once and most answers are legitimately "no". Use `assert_subscribed` where the answer must be
/// yes for the transaction to make sense.
public fun is_active(
    subscription: &Subscription,
    vault: ID,
    holder: address,
    clock: &Clock,
): bool {
    subscription.vault == vault &&
    subscription.subscriber == holder &&
    clock.timestamp_ms() < subscription.expires_at_ms
}

/// Abort unless this subscription is valid. Names the specific failure rather than one generic
/// "denied", so a client can tell "you never subscribed" from "your subscription lapsed" — which
/// are different messages to show a user and different things for them to do next.
public fun assert_subscribed(
    subscription: &Subscription,
    vault: ID,
    holder: address,
    clock: &Clock,
) {
    assert!(subscription.subscriber == holder, ENotHolder);
    assert!(subscription.vault == vault, EWrongVault);
    assert!(clock.timestamp_ms() < subscription.expires_at_ms, EExpired);
}

public fun unlocks(unlock: &Unlock, vault: ID, holder: address, content_key: vector<u8>): bool {
    unlock.vault == vault && unlock.buyer == holder && unlock.content_key == content_key
}

public fun assert_unlocked(
    unlock: &Unlock,
    vault: ID,
    holder: address,
    content_key: vector<u8>,
) {
    assert!(unlock.buyer == holder, ENotHolder);
    assert!(unlock.vault == vault, EWrongVault);
    assert!(unlock.content_key == content_key, EWrongContent);
}

// === Reads ===

public fun subscription_vault(s: &Subscription): ID { s.vault }

public fun subscriber(s: &Subscription): address { s.subscriber }

public fun tier(s: &Subscription): u64 { s.tier }

public fun subscription_price_paid(s: &Subscription): u64 { s.price_paid }

public fun started_at_ms(s: &Subscription): u64 { s.started_at_ms }

public fun expires_at_ms(s: &Subscription): u64 { s.expires_at_ms }

public fun renewals(s: &Subscription): u64 { s.renewals }

public fun unlock_vault(u: &Unlock): ID { u.vault }

public fun buyer(u: &Unlock): address { u.buyer }

public fun content_key(u: &Unlock): &vector<u8> { &u.content_key }

public fun unlock_price_paid(u: &Unlock): u64 { u.price_paid }

public fun purchased_at_ms(u: &Unlock): u64 { u.purchased_at_ms }

// === Seal: deriving a decryption key from an entitlement ===

// Seal key servers grant a share only if a call whose name begins `seal_approve` does not abort.
// They execute it with the reader as sender, so `ctx.sender()` is the person asking — the same
// predicate the rest of this module already enforces, reached from a different direction.
//
// # The identity is what a key is derived for
//
// It must be namespaced by something the policy controls, or two creators sharing this package
// could derive each other's keys. Every identity here begins with the vault id.
//
//   unlock        <vault> ‖ 0x00 ‖ <content key>
//   subscription  <vault> ‖ 0x01 ‖ <tier, u64 LE> ‖ <period, u64 LE>
//
// The tag byte is not decoration. `content_key` is arbitrary creator-supplied bytes, so without a
// separator a creator could publish under the content key `0x01 ‖ tier ‖ period` and make an
// unlock-gated identity byte-identical to a subscription-gated one — then sell one cheap unlock
// that opens a whole period of subscriber content.

/// Identity tags. One byte, and the two must never collide.
const SEAL_UNLOCK: u8 = 0;
const SEAL_SUBSCRIPTION: u8 = 1;

/// The window one subscription identity covers.
///
/// Thirty days, fixed. It cannot be changed later without re-partitioning every identity ever
/// issued and stranding keys on both sides of the change, so it is a constant rather than a
/// parameter somebody could pass differently on a Tuesday.
const PERIOD_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// The identity requested is not the one this entitlement covers.
const EWrongIdentity: u64 = 5;
/// The period requested falls outside what this subscription paid for.
const EPeriodNotPaid: u64 = 6;
/// The subscription is of a lower tier than the content requested.
const ETierTooLow: u64 = 7;
/// `seal_approve_subscription` in this module is retired: subscription keys are released by
/// `creator::seal_approve_subscription`, which ranks by the price paid rather than the tier index.
const EDeprecatedApproval: u64 = 8;

/// The identity a single piece of priced content is encrypted to.
///
/// Public because the client must build the same bytes to encrypt, and two implementations of a
/// byte layout drift. A client can call this to check its own encoder rather than trusting it.
public fun unlock_identity(vault: ID, content_key: vector<u8>): vector<u8> {
    let mut identity = object::id_to_bytes(&vault);
    identity.push_back(SEAL_UNLOCK);
    identity.append(content_key);
    identity
}

/// The identity one creator-period at one tier is encrypted to.
public fun period_identity(vault: ID, tier: u64, period: u64): vector<u8> {
    let mut identity = object::id_to_bytes(&vault);
    identity.push_back(SEAL_SUBSCRIPTION);
    identity.append(std::bcs::to_bytes(&tier));
    identity.append(std::bcs::to_bytes(&period));
    identity
}

/// Which period a moment falls in. The publisher stamps content with this; the check below reads it.
/// The width of a Seal content period. Exposed so `creator` can require tier terms to be whole
/// multiples of it rather than copying the number — a copied constant is exactly how these two
/// drifted apart: tiers could be sold by the day while access was granted by the month.
public fun seal_period_ms(): u64 { PERIOD_MS }

public fun period_of(timestamp_ms: u64): u64 {
    timestamp_ms / PERIOD_MS
}

/// Grant the key for one piece of content to whoever holds a matching `Unlock`.
///
/// Two checks and both are load-bearing. The holder must be the sender — a reference proves
/// possession of a reference, not of the object's rights. And the identity must be the one this
/// unlock covers, or a reader holding an unlock for something cheap would request the key for
/// something expensive and pass the first check on the way.
entry fun seal_approve_unlock(id: vector<u8>, unlock: &Unlock, ctx: &TxContext) {
    assert!(unlock.buyer == ctx.sender(), ENotHolder);
    assert!(id == unlock_identity(unlock.vault, unlock.content_key), EWrongIdentity);
}

/// Grant the key for one creator-period to a subscriber who paid for that period.
///
/// # Why there is no `Clock` here
///
/// A Seal key, once derived, is permanent. Requiring the subscription to be *currently* active
/// would therefore control nothing — a subscriber could fetch every key the day before lapsing and
/// keep them — while punishing the one who simply did not open the app in time. What is enforced
/// instead is the honest rule: the period must be one they paid for. Nothing before their
/// subscription started, nothing after it expires, whether or not that expiry has passed yet.
///
/// # Why the tier is a comparison and not an equality
///
/// A subscriber at a higher tier reads everything at and below it. Equality would mean upgrading a
/// subscription silently revoked access to the content the lower tier had been buying.
entry fun seal_approve_subscription(
    id: vector<u8>,
    tier: u64,
    period: u64,
    subscription: &Subscription,
    ctx: &TxContext,
) {
    /*
      RETIRED in v5 (2026-09-02), and it aborts unconditionally.

      This ranked access by `subscription.tier >= tier`, an INDEX comparison. The ordering that made
      an index comparison mean "at least as expensive" was only enforced from 2026-09-01
      (`creator::ETierPriceNotAscending`), and vaults opened before that exist on mainnet with a
      cheap tier at a higher index than an expensive one. Under this function a 0.50 USDC
      subscriber derived keys for 10 USDC content, and a derived Seal key is permanent.

      The replacement is `creator::seal_approve_subscription<T>`, which takes the vault and ranks
      by the PRICE the subscriber paid against the price of the tier being asked for. The body here
      cannot be removed — an upgrade may not delete an entry function — so it is closed: any call
      aborts before reading anything, and the key servers release nothing through it.
    */
    let _ = id;
    let _ = tier;
    let _ = period;
    let _ = subscription;
    let _ = ctx;
    abort EDeprecatedApproval
    // Binds `tier` and `period` to the identity: they cannot name one period and be checked
    // against another, because the bytes would not match.
}

/// Is `period` one this subscription paid for? The rule the retired approval used, kept here as
/// the one place it is written so `creator::seal_approve_subscription` cannot drift from it.
///
/// Judged at the period's start rather than by overlap. Overlap would grant a whole period to
/// somebody subscribed for one day of it — a day's payment buying two periods of content at the
/// boundaries. Judging by the start under-grants instead: a subscriber who joins mid-period gets
/// the next one, not the one already running. That is the safe direction, because a key once
/// derived cannot be taken back, and the creator can always sell the missing period as an `Unlock`.
public fun covers_period(subscription: &Subscription, period: u64): bool {
    let period_start = period * PERIOD_MS;
    subscription.started_at_ms <= period_start && period_start < subscription.expires_at_ms
}

/// Whether `ETierTooLow` can still be raised: it cannot, and it is kept only so its number is
/// never reused by a different meaning. `ETierTooLow` and `EPeriodNotPaid` remain named for the
/// mirrors that decode historic aborts.
public fun tier_too_low_code(): u64 { ETierTooLow }
public fun period_not_paid_code(): u64 { EPeriodNotPaid }
public fun deprecated_approval_code(): u64 { EDeprecatedApproval }

/*
  Test seams.

  The `seal_approve*` functions are `entry` and not `public`, which is what Seal asks for and keeps
  them out of the package's public surface — but it also means no other module can call them, and a
  test module is another module. These wrappers exist only under `#[test_only]`, so the policy is
  exercised exactly as written rather than through a re-implementation that could drift from it.
*/
#[test_only]
public fun approve_unlock_for_testing(id: vector<u8>, unlock: &Unlock, ctx: &TxContext) {
    seal_approve_unlock(id, unlock, ctx)
}

#[test_only]
public fun approve_subscription_for_testing(
    id: vector<u8>,
    tier: u64,
    period: u64,
    subscription: &Subscription,
    ctx: &TxContext,
) {
    seal_approve_subscription(id, tier, period, subscription, ctx)
}

#[test_only]
public fun mint_subscription_for_testing(
    vault: ID,
    subscriber: address,
    tier: u64,
    period_ms: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    new_subscription(vault, subscriber, tier, 0, period_ms, clock, ctx)
}

#[test_only]
/// `extend` is `public(package)`, so the lapse rule can only be exercised from another module
/// through a seam. It calls the real function rather than restating it, so a change to the rule
/// moves the test with it instead of leaving the test asserting a copy.
public fun extend_for_testing(
    subscription: &mut Subscription,
    price_paid: u64,
    period_ms: u64,
    clock: &Clock,
) {
    extend(subscription, price_paid, period_ms, clock)
}

#[test_only]
public fun mint_unlock_for_testing(
    vault: ID,
    buyer: address,
    content_key: vector<u8>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    new_unlock(vault, buyer, content_key, 0, clock, ctx)
}
