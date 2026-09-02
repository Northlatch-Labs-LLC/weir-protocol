// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/// Identity and authentication for ProjectX Social.
///
/// # Why it cannot be sold, lent, or stolen
///
/// `SocialAccount` has `key` and **not** `store`. In Move that combination means the object can
/// exist and be owned but cannot be put inside another object and cannot be passed to
/// `transfer::public_transfer`. Only this module can move one, and this module offers no function
/// that does. The account is therefore bound to the address it was opened by, permanently.
///
/// That is the entire security property, and it is carried by the type system rather than by a
/// check somebody could forget to write. There is no code path — in this package or any other —
/// that transfers a `SocialAccount`.
///
/// # How this reaches users who have never held a wallet
///
/// Nothing here mentions zkLogin, and that is the design working rather than an omission. A
/// zkLogin address is an ordinary Sui address derived from an OAuth credential plus a salt; the
/// chain cannot distinguish it from a keypair address and neither can this module. A user who
/// signs in with Google gets an address, opens an account at it, and is indistinguishable on
/// chain from a hardware-wallet user. Supporting both is therefore a client concern, and no
/// contract change is ever needed to add a provider.
///
/// # The referrer is recorded once and never again
module projectx_social::account;

use projectx_social::platform::{Self, Platform};
use std::string::String;
use sui::clock::Clock;
use sui::event;
use sui::table::{Self, Table};

// === Handle rules ===
//
// Deliberately strict, and deliberately enforced by rejection rather than by normalisation. A
// registry that lowercases what you typed hands you a different handle from the one you asked
// for and tells you it succeeded; the first time anyone notices is when they print it on
// something. Rejecting is louder and cheaper.

const MIN_HANDLE_LEN: u64 = 3;
const MAX_HANDLE_LEN: u64 = 30;

// === Errors ===

/// The handle is shorter than `MIN_HANDLE_LEN` or longer than `MAX_HANDLE_LEN`.
const EHandleLength: u64 = 1;
/// The handle contains a byte outside `[a-z0-9_]`. Uppercase is rejected, not folded.
const EHandleCharset: u64 = 2;
/// The handle is already registered to another address.
const EHandleTaken: u64 = 3;
/// This address already holds an account. One account per address, enforced by the registry.
const EAlreadyRegistered: u64 = 4;
/// An account was presented by an address that does not own it.
const ENotOwner: u64 = 5;
/// An account was presented to a platform that did not issue it.
const EWrongPlatform: u64 = 6;
/// A referrer must not be the account being opened.
const ESelfReferral: u64 = 7;
/// A referrer must already hold an account here. See `open`.
const EReferrerNotRegistered: u64 = 9;
/// The registry entry for this handle does not match the account being closed.
const EHandleMismatch: u64 = 8;

// === Types ===

/// Maps handles to their owners, and owners to their handles.
///
/// A shared object rather than fields on `Platform` because handle registration is the single
/// highest-frequency write in the system and it should not contend with fee administration on the
/// same object. Two tables rather than one because both directions are looked up: "is this handle
/// free" on registration, and "does this address already have an account" to enforce one-per-address.
public struct Registry has key {
    id: UID,
    /// handle -> owning address
    by_handle: Table<String, address>,
    /// owning address -> handle
    by_address: Table<address, String>,
}

/// A registered identity. Soulbound — see the module documentation.
public struct SocialAccount has key {
    id: UID,
    /// The platform this account was opened at. An account from a staging deployment must not
    /// authenticate against mainnet, and this is what stops it.
    platform: ID,
    /// The address this account was opened by. Checked against the sender on every use.
    owner: address,
    handle: String,
    /// Who referred this user, fixed at creation. `none` for an organic signup.
    referrer: Option<address>,
    created_at_ms: u64,
}

// === Events ===

public struct AccountOpened has copy, drop {
    account: ID,
    platform: ID,
    owner: address,
    handle: String,
    referrer: Option<address>,
    created_at_ms: u64,
}

public struct AccountClosed has copy, drop {
    account: ID,
    owner: address,
    handle: String,
}

// === Initialisation ===

/// Creates the shared registry. Runs once at publish.
fun init(ctx: &mut TxContext) {
    transfer::share_object(Registry {
        id: object::new(ctx),
        by_handle: table::new(ctx),
        by_address: table::new(ctx),
    });
}

// === Registration ===

