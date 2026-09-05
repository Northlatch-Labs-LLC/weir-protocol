// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#[test_only]
module agent_mind::agent_mind_tests;

use agent_mind::agent_mind;
use projectx_social::account::{Self, Registry, SocialAccount};
use projectx_social::platform::{Self, Platform, PlatformCap};
use sui::clock;
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xAD;
const ALICE: address = @0xA1;
const BOB: address = @0xB0;

fun setup(): Scenario {
    let mut sc = ts::begin(ADMIN);
    {
        let ctx = sc.ctx();
        platform::init_for_testing(ctx);
        account::init_for_testing(ctx);
    };
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

fun open_as(sc: &mut Scenario, who: address, handle: vector<u8>) {
    sc.next_tx(who);
    let mut platform = sc.take_shared<Platform>();
    let mut registry = sc.take_shared<Registry>();
    let clk = clock::create_for_testing(sc.ctx());
    account::open(&mut platform, &mut registry, handle.to_string(), option::none(), &clk, sc.ctx());
    clock::destroy_for_testing(clk);
    ts::return_shared(platform);
    ts::return_shared(registry);
}

#[test]
fun the_identity_is_the_account_id_and_the_tag() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice");
    sc.next_tx(ALICE);
    {
        let acct = sc.take_from_sender<SocialAccount>();
        let id = object::id(&acct);
        let identity = agent_mind::mind_identity(id);
        let mut expected = object::id_to_bytes(&id);
        expected.push_back(2);
        assert!(identity == expected);
        assert!(identity.length() == 33);
        sc.return_to_sender(acct);
    };
    sc.end();
}

#[test]
fun the_holder_of_the_account_is_approved_for_its_own_mind() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice");
    sc.next_tx(ALICE);
    {
        let acct = sc.take_from_sender<SocialAccount>();
        agent_mind::approve_mind_for_testing(agent_mind::mind_identity(object::id(&acct)), &acct);
        sc.return_to_sender(acct);
    };
    sc.end();
}

#[test, expected_failure(abort_code = agent_mind::EWrongIdentity)]
fun one_account_cannot_ask_for_another_accounts_mind() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice");
    open_as(&mut sc, BOB, b"bob");
    // Alice holds her own account and names Bob's identity: possession of the wrong object.
    sc.next_tx(BOB);
    let bob_id = {
        let acct = sc.take_from_sender<SocialAccount>();
        let id = object::id(&acct);
        sc.return_to_sender(acct);
        id
    };
    sc.next_tx(ALICE);
    {
        let acct = sc.take_from_sender<SocialAccount>();
        agent_mind::approve_mind_for_testing(agent_mind::mind_identity(bob_id), &acct);
        sc.return_to_sender(acct);
    };
    sc.end();
}

#[test, expected_failure(abort_code = agent_mind::EWrongIdentity)]
fun an_entitlement_style_identity_is_refused() {
    let mut sc = setup();
    open_as(&mut sc, ALICE, b"alice");
    sc.next_tx(ALICE);
    {
        let acct = sc.take_from_sender<SocialAccount>();
        // The same prefix with the unlock tag (0) instead of the mind tag (2).
        let mut wrong = object::id_to_bytes(&object::id(&acct));
        wrong.push_back(0);
        agent_mind::approve_mind_for_testing(wrong, &acct);
        sc.return_to_sender(acct);
    };
    sc.end();
}
