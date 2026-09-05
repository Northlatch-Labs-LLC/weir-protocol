// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// Tests for the encryption key registry.
///
/// The property that matters most is not tested here and cannot be: there is no function that
/// writes an entry for anyone other than the sender, so a test that tried to publish Bob's key as
/// Alice would not compile. The substitution attack is absent from the interface rather than
/// rejected inside it, and the compiler is what enforces that on every build.
///
/// What is tested is everything a runtime check decides: the length and degeneracy rules on both
/// sides of their boundary, that rotation advances a version and a republish does not, that revoke
/// leaves an address indistinguishable from one that never published, and that the two read shapes
/// disagree in the way they are supposed to.
#[test_only]
module projectx_social::key_registry_tests;

use projectx_social::key_registry::{Self, KeyRegistry};
use sui::clock;
use sui::test_scenario::{Self as ts, Scenario};

const ALICE: address = @0xA1;
const BOB: address = @0xB0;

/// A plausible key. Not a real X25519 point — nothing on chain does curve arithmetic, so the only
/// properties that matter to this module are its length and that it is not all zeros.
fun key_a(): vector<u8> {
    let mut k = vector::empty<u8>();
    let mut i = 0;
    while (i < 32) { k.push_back(((i + 1) as u8)); i = i + 1; };
    k
}

fun key_b(): vector<u8> {
    let mut k = vector::empty<u8>();
    let mut i = 0;
    while (i < 32) { k.push_back(((200 - i) as u8)); i = i + 1; };
    k
}

fun zeros(n: u64): vector<u8> {
    let mut k = vector::empty<u8>();
    let mut i = 0;
    while (i < n) { k.push_back(0); i = i + 1; };
    k
}

fun setup(): Scenario {
    let mut sc = ts::begin(ALICE);
    { key_registry::init_for_testing(sc.ctx()); };
    sc
}

fun publish_as(sc: &mut Scenario, who: address, key: vector<u8>, at_ms: u64) {
    sc.next_tx(who);
    let mut registry = sc.take_shared<KeyRegistry>();
    let mut clk = clock::create_for_testing(sc.ctx());
    clk.set_for_testing(at_ms);
    key_registry::publish(&mut registry, key, &clk, sc.ctx());
    clk.destroy_for_testing();
    ts::return_shared(registry);
}

