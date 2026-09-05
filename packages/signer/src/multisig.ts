// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `MultiSigSigner` — the custody floor, and the only tier that survives a compromised agent.
 *
 * # What it buys, precisely, given that the account cannot move
 *
 * A weir `SocialAccount` is soulbound: `key` only, no `store`, no transfer function anywhere in
 * `account.move`. So nothing in this file rotates a key or moves a handle, and nothing can.
 *
 * What a multisig of **(agent hot key, operator cold key) at threshold 1** does buy is this: the
 * operator can sign for the address **without ever holding the agent's key**, which means that
 * when the agent key leaks, the operator can *sweep the coins* out of that address immediately
 * rather than waiting to see what the attacker does with them. The address is still fixed. The
 * handle is still lost. The entitlements are still lost. The money need not be.
 *
 * That is damage limitation and this file will not call it anything else.
 *
 * # Threshold 1 is not a weaker multisig; it is a different tool
 *
 * At threshold 1 either party can act alone, so the agent is not slowed down and the operator
 * needs no coordination in an emergency. It does **not** stop an attacker spending — they hold a
 * key that satisfies the threshold. Raising the threshold to 2 stops that, and also stops the
 * agent operating unattended, which is the whole point of an agent. The design accepts the first
 * cost and refuses the second, and an operator who wants the other trade sets the weights.
 *
 * # Members may be missing, and a below-threshold combination is refused HERE
 *
 * In production the cold key is not in the process. This signer accepts whichever members are
 * available, combines their partial signatures, and then **verifies the result against the
 * multisig public key before returning it**. `combinePartialSignatures` performs no threshold
 * check of its own — verified by reading `@mysten/sui` 2.27.1's `multisig/publickey.ts`, where
 * the threshold is compared only inside `verify()`. Without the local verification below, a
 * signer missing a required member would return a well-formed signature that every node rejects,
 * and the operator would be reading node errors instead of a sentence naming the missing key.
 */

import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { publicKeyFromSuiBytes } from '@mysten/sui/verify';
import type { PublicKey } from '@mysten/sui/cryptography';
import { fail, ok, type Reading } from '@projectx-social/sdk';
import type { SerializedSignature, Signer } from './signer.js';

export interface MultiSigMember {
  /** The member's public key, as Sui's flag-prefixed bytes or their base64. */
  readonly publicKey: PublicKey | string | Uint8Array;
  /** This member's weight toward the threshold. */
  readonly weight: number;
}

export interface MultiSigSignerOptions {
  readonly threshold: number;
  readonly members: readonly MultiSigMember[];
  /**
   * The members whose keys this process actually holds.
   *
   * Usually one: the agent's hot key. The operator's cold key is a member of the public key above
   * and is deliberately not here.
   */
  readonly available: readonly Signer[];
}

/**
 * Build a multisig signer.
 *
 * Returns a `Reading` rather than throwing, because every way this can fail — a malformed member
 * key, a threshold nothing can reach, an available signer that is not a member — is a
 * configuration fact an unattended process must report rather than crash on.
 */
