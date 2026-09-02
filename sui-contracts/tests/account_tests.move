// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/// Tests for identity — handle rules, one-account-per-address, and referral attribution.
///
/// The soulbound property itself is not tested here and cannot be: there is no function that
/// transfers a `SocialAccount`, so a test that tried would not compile. That is the point of
/// carrying the property in the type rather than in a runtime check — the compiler is the test,
/// and it runs on every build.
#[test_only]
module projectx_social::account_tests;

use projectx_social::account::{Self, Registry, SocialAccount};
use projectx_social::platform::{Self, Platform, PlatformCap};
use sui::clock;
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xAD;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;
/// Never opens an account. Exists only to be named as a referrer that is not a member.
const CAROL: address = @0xCA;

fun setup(): Scenario {
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
    sc
}

fun open_as(sc: &mut Scenario, who: address, handle: vector<u8>, referrer: Option<address>) {
    sc.next_tx(who);
    let mut platform = sc.take_shared<Platform>();
    let mut registry = sc.take_shared<Registry>();
    let clk = clock::create_for_testing(sc.ctx());
    account::open(&mut platform, &mut registry, handle.to_string(), referrer, &clk, sc.ctx());
    clock::destroy_for_testing(clk);
    ts::return_shared(platform);
    ts::return_shared(registry);
}

#[test]
fun opening_an_account_registers_the_handle_in_both_directions() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice", option::none());

    sc.next_tx(ALICE);
    {
        let registry = sc.take_shared<Registry>();
        let platform = sc.take_shared<Platform>();
        let acct = sc.take_from_sender<SocialAccount>();

        assert!(account::is_handle_taken(&registry, b"alice".to_string()), 0);
        assert!(account::has_account(&registry, ALICE), 1);
        assert!(account::resolve(&registry, b"alice".to_string()) == ALICE, 2);
        assert!(account::owner(&acct) == ALICE, 3);
        assert!(account::referrer(&acct).is_none(), 4);
        assert!(platform::accounts_created(&platform) == 1, 5);

        sc.return_to_sender(acct);
        ts::return_shared(platform);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun closing_an_account_frees_the_handle_for_someone_else() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"shared", option::none());

    sc.next_tx(ALICE);
    {
        let mut registry = sc.take_shared<Registry>();
        let acct = sc.take_from_sender<SocialAccount>();
        account::close(&mut registry, acct, sc.ctx());
        assert!(!account::is_handle_taken(&registry, b"shared".to_string()), 0);
        assert!(!account::has_account(&registry, ALICE), 1);
        ts::return_shared(registry);
    };

    // Bob can now take it.
    open_as(&mut sc, BOB, b"shared", option::none());
    sc.next_tx(BOB);
    {
        let registry = sc.take_shared<Registry>();
        assert!(account::resolve(&registry, b"shared".to_string()) == BOB, 2);
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
fun a_referrer_is_recorded_at_creation() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice", option::none());
    open_as(&mut sc, BOB, b"bob", option::some(ALICE));

    sc.next_tx(BOB);
    {
        let acct = sc.take_from_sender<SocialAccount>();
        assert!(account::referrer(&acct) == option::some(ALICE), 0);
        sc.return_to_sender(acct);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleTaken)]
fun two_accounts_cannot_share_a_handle() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"taken", option::none());
    open_as(&mut sc, BOB, b"taken", option::none());
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EAlreadyRegistered)]
fun one_address_cannot_hold_two_accounts() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"first", option::none());
    open_as(&mut sc, ALICE, b"second", option::none());
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ESelfReferral)]
fun an_account_cannot_refer_itself() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice", option::some(ALICE));
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EReferrerNotRegistered)]
fun a_referrer_must_hold_an_account_here() {
    /*
      Until 2026-09-01 `referrer` was any address at all. An address with no account, one that will
      never open one, an exchange deposit address, a typo — whatever was named received the referral
      share of every later sale on this account, and the only thing refused was naming yourself.

      CAROL has not opened an account in this test. That is the whole case.
    */
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice", option::some(CAROL));
    sc.end();
}

#[test]
fun a_registered_referrer_is_still_accepted() {
    /*
      The converse half. A guard that refused every referrer would pass the test above and destroy
      the feature, so this asserts the ordinary case still works: BOB opens first, ALICE names him.
    */
    let mut sc = setup();
    open_as(&mut sc, BOB, b"bob", option::none());
    open_as(&mut sc, ALICE, b"alice", option::some(BOB));

    sc.next_tx(ALICE);
    {
        let acct = sc.take_from_sender<SocialAccount>();
        assert!(account::referrer(&acct) == option::some(BOB), 0);
        sc.return_to_sender(acct);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleCharset)]