#[test]
fun publishes_a_key_and_reads_it_back() {
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::has_key(&registry, ALICE), 0);
        assert!(key_registry::key_of(&registry, ALICE) == key_a(), 1);
        assert!(key_registry::version_of(&registry, ALICE) == 1, 2);
        assert!(key_registry::updated_at_ms_of(&registry, ALICE) == 1_000, 3);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun an_address_that_never_published_has_nothing() {
    // The state a sender must be able to distinguish from "encrypted is unavailable right now".
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(!key_registry::has_key(&registry, BOB), 0);
        assert!(key_registry::try_key_of(&registry, BOB).is_none(), 1);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun each_address_publishes_only_its_own() {
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);
    publish_as(&mut sc, BOB, key_b(), 2_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::key_of(&registry, ALICE) == key_a(), 0);
        assert!(key_registry::key_of(&registry, BOB) == key_b(), 1);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun rotation_advances_the_version() {
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);
    publish_as(&mut sc, ALICE, key_b(), 5_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::key_of(&registry, ALICE) == key_b(), 0);
        assert!(key_registry::version_of(&registry, ALICE) == 2, 1);
        assert!(key_registry::updated_at_ms_of(&registry, ALICE) == 5_000, 2);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun republishing_the_same_key_does_not_advance_the_version() {
    /*
      A client that lost a response retries. If a retry looked like a rotation, every reader would
      be told the key had changed when it had not — and a version that increments for no reason is
      a version nobody can act on.
    */
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);
    publish_as(&mut sc, ALICE, key_a(), 9_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::version_of(&registry, ALICE) == 1, 0);
        // The timestamp still moves. The entry was written; only the key is unchanged.
        assert!(key_registry::updated_at_ms_of(&registry, ALICE) == 9_000, 1);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun rotating_back_to_a_previous_key_still_advances() {
    // Version counts changes, not distinct keys. A -> B -> A is three states, not two.
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);
    publish_as(&mut sc, ALICE, key_b(), 2_000);
    publish_as(&mut sc, ALICE, key_a(), 3_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::version_of(&registry, ALICE) == 3, 0);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun revoking_leaves_no_trace_in_the_registry() {
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);

    sc.next_tx(ALICE);
    {
        let mut registry = sc.take_shared<KeyRegistry>();
        key_registry::revoke(&mut registry, sc.ctx());
        assert!(!key_registry::has_key(&registry, ALICE), 0);
        assert!(key_registry::try_key_of(&registry, ALICE).is_none(), 1);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun revoking_touches_only_the_sender() {
    /*
      Found by mutation testing: a `revoke` that ignored `ctx.sender()` and removed a fixed address
      passed every other test in this file, because none of them had a second entry to destroy. One
      address deleting another's key is a silent, complete downgrade of that person's messaging —
      senders would see no key and quietly fall back to plaintext.
    */
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);
    publish_as(&mut sc, BOB, key_b(), 2_000);

    sc.next_tx(BOB);
    {
        let mut registry = sc.take_shared<KeyRegistry>();
        key_registry::revoke(&mut registry, sc.ctx());
        assert!(!key_registry::has_key(&registry, BOB), 0);
        assert!(key_registry::key_of(&registry, ALICE) == key_a(), 1);
        assert!(key_registry::version_of(&registry, ALICE) == 1, 2);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun publishing_touches_only_the_sender() {
    // The same hole on the write path: a publish that wrote a fixed address would overwrite
    // someone else's key with the caller's, which is the substitution attack this module exists
    // to make impossible.
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);
    publish_as(&mut sc, BOB, key_b(), 2_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::key_of(&registry, ALICE) == key_a(), 0);
        assert!(key_registry::version_of(&registry, ALICE) == 1, 1);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun publishing_after_a_revoke_continues_the_count() {
    /*
      This test asserted the opposite until 2026-09-01, and its own comment explained the danger it
      was pinning in place:

          "The entry is removed, so the count starts again. Worth pinning: a reader who kept the old
           version would otherwise see 1 and think nothing had happened since."

      That reader is the whole problem. A revoke is what somebody does when their key has been
      COMPROMISED, and the next thing they do is publish a fresh one. Restarting at 1 meant every
      correspondent holding version 3 was shown a number that looked older than what they already
      had, at the one moment they most needed to be told the key had changed.

      The version is now a high-water mark that survives the revoke. It only ever goes up.
    */
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);

    sc.next_tx(ALICE);
    {
        let mut registry = sc.take_shared<KeyRegistry>();
        key_registry::revoke(&mut registry, sc.ctx());
        // The mark outlives the row it came from — that is the entire fix.
        assert!(key_registry::high_water(&registry, ALICE) == 1, 0);
        ts::return_shared(registry);
    };

    publish_as(&mut sc, ALICE, key_b(), 4_000);
    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::version_of(&registry, ALICE) == 2, 1);
        assert!(key_registry::key_of(&registry, ALICE) == key_b(), 2);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun a_version_never_goes_backwards_across_several_revokes() {
    /*
      The converse half. One revoke could be satisfied by any rule that happens to add one; this
      walks the count through three of them and asserts it is monotonic the whole way, so a fix
      that reset to a constant or reused a stale mark cannot pass.
    */
    let mut sc = setup();
    publish_as(&mut sc, ALICE, key_a(), 1_000);
    publish_as(&mut sc, ALICE, key_b(), 2_000);

    let mut seen = 0u64;
    let mut round = 0u64;
    while (round < 3) {
        sc.next_tx(ALICE);
        {
            let registry = sc.take_shared<KeyRegistry>();
            let v = key_registry::version_of(&registry, ALICE);
            assert!(v > seen, 0);
            seen = v;
            ts::return_shared(registry);
        };
        sc.next_tx(ALICE);
        {
            let mut registry = sc.take_shared<KeyRegistry>();
            key_registry::revoke(&mut registry, sc.ctx());
            ts::return_shared(registry);
        };
        publish_as(&mut sc, ALICE, if (round % 2 == 0) key_b() else key_a(), 5_000 + round);
        round = round + 1;
    };

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::version_of(&registry, ALICE) > seen, 1);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun a_first_publisher_still_starts_at_one() {
    // The other converse half: the fix must not push every new address past 1.
    let mut sc = setup();
    publish_as(&mut sc, BOB, key_a(), 1_000);
    sc.next_tx(BOB);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::version_of(&registry, BOB) == 1, 0);
        assert!(key_registry::high_water(&registry, BOB) == 1, 1);
        ts::return_shared(registry);
    };
    sc.end();
}

