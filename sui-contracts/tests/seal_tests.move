// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// The Seal policy: which key an entitlement is allowed to derive.
///
/// A Seal key server grants a share when one of these calls does not abort, and a key once derived
/// is permanent — there is no revoking it, no expiry on it, and no second check later. So every
/// property here is a property about something that cannot be undone, which is why the suite is
/// organised around what must *never* be approved rather than around what must.
///
/// The identity is the whole subject. Both functions already know who is asking and what they hold;
/// what they must also establish is that the bytes being requested are the bytes that entitlement
/// covers. A policy that checks the holder and not the identity approves a reader who bought
/// something cheap for the key to something expensive.
#[test_only]
module projectx_social::seal_tests;

use projectx_social::entitlement::{Self, Subscription, Unlock};
use sui::clock::{Self, Clock};
use sui::test_scenario::{Self as ts, Scenario};

const CREATOR: address = @0xC1;
const FAN: address = @0xFA;
const STRANGER: address = @0x5A;

const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const PERIOD_MS: u64 = 30 * 24 * 60 * 60 * 1000;

/// A vault id to gate against. Nothing here needs a real vault — the policy compares an `ID`.
fun vault_id(scenario: &mut Scenario): ID {
    ts::next_tx(scenario, CREATOR);
    let uid = object::new(ts::ctx(scenario));
    let id = uid.to_inner();
    uid.delete();
    id
}

fun clock_at(scenario: &mut Scenario, at_ms: u64): Clock {
    let mut c = clock::create_for_testing(ts::ctx(scenario));
    c.set_for_testing(at_ms);
    c
}

// === Unlocks ===

#[test]
fun unlock_approves_its_own_content() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(vault, FAN, b"issue-7", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);
    entitlement::approve_unlock_for_testing(
        entitlement::unlock_identity(vault, b"issue-7"),
        &unlock,
        ts::ctx(&mut scenario),
    );

    ts::return_to_sender(&scenario, unlock);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::ENotHolder)]
fun unlock_refuses_somebody_else_holding_it() {
    /*
      A reference proves possession of a reference. Owned objects are readable in a dry run, and the
      key server runs this with the *requester* as sender — so without this check, naming somebody
      else's unlock in the transaction would derive their key.
    */
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(vault, FAN, b"issue-7", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);

    ts::next_tx(&mut scenario, STRANGER);
    entitlement::approve_unlock_for_testing(
        entitlement::unlock_identity(vault, b"issue-7"),
        &unlock,
        ts::ctx(&mut scenario),
    );

    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EWrongIdentity)]
fun unlock_refuses_a_different_content_key() {
    // The defect this closes: an unlock for the cheap thing, presented for the key to the expensive
    // one. Holder and vault both check out; only the identity says no.
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(vault, FAN, b"cheap", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);
    entitlement::approve_unlock_for_testing(
        entitlement::unlock_identity(vault, b"expensive"),
        &unlock,
        ts::ctx(&mut scenario),
    );

    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EWrongIdentity)]
fun unlock_refuses_another_vault_with_the_same_content_key() {
    // Content keys are creator-chosen, so two creators will eventually pick the same one. The vault
    // prefix is what stops one creator's unlock deriving the other's key.
    let mut scenario = ts::begin(CREATOR);
    let mine = vault_id(&mut scenario);
    let theirs = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(mine, FAN, b"issue-1", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);
    entitlement::approve_unlock_for_testing(
        entitlement::unlock_identity(theirs, b"issue-1"),
        &unlock,
        ts::ctx(&mut scenario),
    );

    abort 0
}

#[test]
fun a_crafted_content_key_cannot_forge_a_subscription_identity() {
    /*
      The reason the tag byte exists.

      `content_key` is arbitrary bytes the creator chooses. Without a separator between the two
      namespaces, a creator could publish content under a key shaped like a subscription identity's
      tail — `tier ‖ period` — and the two identities would be byte-identical. One cheap unlock
      would then open a whole period of subscriber content.

      Asserted as inequality rather than by expecting an abort: the point is that these two can
      never *be* the same bytes, which is a property of the encoding rather than of a check.
    */
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);

    let tier = 1u64;
    let period = 600u64;

    // Everything a subscription identity has after the vault, offered as a content key.
    let mut forged = std::bcs::to_bytes(&tier);
    forged.append(std::bcs::to_bytes(&period));

    assert!(
        entitlement::unlock_identity(vault, forged)
            != entitlement::period_identity(vault, tier, period),
        0,
    );

    ts::end(scenario);
}

