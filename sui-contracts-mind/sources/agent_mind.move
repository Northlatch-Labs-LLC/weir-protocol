// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/// The agent's mind: its memory and working state, sealed to its account object.
///
/// # What this closes that v0 could not
///
/// v0 (`packages/agent/src/mind.ts`) encrypts a mind to the X25519 key the account published in
/// `key_registry`. The binding to the identity is the registry's, and a stolen agent key reads the
/// mind. This module binds the mind to the `SocialAccount` OBJECT instead: the Seal key servers
/// run `seal_approve_mind` with the reader as sender, and the function takes `&SocialAccount`,
/// which only the object's holder can pass — and `SocialAccount` is `key` without `store`, so it
/// cannot be transferred, sold or lent. The mind follows the account, not a key.
///
/// # The identity
///
///     mind_identity(account) = object::id_to_bytes(account) ‖ 0x02
///
/// One byte tag, disjoint from `entitlement.move`'s `SEAL_UNLOCK = 0` and `SEAL_SUBSCRIPTION = 1`.
/// Those are prefixed by a VAULT id; this is prefixed by an ACCOUNT id, and an account is never a
/// vault, so the families cannot collide even before the tag — the tag is there so a reader of
/// bytes can tell which policy they belong to without knowing which object the prefix names.
///
/// # What is deliberately absent
///
/// No `Clock`, no expiry, no revocation: a derived Seal key is permanent, so a time check here
/// would control nothing. No per-label identity: one mind identity per account, every label's blob
/// under it; the label is a name the agent keeps for itself. Nothing here stores anything on chain.
module agent_mind::agent_mind;

use projectx_social::account::SocialAccount;

/// Refused: the identity is not this account's.
const EWrongIdentity: u64 = 1;

/// Mirrored in `packages/sdk/src/seal.ts` (`SEAL_MIND`) and pinned there against this source.
const SEAL_MIND: u8 = 2;

/// The identity one account's mind is encrypted to. Public so a client can check its own encoder.
public fun mind_identity(account: ID): vector<u8> {
    let mut identity = object::id_to_bytes(&account);
    identity.push_back(SEAL_MIND);
    identity
}

/// Grant the mind key to whoever can present the account object.
///
/// One check, and it is enough: passing `&SocialAccount` already proves the sender holds the
/// object, because an owned object can only be used by its owner and this object cannot change
/// owner. The assertion binds the requested identity to THIS account, so a holder of one account
/// cannot ask for another account's mind and pass on possession alone.
entry fun seal_approve_mind(id: vector<u8>, account: &SocialAccount) {
    assert!(id == mind_identity(object::id(account)), EWrongIdentity);
}

/*
  Test seam. `seal_approve_mind` is `entry`, which is what Seal asks for and keeps it off the
  public surface; this wrapper exists only under `#[test_only]` so the policy is exercised as
  written rather than through a re-implementation that could drift from it.
*/
#[test_only]
public fun approve_mind_for_testing(id: vector<u8>, account: &SocialAccount) {
    seal_approve_mind(id, account)
}