// === Boundaries ===

#[test]
fun accepts_exactly_thirty_two_bytes() {
    // The last accepted value. Its neighbours are rejected by the two tests below.
    let mut sc = setup();
    let mut k = zeros(31);
    k.push_back(7);
    assert!(k.length() == key_registry::key_bytes(), 0);
    publish_as(&mut sc, ALICE, k, 1_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::has_key(&registry, ALICE), 1);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = key_registry::EKeyLength)]
fun rejects_thirty_one_bytes() {
    let mut sc = setup();
    let mut k = zeros(30);
    k.push_back(7);
    publish_as(&mut sc, ALICE, k, 1_000);
    sc.end();
}

#[test]
#[expected_failure(abort_code = key_registry::EKeyLength)]
fun rejects_thirty_three_bytes() {
    let mut sc = setup();
    let mut k = key_a();
    k.push_back(7);
    publish_as(&mut sc, ALICE, k, 1_000);
    sc.end();
}

#[test]
#[expected_failure(abort_code = key_registry::EKeyLength)]
fun rejects_an_empty_key() {
    let mut sc = setup();
    publish_as(&mut sc, ALICE, vector::empty<u8>(), 1_000);
    sc.end();
}

#[test]
#[expected_failure(abort_code = key_registry::EKeyDegenerate)]
fun rejects_the_all_zero_key() {
    /*
      The canonical low-order point. Every X25519 shared secret computed against it is also all
      zeros, so a message "encrypted" to it is encrypted under a constant everyone can derive.
      Right length, and worthless — which is exactly the shape of bug a length check alone misses.
    */
    let mut sc = setup();
    publish_as(&mut sc, ALICE, zeros(32), 1_000);
    sc.end();
}

#[test]
fun accepts_a_key_that_is_zero_everywhere_but_the_last_byte() {
    // The first accepted value on the other side of the degeneracy check.
    let mut sc = setup();
    let mut k = zeros(31);
    k.push_back(1);
    publish_as(&mut sc, ALICE, k, 1_000);

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        assert!(key_registry::has_key(&registry, ALICE), 0);
        ts::return_shared(registry);
    };
    sc.end();
}

// === Reads on an absent entry ===

#[test]
#[expected_failure(abort_code = key_registry::ENoKey)]
fun key_of_aborts_when_there_is_none() {
    let mut sc = setup();
    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        key_registry::key_of(&registry, BOB);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = key_registry::ENoKey)]
fun version_of_aborts_when_there_is_none() {
    let mut sc = setup();
    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        key_registry::version_of(&registry, BOB);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = key_registry::ENoKey)]
fun revoking_without_a_key_aborts() {
    let mut sc = setup();
    sc.next_tx(BOB);
    {
        let mut registry = sc.take_shared<KeyRegistry>();
        key_registry::revoke(&mut registry, sc.ctx());
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = key_registry::ENoKey)]
/// Kills key_registry.move:285 — the third read on an absent entry, skipped when its two siblings
/// above were written. Without the guard the table borrow aborts inside `sui::dynamic_field`
/// instead, which a caller cannot tell from any other missing field.
fun updated_at_ms_of_aborts_when_there_is_none() {
    let mut sc = setup();
    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<KeyRegistry>();
        key_registry::updated_at_ms_of(&registry, BOB);
        ts::return_shared(registry);
    };
    sc.end();
}
