// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `KmsSigner` — the interface is fixed; the implementation is deliberately absent.
 *
 * # Why there is no cloud SDK dependency here
 *
 * Adding `@aws-sdk/client-kms`, `@google-cloud/kms` or the Azure equivalent to this package would
 * pull tens of megabytes of transitive dependencies into the one place in this repository that
 * produces a signature — for a code path that cannot be exercised, because no key has been
 * provisioned in any of them. Dependencies of the signer are code with a vote on whether an agent
 * may spend. They are not added speculatively.
 *
 * So the shape is settled now, while it is cheap, and the transport is left to whoever has the
 * account. Settling the shape is the part that matters: it is what proves the custody tiers are
 * an axis this design already has rather than a rewrite it would need.
 *
 * # What a real implementation must do, and the two traps in it
 *
 * **1. Sui's Secp256r1 signatures must be low-`s`.** KMS backends return a DER-encoded ECDSA
 * signature and most of them do **not** normalise `s` to the lower half of the curve order. Sui
 * rejects a high-`s` signature. An implementation that forwards the DER bytes without converting
 * to 64-byte raw `r||s` and flipping `s` when it is above `n/2` produces signatures that verify
 * in the KMS console and are refused by the chain — intermittently, on roughly half of all
 * signatures, which is the worst possible failure rate to debug.
 *
 * **2. The public key must be fetched, not derived.** A Sui serialized signature carries the
 * public key, and a KMS key's public key is a separate API call. An implementation that cannot
 * make that call cannot produce a valid `SerializedSignature` at all, so the public key must be
 * read at construction time and the constructor must fail if it cannot be.
 *
 * # What a KMS does and does not fix
 *
 * It removes the key from this process's memory, which is the whole of its value and is real.
 * It does **not** make a weir account recoverable: the account is soulbound (see `signer.ts`), so
 * a compromised *caller* with the ability to invoke the KMS can still spend everything the policy
 * permits, and the handle still cannot move. KMS raises the cost of key theft; it does not change
 * what a stolen ability to sign is worth.
 */

import { fail, type Reading } from '@projectx-social/sdk';
import type { SerializedSignature, Signer } from './signer.js';

/**
 * The transport a real `KmsSigner` needs, and the whole of it.
 *
 * Two calls. Deliberately minimal, so a backend can be added without this file changing: the
 * caller brings the SDK, this package brings the intent wrapping, the address derivation and the
 * policy gate.
 *
 * Property-function members, for the variance reason in `signer.ts`.
 */
export interface KmsTransport {
  /** The SEC1-uncompressed or compressed public key bytes for the key. Read once, at construction. */
  readonly publicKey: () => Promise<Uint8Array>;
  /**
   * Sign a 32-byte digest, returning **raw 64-byte `r||s`**, low-`s` normalised.
   *
   * Not DER, and not high-`s`. See trap 1 in this file's header — the conversion is the
   * implementer's job because only they know what their backend returns.
   */
  readonly signDigest: (digest: Uint8Array) => Promise<Uint8Array>;
}

export interface KmsSignerOptions {
  readonly address: string;
  readonly transport?: KmsTransport;
}

/**
 * Construct a KMS-backed signer.
 *
 * With no `transport` — which is every caller today — this returns a signer whose every signing
 * call fails `unconfigured` with a message naming what is missing. It does not throw at
 * construction, so a deployment can be wired up and started before custody exists and will refuse
 * to spend rather than refuse to boot.
 *
 * A `transport` is currently rejected with the same failure kind and a message saying so
 * explicitly. **That is the honest state of this adapter**: the interface is fixed, the digest
 * construction and public-key handling are not written, and returning a plausible-looking
 * signature from an unimplemented path is exactly the class of defect this repository documents
 * rather than ships.
 */
export function kmsSigner(options: KmsSignerOptions): Signer {
  const source = `KMS signer ${options.address}`;
  const detail =
    options.transport === undefined
      ? 'no KMS transport is configured. KmsSigner is a documented stub: the interface is fixed ' +
        '(see KmsTransport) and no backend is implemented, because no key has been provisioned ' +
        'in any cloud KMS and this package takes no cloud SDK dependency speculatively.'
      : 'a KMS transport was supplied, but KmsSigner has no implementation to drive it. The ' +
        'digest construction and public-key handling are unwritten. Refusing rather than ' +
        'returning a signature from an unimplemented path.';

  const refuse = (): Promise<Reading<SerializedSignature>> =>
    Promise.resolve(fail<SerializedSignature>('unconfigured', source, detail));

  return {
    address: options.address,
    // Every cloud KMS that Sui can use offers P-256, and none offers Ed25519 for this purpose.
    scheme: 'secp256r1',
    signPersonalMessage: refuse,
    signTransaction: refuse,
  };
}