export function multiSigSigner(options: MultiSigSignerOptions): Reading<Signer> {
  const source = 'multisig signer';

  if (options.members.length === 0) {
    return fail('unconfigured', source, 'a multisig needs at least one member.');
  }
  if (!Number.isInteger(options.threshold) || options.threshold <= 0) {
    return fail(
      'unconfigured',
      source,
      `threshold ${String(options.threshold)} is not a positive integer. A threshold of zero is ` +
        `an address anybody can sign for.`,
    );
  }

  const publicKeys: { publicKey: PublicKey; weight: number }[] = [];
  for (const member of options.members) {
    if (!Number.isInteger(member.weight) || member.weight <= 0) {
      return fail('unconfigured', source, `a member declares weight ${String(member.weight)}.`);
    }
    try {
      const publicKey =
        typeof member.publicKey === 'string' || member.publicKey instanceof Uint8Array
          ? publicKeyFromSuiBytes(member.publicKey)
          : member.publicKey;
      publicKeys.push({ publicKey, weight: member.weight });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // A public key is not secret, so quoting the failure is safe here in a way it is not in
      // `local.ts`.
      return fail('malformed', source, `a member public key could not be read: ${detail}`);
    }
  }

  const totalWeight = publicKeys.reduce((sum, entry) => sum + entry.weight, 0);
  if (totalWeight < options.threshold) {
    return fail(
      'unconfigured',
      source,
      `the members' weights total ${totalWeight}, below the threshold of ${options.threshold}. ` +
        `This address could never be signed for by anyone.`,
    );
  }

  let multiSigPublicKey: MultiSigPublicKey;
  try {
    multiSigPublicKey = MultiSigPublicKey.fromPublicKeys({
      threshold: options.threshold,
      publicKeys,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return fail('malformed', source, `the multisig public key could not be built: ${detail}`);
  }

  const address = multiSigPublicKey.toSuiAddress();

  /*
    Each available signer must be a member. A signer that is not one produces a partial signature
    `combinePartialSignatures` throws on ("Received signature from unknown public key"), and the
    throw would arrive at signing time — in production, unattended — rather than at construction,
    which is the moment an operator is actually looking.
  */
  const memberAddresses = new Set(publicKeys.map((entry) => entry.publicKey.toSuiAddress()));
  for (const signer of options.available) {
    if (!memberAddresses.has(signer.address)) {
      return fail(
        'unconfigured',
        source,
        `${signer.address} was supplied as an available signer but is not a member of this ` +
          `multisig. Checked now rather than at signing time, which in an unattended process is ` +
          `three in the morning.`,
      );
    }
  }

  if (options.available.length === 0) {
    return fail(
      'unconfigured',
      source,
      `no member keys are available to this process, so ${address} cannot sign here. Use ` +
        `readOnlySigner() if that is intended, so the refusal is deliberate rather than a ` +
        `signer that fails on first use.`,
    );
  }

  const combine = async (
    bytes: Uint8Array,
    signOne: (signer: Signer, b: Uint8Array) => Promise<Reading<SerializedSignature>>,
    verify: (message: Uint8Array, signature: string) => Promise<boolean>,
    what: string,
  ): Promise<Reading<SerializedSignature>> => {
    const partials: string[] = [];
    for (const signer of options.available) {
      const partial = await signOne(signer, bytes);
      if (!partial.ok) {
        return fail(
          partial.failure.kind,
          source,
          `member ${signer.address} could not sign the ${what}: ${partial.failure.detail}`,
        );
      }
      partials.push(partial.value);
    }

    let combined: string;
    try {
      combined = multiSigPublicKey.combinePartialSignatures(partials);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail('malformed', source, `partial signatures could not be combined: ${detail}`);
    }

    /*
      Verify locally before returning. `combinePartialSignatures` does not check the threshold —
      only `verify()` does. See this file's header.
    */
    let valid: boolean;
    try {
      valid = await verify(bytes, combined);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return fail('malformed', source, `the combined signature could not be verified: ${detail}`);
    }

    if (!valid) {
      const availableWeight = options.available.reduce((sum, signer) => {
        const entry = publicKeys.find((p) => p.publicKey.toSuiAddress() === signer.address);
        return sum + (entry?.weight ?? 0);
      }, 0);
      return fail(
        'unconfigured',
        source,
        `the combined signature does not satisfy this multisig. The members available to this ` +
          `process carry ${availableWeight} of the ${options.threshold} weight required. ` +
          `Refused here rather than sent to a node, so the missing key is named instead of a ` +
          `rejection code.`,
      );
    }

    return ok<SerializedSignature>(combined);
  };

  return ok({
    address,
    scheme: 'multisig',
    signPersonalMessage: (bytes) =>
      combine(
        bytes,
        (signer, b) => signer.signPersonalMessage(b),
        (message, signature) => multiSigPublicKey.verifyPersonalMessage(message, signature),
        'personal message',
      ),
    signTransaction: (bytes) =>
      combine(
        bytes,
        (signer, b) => signer.signTransaction(b),
        (message, signature) => multiSigPublicKey.verifyTransaction(message, signature),
        'transaction',
      ),
  });
}
