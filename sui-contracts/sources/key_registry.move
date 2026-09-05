// SPDX-License-Identifier: BUSL-1.1
// Licensor: Northlatch Labs LLC. Change Date: 2029-09-01. Change License: Apache-2.0.
// Built-by: @projectx.sui · Co-authored-by: Claude
/// Where a ProjectX Social address publishes the encryption key people write to it with.
///
/// # The problem this exists to remove
///
/// A Sui address is a hash of a public key, so you cannot encrypt to an address. And an Ed25519
/// signing key is not an encryption key. Every participant therefore has to publish a separate
/// X25519 key, and everyone else has to be able to find it.
///
/// # Deliberately ungated
///
/// Publishing a key costs gas and nothing else. It requires no `SocialAccount`, no capability and
/// no approval, and there is no administrative function anywhere in this module.
///
/// # What the chain can and cannot check
///
/// It checks that a key is 32 bytes and is not all zeros. It cannot do X25519 arithmetic, so it
/// cannot enumerate the remaining small-order points — and it does not need to. Every one of them
/// produces an all-zero shared secret against a clamped scalar, and `@noble/curves` throws rather
/// than returning it. Measured against the classic blacklist — u=0, u=1, both order-8 points and
/// p-1 — all five are refused by the client before a key is ever derived.
///
/// So what the chain provides is not validity but **agreement**: everyone who looks up an address
/// sees the same bytes. That is the property the database registry could not offer.
///
/// # Rotation loses history, and that is the honest behaviour
///
/// Replacing a key makes everything wrapped to the old one unreadable. Nothing here can re-wrap,
/// because re-wrapping needs the plaintext or the old key and this module has neither. That is
/// correct for a compromised key and surprising for a curious one, so `version` is published
/// alongside the key: a client that sees a version it has not seen before can say what changed.
module projectx_social::key_registry;

use sui::clock::Clock;
use sui::dynamic_field as df;
use sui::event;
use sui::table::{Self, Table};

// === Constants ===

/// An X25519 public key is exactly 32 bytes. Anything else is not one.
const KEY_BYTES: u64 = 32;

// === Errors ===

/// The key is not exactly `KEY_BYTES` long.
const EKeyLength: u64 = 1;
/// The key is all zeros. That is the canonical low-order point: every shared secret derived
/// against it is also all zeros, so a message "encrypted" to it is encrypted to a constant.
const EKeyDegenerate: u64 = 2;
/// This address has published no key. Ask `has_key` first, or use `try_key_of`.
const ENoKey: u64 = 3;

// === Types ===

/// One address's published key.
///
/// `copy, drop, store` because it is a value in a table and callers read it out whole. There is no
/// object identity here on purpose: a key binding is not a thing you can hold, sell or lose — it
/// is a fact about an address, and the address is the only thing that can change it.
public struct PublishedKey has copy, drop, store {
    /// 32 bytes. Not an address and not a Sui public key — an X25519 encryption key.
    x25519_public: vector<u8>,
    /// 1 for the first key, incremented on each change. Unchanged by republishing the same bytes.
    version: u64,
    updated_at_ms: u64,
}

/// The registry. Shared, so anyone can read and anyone can write their own entry.
///
/// A shared object rather than one owned object per address because the whole point is lookup: a
/// sender who only knows the recipient's address must be able to resolve it without being told an
/// object id by a server — which would put the server back in the middle of the binding.
public struct KeyRegistry has key {
    id: UID,
    keys: Table<address, PublishedKey>,
}

// === Events ===

/// Emitted on every publish, including a rotation and a no-op republish.
///
/// Clients may index these instead of reading the table, but an index is a convenience and the
/// table is the authority. A client that cares whether it is being lied to reads the table.
public struct KeyPublished has copy, drop {
    owner: address,
    x25519_public: vector<u8>,
    version: u64,
    updated_at_ms: u64,
}

/// Emitted when an address withdraws its key.
public struct KeyRevoked has copy, drop {
    owner: address,
    /// The version that was in force when it was revoked.
    version: u64,
}

// === Initialisation ===

/// Creates the shared registry. Runs once, when this module first appears in a published package.
fun init(ctx: &mut TxContext) {
    transfer::share_object(KeyRegistry {
        id: object::new(ctx),
        keys: table::new(ctx),
    });
}

// === Publishing ===

/// Publish or rotate the sender's encryption key.
///
/// The sender is the only possible subject. There is no `owner` parameter, so there is no version
/// of this call that publishes a key on someone else's behalf — the substitution attack is absent
/// from the interface rather than rejected by a check inside it.
///
/// Republishing the identical key is allowed and does **not** advance `version`. Retries are a
/// normal part of a client that lost a response, and a retry that looked like a rotation would tell
/// every reader that a key had changed when it had not.
public fun publish(
    registry: &mut KeyRegistry,
    x25519_public: vector<u8>,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_key_plausible(&x25519_public);

    let owner = ctx.sender();
    let now = clock.timestamp_ms();

    let version = if (registry.keys.contains(owner)) {
        let existing = registry.keys.borrow_mut(owner);
        let unchanged = existing.x25519_public == x25519_public;
        if (!unchanged) {
            existing.x25519_public = x25519_public;
            existing.version = existing.version + 1;
        };
        existing.updated_at_ms = now;
        let version = existing.version;
        // Kept level with the table on every rotation, not only at revoke, so the mark is never
        // behind the row it is meant to outlive.
        remember_high_water(registry, owner, version);
        version
    } else {
        /*
          Not 1. The next version after everything this address has ever published.

          A first-time publisher has no high-water mark and gets 1, exactly as before. A publisher
          returning after a revoke continues from where they stopped, so the number a client watches
          only ever goes up. It has to: the person republishing after a revoke is the person whose
          key was compromised, and a version that looked older than the one already cached would tell
          every correspondent to keep using the key the attacker holds.
        */
        let version = next_version_for(registry, owner);
        registry
            .keys
            .add(owner, PublishedKey { x25519_public, version, updated_at_ms: now });
        remember_high_water(registry, owner, version);
        version
    };

    event::emit(KeyPublished { owner, x25519_public, version, updated_at_ms: now });
}

