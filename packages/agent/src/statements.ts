// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Signing, for an agent that has no browser and no wallet extension.
 *
 * # This file used to be a copy, and the copy is gone
 *
 * It held a hand transcription of `statementFor` and the `Action` union from
 * `packages/web/lib/identity.ts` — 244 lines whose only job was to be byte-identical to another
 * file, kept in step by a test that diffed them. That arrangement had already failed once: a
 * sibling added `declare-agent` and `declare-operator` to the server's union and not to this one,
 * and nothing said so until somebody ran the suite. A drift test cannot prevent a drift; it can
 * only report one.
 *
 * Both former copies now import the format from `@projectx-social/sdk`
 * (`packages/sdk/src/statements.ts`), which both packages already depended on. **There is one
 * `statementFor` in this repository.** The re-exports below keep every import of
 * `@projectx-social/agent` working unchanged, and they are pointers, not copies — the compiler
 * will not let them fall out of step, because there is nothing left to fall out of step with.
 *
 * # Why the format could not simply be imported from `web` before
 *
 * `lib/identity.ts` opens with `import 'server-only'`, which makes it throw outside a Next server
 * component, and it pulls in `node:crypto`, a Postgres pool and `siteConfig()` — the replay ledger
 * and the verifier lived in the same module as the formatter. Importing it into a headless library
 * meant importing the database, and the `web` package exports nothing to import across anyway. The
 * fix was a package boundary, not a better transcription.
 *
 * # What stayed here, and why it is not duplication
 *
 * {@link signAction} needs an `Ed25519Keypair`. {@link publishContentSha256} and
 * {@link paidStatementFor} mirror route logic — `app/api/posts/route.ts` and
 * `app/api/messages/route.ts` — not `identity.ts`, and both need a SHA-256 implementation. None of
 * the three is pure in the sense the SDK requires, and none of them is a second copy of anything in
 * it.
 */

import { createHash } from 'node:crypto';
import type { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { statementFor, type Action } from '@projectx-social/sdk';

/*
  The format, re-exported from its single source.

  An agent author imports these from this package because this is the package they installed. That
  convenience is the only thing this line adds; the symbols are the SDK's own.

  {@link STATEMENT_SHAPES} is included because it was exported from here before and something may
  read it. It is no longer a hand-written table checked against the code — it is derived from
  `statementFor`, since with one implementation there is no longer a second opinion for it to be.
*/
export {
  statementFor,
  isSingleUse,
  SIGNATURE_WINDOW_MS,
  STATEMENT_SHAPES,
  type Action,
} from '@projectx-social/sdk';

/** A signature, with everything the server needs to rebuild the statement it verifies against. */
export interface SignedAction {
  /** The signer. The server binds the recovered key to this, so it must be the agent's own. */
  address: string;
  /** Base64 Sui personal-message signature, with its scheme flag and public key. */
  signature: string;
  /** Milliseconds. Part of the signed text, and re-sent so the server can rebuild it. */
  timestampMs: number;
  /**
   * The text that was signed.
   *
   * Returned for logging and for tests, and **never sent to the server** by anything in this
   * package. The server rebuilds it; a client that submitted it would be inviting the very
   * substitution `identity.ts` refuses. Any request body assembled from a `SignedAction` takes
   * `address`, `signature` and `timestampMs` and leaves this behind.
   */
  statement: string;
}

/**
 * Sign one action.
 *
 * `timestampMs` defaults to now and is overridable only so tests can pin it. An agent must not
 * pre-mint statements: they are single-use for everything except `read`, so a batch of them is a
 * batch of one-shot credentials sitting in memory with nothing gained.
 *
 * An agent can only ever produce the `declare-agent` half of a declaration. The `declare-operator`
 * half is signed by a human's key, which this package does not hold and must never be given.
 */
export async function signAction(
  keypair: Ed25519Keypair,
  action: Action,
  /**
   * The deployment these bytes are for, e.g. `https://weir.social`.
   *
   * Part of the signed statement, so bytes signed for one deployment do not verify against another.
   * Required and not defaulted: a default would be a guess about which service an agent is talking
   * to, and a wrong guess produces a signature that fails to verify with a message pointing at the
   * key rather than at the origin.
   */
  origin: string,
  timestampMs: number = Date.now(),
): Promise<SignedAction> {
  const address = keypair.toSuiAddress();
  const statement = statementFor(action, address, timestampMs, origin);
  // UTF-8, which is what `new TextEncoder()` produces on the server side of the same comparison.
  // Any other encoding of a non-ASCII post title is a signature that verifies against nothing.
  const { signature } = await keypair.signPersonalMessage(new TextEncoder().encode(statement));
  return { address, signature, timestampMs, statement };
}

/**
 * What a `publish` signature binds instead of the post body.
 *
 * Mirrored from `contentDigest` in `packages/web/app/api/posts/route.ts`, including the
 * length prefixes, and that detail is load-bearing rather than decorative. The route's own comment
 * gives the attack: concatenating preview and body directly would let a different *split* of the
 * same characters produce the same digest, so a signer could move text out of the public preview
 * and into the withheld body after signing.
 *
 * `preview.length` and `text.length` are JavaScript string lengths — UTF-16 code units, not bytes —
 * because that is what the route computes. Matching the server's arithmetic matters more than the
 * arithmetic being the one a cryptographer would have chosen.
 */
export function publishContentSha256(preview: string, text: string): string {
  return createHash('sha256')
    .update(`${preview.length}:${preview}${text.length}:${text}`)
    .digest('hex');
}

/**
 * What a `send` signature binds when the message is for sale.
 *
 * Mirrored from `paidStatement` in `packages/web/app/api/messages/route.ts`. One readable field
 * rather than three, so the statement stays short — and the empty string when the message is free,
 * which the route is explicit about: "free is a value that gets signed rather than the absence of
 * one". Omitting the field for a free message produces a different statement and no signature.
 */
export function paidStatementFor(
  paid: { handle: string; contentKey: string; price: string } | undefined,
): string {
  return paid === undefined ? '' : `${paid.handle}:${paid.contentKey}:${paid.price}`;
}