/// Open an account and take the handle.
///
/// Free, always. The platform's `creation_fee_mist` applies to creator vaults, not to identities:
/// charging someone to exist on the network would make the fee schedule a barrier to signup, and
/// a social product with a paywall at registration has no users to monetise.
///
/// The account is transferred to the sender inside this function rather than returned, because a
/// returned `SocialAccount` has no `store` and the caller could not legally do anything with it —
/// the transaction would abort on an unused resource, which is a confusing way to learn the rule.
public fun open(
    platform: &mut Platform,
    registry: &mut Registry,
    handle: String,
    referrer: Option<address>,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    platform.assert_can_create();

    let owner = ctx.sender();
    assert_handle_valid(&handle);
    assert!(!registry.by_handle.contains(handle), EHandleTaken);
    assert!(!registry.by_address.contains(owner), EAlreadyRegistered);
    if (referrer.is_some()) {
        let who = *referrer.borrow();
        assert!(who != owner, ESelfReferral);
        /*
          The referrer must be somebody who is actually here.

          This check did not exist. `referrer` was any address at all — one with no account, an
          address that will never open one, an exchange's deposit address, a typo. Whatever was
          named, the referral share of every later sale on this account was routed to it, and the
          only thing the chain refused was naming yourself.

          Naming a stranger is not a fraud against us; it is a leak. The share is paid out of the
          platform's own cut and it goes to an address that will never claim it, or that will and
          has nothing to do with us. Requiring a registered account makes the referrer a member,
          which is the only class of address a referral programme was ever meant to reward.

          WHAT THIS DOES NOT DO, and it is stated here because the previous check pretended
          otherwise by its silence: it does not stop self-referral. Somebody who opens an account,
          then opens a second one naming the first, passes every test above — because the chain
          cannot tell that two addresses are one person, and no contract can. Sybil resistance is
          not a property a Move module can hold. If that matters it has to be answered where
          identity is actually known: at payout, or by not paying a referral on an account whose
          referrer is younger than it, or by accepting the cost. It cannot be answered here, and a
          check that appears to try is worse than one that says so.
        */
        assert!(registry.by_address.contains(who), EReferrerNotRegistered);
    };

    registry.by_handle.add(handle, owner);
    registry.by_address.add(owner, handle);

    let account = SocialAccount {
        id: object::new(ctx),
        platform: object::id(platform),
        owner,
        handle,
        referrer,
        created_at_ms: clock.timestamp_ms(),
    };

    event::emit(AccountOpened {
        account: object::id(&account),
        platform: object::id(platform),
        owner,
        handle,
        referrer,
        created_at_ms: account.created_at_ms,
    });

    platform.record_account_created();

    transfer::transfer(account, owner);
}

/// Destroy an account and release its handle.
///
/// Requires the holder to present it, because the object is owned by them and no capability in
/// this package can take an owned object from an address. Account closure is therefore
/// cooperative by construction — worth knowing before promising anyone that an account can be
/// removed on request.
///
/// This does not touch a creator vault. Vaults hold money and are governed by their own
/// capability; closing an identity must not be able to strand a balance.
public fun close(registry: &mut Registry, account: SocialAccount, ctx: &TxContext) {
    let SocialAccount { id, platform: _, owner, handle, referrer: _, created_at_ms: _ } = account;
    assert!(owner == ctx.sender(), ENotOwner);

    // Guards against a registry that has drifted from the object graph. If these ever disagree,
    // deleting the row would free a handle that another account still carries.
    assert!(registry.by_handle.contains(handle), EHandleMismatch);
    assert!(*registry.by_handle.borrow(handle) == owner, EHandleMismatch);

    registry.by_handle.remove(handle);
    registry.by_address.remove(owner);

    event::emit(AccountClosed { account: id.to_inner(), owner, handle });

    id.delete();
}

// === Validation ===

/// Reject anything outside `[a-z0-9_]` and anything outside the length bounds.
///
/// Byte-wise rather than character-wise: every permitted byte is ASCII, so a multi-byte UTF-8
/// sequence necessarily contains a byte above 0x7A and is rejected by the charset check. That is
/// intentional — a handle that renders identically to another in some fonts is an impersonation
/// vector on a social network, and the cheapest defence is to permit only one script.
fun assert_handle_valid(handle: &String) {
    let bytes = handle.as_bytes();
    let len = bytes.length();
    assert!(len >= MIN_HANDLE_LEN && len <= MAX_HANDLE_LEN, EHandleLength);

    let mut i = 0;
    while (i < len) {
        let b = bytes[i];
        let ok =
            (b >= 0x61 && b <= 0x7A) || // a-z
            (b >= 0x30 && b <= 0x39) || // 0-9
            b == 0x5F; // _
        assert!(ok, EHandleCharset);
        i = i + 1;
    };
}

// === Authentication ===

/// Assert that `account` authenticates `sender` at `platform`.
///
/// Both halves matter, and each closes a different hole. Without the owner check an account could
/// be borrowed by reference and used by anyone who could name it. Without the platform check an
/// account opened on a staging deployment would authenticate on mainnet.
///
/// `public(package)` because it is the gate every paying function in `creator` calls; exposing it
/// publicly would invite callers to check and then act, when the point is that they cannot act
/// without it.
public(package) fun assert_authenticates(
    account: &SocialAccount,
    sender: address,
    platform_id: ID,
) {
    assert!(account.owner == sender, ENotOwner);
    assert!(account.platform == platform_id, EWrongPlatform);
}

// === Reads ===

public fun owner(account: &SocialAccount): address { account.owner }

public fun handle(account: &SocialAccount): &String { &account.handle }

public fun referrer(account: &SocialAccount): Option<address> { account.referrer }

public fun platform_id(account: &SocialAccount): ID { account.platform }

public fun created_at_ms(account: &SocialAccount): u64 { account.created_at_ms }

public fun is_handle_taken(registry: &Registry, handle: String): bool {
    registry.by_handle.contains(handle)
}

public fun has_account(registry: &Registry, addr: address): bool {
    registry.by_address.contains(addr)
}

/// The address a handle resolves to. Aborts if the handle is unregistered — callers that do not
/// know whether it exists should ask `is_handle_taken` first.
public fun resolve(registry: &Registry, handle: String): address {
    *registry.by_handle.borrow(handle)
}

public fun min_handle_len(): u64 { MIN_HANDLE_LEN }

public fun max_handle_len(): u64 { MAX_HANDLE_LEN }

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}