// === Subscriptions ===
//
// The policy for subscription keys moved to `creator::seal_approve_subscription` in v5 (2026-09-02)
// and is tested in `creator_tests.move` with real vaults: it ranks by the price paid, and the price
// lives in the vault. What stays here is the one property of the retired entry that matters.

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EDeprecatedApproval)]
fun the_retired_subscription_approval_releases_nothing() {
    // A valid subscription, a valid identity, the right sender — and still refused. An upgrade
    // cannot delete an entry function, so the retired one is closed rather than removed: a key
    // server that still called it would release nothing, which is the safe failure.
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 10 * PERIOD_MS);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let subscription = ts::take_from_sender<Subscription>(&scenario);
    entitlement::approve_subscription_for_testing(
        entitlement::period_identity(vault, 1, 10),
        1,
        10,
        &subscription,
        ts::ctx(&mut scenario),
    );

    abort 0
}

#[test]
fun covers_period_is_judged_at_the_period_start() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 10 * PERIOD_MS);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let subscription = ts::take_from_sender<Subscription>(&scenario);
    // Period 10 is paid for from its first millisecond; 9 is the back catalogue; 11 is after expiry.
    assert!(entitlement::covers_period(&subscription, 10));
    assert!(!entitlement::covers_period(&subscription, 9));
    assert!(!entitlement::covers_period(&subscription, 11));

    ts::return_to_sender(&scenario, subscription);
    clock.destroy_for_testing();
    ts::end(scenario);
}

// `subscription_refuses_a_period_that_is_not_the_one_in_the_identity` and
// `subscription_refuses_somebody_else_holding_it` moved to `creator_tests.move` with the policy
// (EWrongIdentity / ENotSubscriber there), 2026-09-02.

#[test]
fun periods_partition_time_at_a_fixed_width() {
    // The publisher stamps content with `period_of` and the policy compares against the same
    // arithmetic. If these ever disagree, every identity issued under the old boundary is stranded.
    let scenario = ts::begin(CREATOR);

    assert!(entitlement::period_of(0) == 0, 0);
    assert!(entitlement::period_of(PERIOD_MS - 1) == 0, 1);
    assert!(entitlement::period_of(PERIOD_MS) == 1, 2);
    assert!(entitlement::period_of(PERIOD_MS + DAY_MS) == 1, 3);

    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EExpired)]
/// `assert_subscribed` must refuse a subscription whose expiry has passed.
fun assert_subscribed_refuses_an_expired_subscription() {
    // The expiry check in `assert_subscribed` is a separate code path from the period checks
    // in `seal_approve_subscription` — both must be covered.
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 0);

    // A subscription covering period 0.
    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let subscription = ts::take_from_sender<Subscription>(&scenario);
    // Clock at PERIOD_MS + 1 ms: the subscription expired at PERIOD_MS.
    let mut later = clock_at(&mut scenario, PERIOD_MS + 1);
    entitlement::assert_subscribed(
        &subscription,
        vault,
        FAN,
        &later,
    );
    abort 0
}

// === The wire format ===

/*
  Concrete bytes, asserted here and asserted identically in TypeScript.

  `packages/sdk/src/seal.ts` re-implements `unlock_identity` and `period_identity`, because the
  encryptor is a TypeScript process and cannot call a Move function without a chain round trip on
  every upload. That is a second implementation of a byte layout — the exact defect this module's
  own comments warn about — and the only thing that makes it safe is a shared, concrete example.

  `packages/sdk/test/seal-identity.test.ts` asserts these same three vectors against the TypeScript.
  Neither suite proves the other correct alone; together they fail the moment the two disagree.

  So these literals are a contract between two languages, not a fixture. If a change here makes the
  TypeScript suite fail, the TypeScript is what has drifted — unless the change was deliberate, in
  which case both move together, in one commit, and every already-encrypted asset is stranded.
  There is no migration for an identity change: a Seal key is derived from these bytes, so different
  bytes are a different key, and the old ciphertext stays shut for ever.
*/
#[test]
fun the_identity_bytes_are_exactly_these() {
    let vault = object::id_from_address(
        @0x00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff,
    );

    // <vault, 32 bytes> ‖ 0x00 ‖ "issue-7"
    assert!(
        entitlement::unlock_identity(vault, b"issue-7") ==
            x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0069737375652d37",
        0,
    );

    // <vault, 32 bytes> ‖ 0x01 ‖ <tier 3, u64 LE> ‖ <period 5, u64 LE>
    assert!(
        entitlement::period_identity(vault, 3, 5) ==
            x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff0103000000000000000500000000000000",
        1,
    );

    // An empty content key still carries the tag byte, so it can never collide with a subscription
    // identity's 0x01 — the shortest unlock identity is 33 bytes, not 32.
    assert!(
        entitlement::unlock_identity(vault, b"") ==
            x"00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff00",
        2,
    );
}

