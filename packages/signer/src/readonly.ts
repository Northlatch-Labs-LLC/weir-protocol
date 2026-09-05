// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `ReadOnlySigner` — an address with no key, which refuses loudly and never silently.
 *
 * # What this is for
 *
 * Three real situations, all of which otherwise end with a `null` signer and an `if` somewhere:
 * a dry-run deployment where the key is deliberately absent; a read-only observer that must still
 * know which address it is watching; and the default an operator gets when they have not
 * configured custody yet.
 *
 * # The failure is `unconfigured`, and the distinction matters
 *
 * `unconfigured` is the SDK's word for a deliberate, calm absence — not a fault. It is not
 * `transport`, because nothing will change on retry, and an agent loop that classified this as
 * transient would retry for ever against a signer that has no key and never will.
 *
 * # Why this exists rather than `signer?: Signer`
 *
 * An optional signer means every call site writes `if (signer)` and each one decides for itself
 * what the missing case means. One of them eventually decides it means "skip the signature and
 * carry on". A signer that is always present and always refuses cannot be skipped: the refusal is
 * a value the caller has to handle, and there is no branch where the absence quietly disappears.
 */

import { fail, type Reading } from '@projectx-social/sdk';
import type { SerializedSignature, Signer, SignerScheme } from './signer.js';

export interface ReadOnlySignerOptions {
  readonly address: string;
  /**
   * The scheme this address *would* use, when it is known.
   *
   * Recorded so a policy or a UI can say what custody is intended before it exists. It changes
   * nothing about the refusal — every signing call fails regardless.
   */
  readonly scheme?: SignerScheme;
  /**
   * Why there is no key, in the operator's own words.
   *
   * Appears in every refusal. "no key configured" sends someone reading code; "cold key is held
   * offline, sign with the operator tool" sends them to the thing that actually signs.
   */
  readonly because?: string;
}

export function readOnlySigner(options: ReadOnlySignerOptions): Signer {
  const source = `read-only signer ${options.address}`;
  const because =
    options.because ?? 'no signing key is configured for this address.';

  const refuse = (): Promise<Reading<SerializedSignature>> =>
    Promise.resolve(
      fail<SerializedSignature>(
        'unconfigured',
        source,
        `${because} Nothing was signed and nothing was submitted. This is a deliberate absence ` +
          `rather than a fault: retrying will produce the same refusal.`,
      ),
    );

  return {
    address: options.address,
    scheme: options.scheme ?? 'ed25519',
    signPersonalMessage: refuse,
    signTransaction: refuse,
  };
}