fun uppercase_is_rejected_rather_than_folded() {
    // Rejected, not lowercased. Silently returning a different handle from the one requested is
    // the behaviour this rule exists to avoid.
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"Alice", option::none());
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleCharset)]
fun punctuation_is_rejected() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"al.ice", option::none());
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleCharset)]
fun non_ascii_is_rejected() {
    // "аlice" with a Cyrillic а — visually identical to the Latin spelling in most fonts, and
    // therefore an impersonation vector on a social network.
    let mut sc = setup();
    open_as(&mut sc, ALICE, x"D0B06C696365", option::none());
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleLength)]
fun a_handle_below_the_minimum_length_is_rejected() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"ab", option::none()); // MIN is 3
    sc.end();
}

#[test]
fun the_length_boundaries_are_inclusive() {
    // Both ends of the permitted range, tested from the accepted side. The rejected side is
    // covered above; testing only one side leaves an off-by-one invisible.
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"abc", option::none()); // exactly MIN
    open_as(&mut sc, BOB, b"abcdefghij0123456789abcdefghij", option::none()); // exactly MAX

    sc.next_tx(BOB);
    {
        let registry = sc.take_shared<Registry>();
        assert!(account::is_handle_taken(&registry, b"abc".to_string()), 0);
        assert!(
            account::is_handle_taken(&registry, b"abcdefghij0123456789abcdefghij".to_string()),
            1,
        );
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleLength)]
fun one_byte_over_the_maximum_is_rejected() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"abcdefghij0123456789abcdefghijk", option::none()); // MAX + 1
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::platform::ECreationPaused)]
fun no_account_can_be_opened_while_creation_is_paused() {
    let mut sc = setup();
    sc.next_tx(ADMIN);
    {
        let mut platform = sc.take_shared<Platform>();
        let cap = sc.take_from_sender<PlatformCap>();
        platform::set_creation_paused(&mut platform, &cap, true);
        sc.return_to_sender(cap);
        ts::return_shared(platform);
    };
    open_as(&mut sc, ALICE, b"alice", option::none());
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::ENotOwner)]
fun a_stranger_presenting_someone_elses_account_cannot_close_it() {
    // First survivor of the 2026-08-28 mutation sweep: deleting the owner check in
    // `close` left the whole suite green. A SocialAccount has no store, so no on-chain
    // path hands one to a stranger today — the scenario constructs the impossible
    // holder deliberately, because this assert is the registry's last line if any such
    // path ever appears, and an untested last line is the one that rots.
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice", option::none());

    sc.next_tx(BOB);
    {
        let mut registry = sc.take_shared<Registry>();
        let acct = sc.take_from_address<SocialAccount>(ALICE);
        account::close(&mut registry, acct, sc.ctx());
        ts::return_shared(registry);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleMismatch)]
fun a_registry_that_never_saw_the_handle_refuses_the_close() {
    // Second survivor of the same sweep: the registry-drift guard. A second registry
    // stands in for one that has drifted from the object graph — the account was opened
    // in the first, and the second, which never saw the handle, must refuse to delete
    // anything rather than free a handle another account may still carry.
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice", option::none());

    sc.next_tx(ADMIN);
    {
        account::init_for_testing(sc.ctx());
    };

    sc.next_tx(ALICE);
    {
        let drifted_id = ts::most_recent_id_shared<Registry>().destroy_some();
        let mut drifted = sc.take_shared_by_id<Registry>(drifted_id);
        let acct = sc.take_from_sender<SocialAccount>();
        account::close(&mut drifted, acct, sc.ctx());
        ts::return_shared(drifted);
    };
    sc.end();
}

#[test]
#[expected_failure(abort_code = ::projectx_social::account::EHandleMismatch)]
/// Kills account.move:219 — the registry knows the handle and records a different owner.
fun a_registry_that_gave_the_handle_to_someone_else_refuses_the_close() {
    // Third line of the same drift guard. `a_registry_that_never_saw_the_handle_refuses_the_close`
    // covers the absent row; this is the present-but-wrong row, and it is the more dangerous of the
    // two: deleting it would free BOB's handle on ALICE's say-so. The 2026-09-01 mutation sweep
    // deleted it and the suite stayed green.
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"shared", option::none());

    sc.next_tx(ADMIN);
    {
        account::init_for_testing(sc.ctx());
    };
    // BOB takes the same handle in the drifted registry — the newest, which is the one `open_as`
    // resolves to now that two exist.
    open_as(&mut sc, BOB, b"shared", option::none());

    sc.next_tx(ALICE);
    {
        let drifted_id = ts::most_recent_id_shared<Registry>().destroy_some();
        let mut drifted = sc.take_shared_by_id<Registry>(drifted_id);
        assert!(account::resolve(&drifted, b"shared".to_string()) == BOB, 0);
        let acct = sc.take_from_sender<SocialAccount>();
        account::close(&mut drifted, acct, sc.ctx());
        ts::return_shared(drifted);
    };
    sc.end();
}