#[test]
/// The period arithmetic the TypeScript must reproduce, including both sides of a boundary.
fun the_period_arithmetic_is_exactly_this() {
    assert!(entitlement::seal_period_ms() == 2_592_000_000, 0);
    assert!(entitlement::period_of(0) == 0, 1);
    // One millisecond before the first boundary is still period 0. Integer division, so a
    // floating-point reimplementation that rounds instead of truncating disagrees here.
    assert!(entitlement::period_of(2_591_999_999) == 0, 2);
    assert!(entitlement::period_of(2_592_000_000) == 1, 3);
    assert!(entitlement::period_of(2_592_000_001) == 1, 4);
}

#[test]
/// A renewal after a lapse must not hand over the months nobody paid for.
///
/// `covers_period` grants a period inside `[started_at_ms, expires_at_ms)`, and until
/// 2026-09-01 `extend` moved only the far end of that pair. Subscribe at period 10, stop, come
/// back at period 30 and pay for one period, and the window became periods 10 to 31 — twenty
/// unpaid periods, derivable permanently, for one period's price. Here period 20 sits squarely in
/// the gap and must be refused.
fun a_renewal_after_a_lapse_does_not_open_the_gap() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let mut clock = clock_at(&mut scenario, 10 * PERIOD_MS);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let mut subscription = ts::take_from_sender<Subscription>(&scenario);

    // Twenty periods later, long lapsed, one period bought.
    clock.set_for_testing(30 * PERIOD_MS);
    entitlement::extend_for_testing(&mut subscription, 1, PERIOD_MS, &clock);

    assert!(!entitlement::covers_period(&subscription, 20));
    assert!(entitlement::covers_period(&subscription, 30));

    ts::return_to_sender(&scenario, subscription);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test]
/// And the renewal must still buy what it paid for. The same lapse, the same renewal, asking for
/// the period the payment actually covers — this must be granted, or the fix has simply broken
/// renewals instead of fixing them.
fun a_renewal_after_a_lapse_still_buys_the_period_it_paid_for() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let mut clock = clock_at(&mut scenario, 10 * PERIOD_MS);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let mut subscription = ts::take_from_sender<Subscription>(&scenario);

    clock.set_for_testing(30 * PERIOD_MS);
    entitlement::extend_for_testing(&mut subscription, 1, PERIOD_MS, &clock);

    assert!(entitlement::covers_period(&subscription, 30));

    ts::return_to_sender(&scenario, subscription);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test]
/// An UNBROKEN renewal keeps the back catalogue. The lapse rule must fire on a gap and only on a
/// gap — a subscriber who renews on time has paid for every period since they started and must
/// keep being able to derive them.
fun an_unbroken_renewal_keeps_every_period_it_paid_for() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let mut clock = clock_at(&mut scenario, 10 * PERIOD_MS);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let mut subscription = ts::take_from_sender<Subscription>(&scenario);

    // Renew inside the paid term, twice, so the term runs 10 through 13 with no gap in it.
    clock.set_for_testing(10 * PERIOD_MS + PERIOD_MS / 2);
    entitlement::extend_for_testing(&mut subscription, 1, PERIOD_MS, &clock);
    clock.set_for_testing(11 * PERIOD_MS + PERIOD_MS / 2);
    entitlement::extend_for_testing(&mut subscription, 1, PERIOD_MS, &clock);

    // Period 10 is the first one, bought before either renewal, and it must still be derivable.
    assert!(entitlement::covers_period(&subscription, 10));
    assert!(entitlement::covers_period(&subscription, 12));
    assert!(!entitlement::covers_period(&subscription, 13));

    ts::return_to_sender(&scenario, subscription);
    clock.destroy_for_testing();
    ts::end(scenario);
}