/// Withdraw the sender's key.
///
/// After this, senders see an address with no key and fall back to plaintext with a visible label,
/// which is the correct outcome for someone who has lost the key and cannot read ciphertext any
/// more. It does not make already-sent messages unreadable — those were readable before this call
/// and nothing on chain can retract them.
public fun revoke(registry: &mut KeyRegistry, ctx: &TxContext) {
    let owner = ctx.sender();
    assert!(registry.keys.contains(owner), ENoKey);
    let PublishedKey { x25519_public: _, version, updated_at_ms: _ } = registry.keys.remove(owner);
    /*
      Remember the version this address reached, BEFORE the row is gone.

      Without this the count restarts at 1 on the next publish, and the number a client uses to
      notice a key change goes BACKWARDS at the one moment it must not: the person revoking is the
      person whose key was compromised, and the very next thing they do is publish a new one.
      A client holding version 3 would be shown version 1 and could not tell it was newer.

      A dynamic field rather than a second column, because `KeyRegistry` is a shared object already
      live on chain and a Move upgrade cannot add a field to an existing struct. This adds a value
      beside it instead, which an upgrade CAN do.
    */
    remember_high_water(registry, owner, version);
    event::emit(KeyRevoked { owner, version });
}

/// The highest version an address has ever reached, kept across a revoke.
///
/// Its own type rather than a bare address so the field cannot collide with any other dynamic field
/// on this object, now or in a later upgrade.
public struct HighWater has copy, drop, store { owner: address }

fun remember_high_water(registry: &mut KeyRegistry, owner: address, version: u64) {
    if (df::exists(&registry.id, HighWater { owner })) {
        let slot: &mut u64 = df::borrow_mut(&mut registry.id, HighWater { owner });
        // Never lowered. A future path that revoked an older row must not walk the mark back.
        if (version > *slot) *slot = version;
    } else {
        df::add(&mut registry.id, HighWater { owner }, version);
    }
}

/// What the next version for this address must be, whether or not a row exists today.
fun next_version_for(registry: &KeyRegistry, owner: address): u64 {
    if (df::exists(&registry.id, HighWater { owner })) {
        *df::borrow<HighWater, u64>(&registry.id, HighWater { owner }) + 1
    } else {
        1
    }
}

/// The highest version this address has ever published. `0` if it has never published one.
///
/// Public so a client can ask the chain directly rather than inferring it from events, which is the
/// same reason the table is the authority and the events are a convenience.
public fun high_water(registry: &KeyRegistry, owner: address): u64 {
    if (df::exists(&registry.id, HighWater { owner })) {
        *df::borrow<HighWater, u64>(&registry.id, HighWater { owner })
    } else {
        0
    }
}

// === Validation ===

/// Everything about a key that this chain can actually check.
///
/// Length, and the all-zero point. Move has no X25519 arithmetic, so the remaining small-order
/// points cannot be rejected here — see the module documentation. Naming the limit is the point:
/// a caller must not read this as "the chain validated the key".
fun assert_key_plausible(x25519_public: &vector<u8>) {
    assert!(x25519_public.length() == KEY_BYTES, EKeyLength);

    let mut i = 0;
    let mut any_nonzero = false;
    while (i < KEY_BYTES) {
        if (x25519_public[i] != 0) {
            any_nonzero = true;
            break
        };
        i = i + 1;
    };
    assert!(any_nonzero, EKeyDegenerate);
}

// === Reads ===

public fun has_key(registry: &KeyRegistry, addr: address): bool {
    registry.keys.contains(addr)
}

/// The key published by `addr`. Aborts if there is none.
public fun key_of(registry: &KeyRegistry, addr: address): vector<u8> {
    assert!(registry.keys.contains(addr), ENoKey);
    registry.keys.borrow(addr).x25519_public
}

/// The key published by `addr`, or `none`.
///
/// The form to prefer in a client. "This address has no key" and "the lookup aborted" are different
/// facts leading to different behaviour — send plaintext with a label, versus send nothing — and an
/// abort collapses them into one.
public fun try_key_of(registry: &KeyRegistry, addr: address): Option<vector<u8>> {
    if (registry.keys.contains(addr)) {
        option::some(registry.keys.borrow(addr).x25519_public)
    } else {
        option::none()
    }
}

/// How many distinct keys this address has had. Aborts if it has published none.
public fun version_of(registry: &KeyRegistry, addr: address): u64 {
    assert!(registry.keys.contains(addr), ENoKey);
    registry.keys.borrow(addr).version
}

/// When the entry was last written, including a republish that changed nothing.
public fun updated_at_ms_of(registry: &KeyRegistry, addr: address): u64 {
    assert!(registry.keys.contains(addr), ENoKey);
    registry.keys.borrow(addr).updated_at_ms
}

public fun key_bytes(): u64 { KEY_BYTES }

// === Test-only ===

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}