// === The aborting access rules ===
//
// `assert_subscribed` and `assert_unlocked` are the aborting twins of `is_active` and `unlocks`:
// public, and the predicate any on-chain surface that gates content is meant to call. Until
// 2026-09-01 the second had never been called by a test at all, and the mutation sweep deleted
// every assert in both with the suite still green. A guard that is written must be called, and
// something must prove it.

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::ENotHolder)]
/// Kills entitlement.move:253 — `assert_subscribed` for somebody who does not hold it.
fun assert_subscribed_refuses_somebody_else() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 0);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let subscription = ts::take_from_sender<Subscription>(&scenario);
    entitlement::assert_subscribed(&subscription, vault, STRANGER, &clock);
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EWrongVault)]
/// Kills entitlement.move:254 — `assert_subscribed` against a vault that did not issue it.
fun assert_subscribed_refuses_another_vault() {
    let mut scenario = ts::begin(CREATOR);
    let mine = vault_id(&mut scenario);
    let theirs = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 0);

    entitlement::mint_subscription_for_testing(
        mine, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let subscription = ts::take_from_sender<Subscription>(&scenario);
    entitlement::assert_subscribed(&subscription, theirs, FAN, &clock);
    abort 0
}

#[test]
/// The accepted side of entitlement.move:255 — one millisecond before expiry is still subscribed.
fun assert_subscribed_accepts_the_last_millisecond() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 0);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let subscription = ts::take_from_sender<Subscription>(&scenario);
    assert!(entitlement::expires_at_ms(&subscription) == PERIOD_MS, 0);
    let last = clock_at(&mut scenario, PERIOD_MS - 1);
    entitlement::assert_subscribed(&subscription, vault, FAN, &last);

    ts::return_to_sender(&scenario, subscription);
    last.destroy_for_testing();
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EExpired)]
/// Kills the entitlement.move:255 boundary. `expires_at_ms` is exclusive, so the expiry millisecond
/// itself is expired. `assert_subscribed_refuses_an_expired_subscription` sits one millisecond
/// later and cannot see a `<` become `<=`; this one can.
fun assert_subscribed_refuses_the_expiry_millisecond() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 0);

    entitlement::mint_subscription_for_testing(
        vault, FAN, 1, PERIOD_MS, &clock, ts::ctx(&mut scenario),
    );

    ts::next_tx(&mut scenario, FAN);
    let subscription = ts::take_from_sender<Subscription>(&scenario);
    let expiry = clock_at(&mut scenario, PERIOD_MS);
    entitlement::assert_subscribed(&subscription, vault, FAN, &expiry);
    abort 0
}

#[test]
/// `assert_unlocked` accepts its own content. The first call any test has made to it.
fun assert_unlocked_accepts_its_own_content() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(vault, FAN, b"issue-7", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);
    entitlement::assert_unlocked(&unlock, vault, FAN, b"issue-7");

    ts::return_to_sender(&scenario, unlock);
    clock.destroy_for_testing();
    ts::end(scenario);
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::ENotHolder)]
/// Kills entitlement.move:268 — `assert_unlocked` for somebody who does not hold it.
fun assert_unlocked_refuses_somebody_else() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(vault, FAN, b"issue-7", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);
    entitlement::assert_unlocked(&unlock, vault, STRANGER, b"issue-7");
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EWrongVault)]
/// Kills entitlement.move:269 — `assert_unlocked` against a vault that did not issue it.
fun assert_unlocked_refuses_another_vault() {
    let mut scenario = ts::begin(CREATOR);
    let mine = vault_id(&mut scenario);
    let theirs = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(mine, FAN, b"issue-7", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);
    entitlement::assert_unlocked(&unlock, theirs, FAN, b"issue-7");
    abort 0
}

#[test]
#[expected_failure(abort_code = ::projectx_social::entitlement::EWrongContent)]
/// Kills entitlement.move:270 — an unlock for the cheap thing presented for the expensive one.
/// Holder and vault both check out; only the content key says no.
fun assert_unlocked_refuses_a_different_content_key() {
    let mut scenario = ts::begin(CREATOR);
    let vault = vault_id(&mut scenario);
    let clock = clock_at(&mut scenario, 1_000);

    entitlement::mint_unlock_for_testing(vault, FAN, b"cheap", &clock, ts::ctx(&mut scenario));

    ts::next_tx(&mut scenario, FAN);
    let unlock = ts::take_from_sender<Unlock>(&scenario);
    entitlement::assert_unlocked(&unlock, vault, FAN, b"expensive");
    abort 0
}
