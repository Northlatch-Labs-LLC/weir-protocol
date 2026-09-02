// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Opening sealed content from Node, with a keypair and no browser.
 *
 * # What was actually unproven here, and what this file settles
 *
 * Every sealed read this system has ever performed happened in a tab. `SealedMedia.tsx` and
 * `SealedBody.tsx` build a `SessionKey`, hand `sessionKey.getPersonalMessage()` to a **wallet**,
 * and put the wallet's signature back. That is the only path that has ever run, and the whole
 * agent economy depends on the question nobody had answered: can a headless process holding a raw
 * Ed25519 secret do the same thing?
 *
 * It can, and the reason is small enough to state in one sentence: `SessionKey.create` accepts an
 * optional `signer` — the installed 1.4.6 types name `EnokiSigner` as the example — and
 * `Ed25519Keypair` already implements that `Signer` interface, `signPersonalMessage` included. So
 * there is no wallet-shaped hole to fill. The certificate is produced by the same
 * `signPersonalMessage` a wallet would have called, on a key this process holds.
 *
 * Measured on mainnet before this file was written, with a freshly generated throwaway key that
 * has never held a coin:
 *
 * ```
 * SessionKey.create OK in 289 ms
 * personal message: Accessing keys of package 0xc5c833…404d for 10 mins from
 *                   2026-08-31 11:27:15 UTC, session key J1aStzvhPVZJZmyeqipbpxD40C4N9MWhNMxDHGMdV4A=
 * certificate signed with NO wallet: {"user":"0x4e94…6026","ttl_min":10,"sig_len":132}
 * ```
 *
 * The same run proved the other half of that call, which is the one that bites people: passing the
 * **latest** package id is refused with `InvalidPackageError: Package ID used in PTB is invalid`,
 * because `SessionKey.create` reads the package object and requires `version === 1`. The Seal
 * namespace is `config.packageId` and the call target is `config.latestPackageId`, they are
 * different addresses on this deployment, and getting them the wrong way round fails at a distance
 * from the mistake. `sealPackageId()` in the SDK is the only thing this file asks for a namespace.
 *
 * # THE PERMANENT CONSTRAINT — read this before extending anything below
 *
 * **A Seal key is a deterministic function of its identity. Once derived it exists for ever, and no
 * second check ever runs.** The key servers evaluate `entitlement::seal_approve_*` exactly once, at
 * derivation, with the requesting address as `ctx.sender()`. After that the 32 bytes are simply 32
 * bytes: no expiry, no revocation, no re-authorisation, nothing to take back.
 *
 * Therefore **this module must never be extended to let one address decrypt on another's behalf.**
 * No delegation parameter, no "decrypt for user X" argument, no shared session key, no service that
 * holds a fleet of agent keys and opens content for whichever caller asks. Every one of those turns
 * a single entitlement into a permanent, un-revocable key-issuing service for content the holder
 * did not buy — and it would do it silently, because the contract's check would still pass and
 * nothing downstream would look wrong.
 *
 * **Agents hold their own entitlements.** An agent that must read a creator's paid post buys that
 * post with its own address and opens it with its own key. That is not a limitation to engineer
 * around later; it is the property that makes the paywall mean anything at all. The full statement
 * of this rule, and why it is not negotiable, is in `packages/agent/SEAL.md`.
 *
 * # What is deliberately reused, and the one thing that is deliberately not
 *
 * The identity bytes come from `@projectx-social/sdk`'s `unlockIdentity` / `periodIdentity`, which
 * are held byte-for-byte against `entitlement.move` by tests in both languages. The approval
 * transaction comes from the SDK's `approveUnlock` / `approveSubscription`, which is what
 * `packages/web/lib/seal-open.ts`'s `approvalFor` itself calls. Nothing here hand-rolls a
 * `moveCall`; a previous desk did that and it was a breach of the estate's Survey Law.
 *
 * `approvalFor` is **not imported directly**, and the reason is layering rather than preference:
 * it lives in a Next.js application with no package exports, so importing it would make a
 * publishable package depend on a relative path into a web app. What replaces that import is
 * stronger than the import would have been — `test/seal-node.test.ts` loads the real `approvalFor`
 * at runtime and asserts this module's transaction is byte-identical to it, for both entitlement
 * kinds. The two cannot drift without a red test.
 *
 * # One live defect is worked around here, and it is not this package's to fix
 *
 * The SDK's approval, as built, **cannot be built**: `entitlementRef()` declares each entitlement
 * `{ mutable: false }`, and `@mysten/sui`'s resolver refuses a shared-object property on an input
 * that resolves to an owned object. That is measured against real mainnet entitlements and it
 * affected the shipped browser reader too. It is fixed at source in the SDK; this module carries the
 * measurements, the mechanism and the name of the file that should carry the real fix.
 *
 * The AES-GCM opener is re-implemented on `node:crypto` because `packages/web/lib/blob-crypto.ts`
 * carries `import 'server-only'`, which throws outside a Next server bundle. Same reasoning applies:
 * the test reads that file's own constants and asserts they still say 32 / 12 / 16, in the register
 * `packages/sdk/test/drift.test.ts` already established for a transcribed layout.
 *
 * # Order of operations, and why it differs from the browser on purpose
 *
 * The browser fetches the key first and the ciphertext second. This fetches the **ciphertext
 * first**. A Walrus read is public, free and unmetered; a key server request on this deployment
 * carries an API key and is rate-limited. A blob whose storage lease has expired is a real and
 * ordinary failure, and discovering it after spending a metered request is pure waste. Sequential
 * rather than parallel, for the same reason: `Promise.all` would spend the request anyway.
 *
 * The two are otherwise the same read, and the ending is identical and non-negotiable: the SHA-256
 * of the plaintext is compared against what the publisher recorded, and a mismatch throws. These
 * bytes travelled through storage nobody here operates and came back reassembled from slivers held
 * by many separate nodes. Returning them unchecked would let a hostile aggregator choose what an
 * agent reads and then acts on.
 */

import { createDecipheriv, createHash } from 'node:crypto';

import { EncryptedObject, InvalidParameterError, NoAccessError, SealClient, SessionKey } from '@mysten/seal';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import {
  approvalBytes,
  approveSubscription,
  approveUnlock,
  createClient,
  periodIdentity,
  sealId,
  sealPackageId,
  unlockIdentity,
  type ProjectXSocialConfig,
  type SealConfig,
} from '@projectx-social/sdk';

import type { AgentKey } from './keys.js';

/** AES-256. The blob key `blob-crypto.ts` produces, and the only length Seal is asked to carry. */
const KEY_BYTES = 32;
/** GCM's nonce. 96 bits, as the mode is specified for. */
const NONCE_BYTES = 12;
/** GCM's authentication tag, appended to the ciphertext by `blob-crypto.ts`. */
const TAG_BYTES = 16;

/**
 * How long one signed session lasts.
 *
 * Ten minutes, matching `SealedMedia.tsx` and `SealedBody.tsx` so an agent and a reader present
 * sessions of the same weight to the same key servers. The SDK's own bounds are 1 to 30 and it
 * throws outside them; a longer session is not free, because the certificate is a bearer credential
 * for the duration and an agent process is a longer-lived thing than a tab.
 */
const SESSION_TTL_MIN = 10;

/**
 * The settling window, and why a refusal is not always a refusal.
 *
 * A key server checks the policy by simulating `seal_approve_*` against a fullnode. A freshly
 * created `Unlock` is not indexed there for a few seconds, and the server maps that `NotFound` to a
 * refusal. The sequence an agent actually performs — buy, then read — has a real window in which
 * the address that just paid is told it has no access.
 *
 * This matters more for an agent than for a person. A human waits and clicks again. An agent takes
 * the refusal as a fact, writes it into a plan, and acts on a paywall that does not exist.
 *
 * Bounded, not indefinite: four attempts over roughly eleven seconds. A genuine refusal costs those
 * seconds and then says so plainly.
 */
const SETTLING_ATTEMPTS = 4;
const SETTLING_BACKOFF_MS = [1500, 3500, 6000] as const;

/**
 * Public Walrus read endpoints, tried in order.
 *
 * # Why this one value gets a default when nothing else in the estate does
 *
 * `packages/sdk/src/config.ts` refuses to default a package id, an endpoint or a key server list,
 * and it is right to: a defaulted key server encrypts a creator's media to a committee nobody
 * chose, and there is no recovery from that. This is the opposite case and the difference is worth
 * stating rather than assumed.
 *
 * A Walrus blob is public and content-addressed, and every byte fetched here is verified twice
 * before it is returned — once by GCM's authentication tag, which fails on a single altered byte,
 * and again by the SHA-256 the publisher recorded. So the worst a wrong or hostile aggregator can
 * do is refuse to answer. It cannot forge, it cannot substitute, and it cannot learn anything: the
 * bytes it serves are ciphertext and it never sees a key. A default here buys availability and
 * risks a denial of service that a second entry in the list already covers.
 *
 * These are the same two endpoints `SealedBody.tsx` holds in a module-private constant. That is a
 * duplication and it is named rather than hidden: when one of these operators goes away, both lists
 * have to change, and the right fix at that point is one shared configured value, not a third copy.
 */
export const PUBLIC_WALRUS_AGGREGATORS = [
  'https://aggregator.walrus-mainnet.walrus.space',
  'https://walrus.globalstake.io',
] as const;

/**
 * What the agent holds that entitles it, and therefore which approval to build.
 *
 * Structurally the same discriminated union as `Entitlement` in `packages/web/lib/seal-open.ts`,
 * and `test/seal-node.test.ts` asserts that both produce the same transaction rather than trusting
 * the shapes to stay aligned by inspection.
 *
 * The object id is required and cannot be derived. `seal_approve_unlock` takes `&Unlock` and
 * `seal_approve_subscription` takes `&Subscription` — both owned objects — so the entitlement the
 * agent holds must be named. Naming one it does not own is not an attack: the key servers execute
 * the policy with the agent as `ctx.sender()` and `assert!(unlock.buyer == ctx.sender())` aborts.
 */
export type SealApproval =
  | { kind: 'unlock'; vaultId: string; contentKey: string; unlockId: string }
  | {
      kind: 'subscription';
      vaultId: string;
      /**
       * Both `u64` on chain, and `bigint` here rather than `number`.
       *
       * A `Number` round trip is lossless for every value anyone will see and lossy eventually, and
       * the failure is silent: an identity built from a rounded period is the right length and the
       * wrong bytes, so the key server refuses it in a way that reads exactly like the agent having
       * no subscription at all.
       */
      tier: bigint;
      period: bigint;
      subscriptionId: string;
      /**
       * The vault's coin type: `creator::seal_approve_subscription<T>` must name `T` (v5). Required
       * here by the same rule as every other field — a caller that lacks it reads it from the vault
       * on chain (`readVaultCoinType`) before building the approval, as `Agent.read` does.
       */
      coinType: string;
    };

/**
 * One piece of sealed content, as the API and the database describe it.
 *
 * Field names match `posts.body_blob_id` / `body_seal_wrapped_key` / `body_nonce` / `body_sha256`
 * and the `x-seal-*` headers the media route sets, so a caller moving a row or a response into this
 * shape is renaming nothing.
 */
export interface SealedRef {
  /** The Walrus blob holding the ciphertext. Public — anyone may fetch it and nobody may read it. */
  blobId: string;
  /** The Seal `EncryptedObject`, base64. Public: useless without a threshold of key servers. */
  sealWrappedKey: string;
  /** GCM's nonce, base64. 12 bytes. Not secret, and the blob cannot be opened without it. */
  nonce: string;
  /** Lower-case hex SHA-256 of the **plaintext**, recorded at publish. Verified before returning. */
  sha256: string;
  /** The entitlement this agent presents, and the object it will be judged against. */
  approval: SealApproval;
}

/**
 * The plaintext did not hash to what the publisher recorded.
 *
 * A named class rather than a bare `Error` because this is the one failure a caller must never
 * catch-and-continue. Every other failure here means "you did not get the content"; this one means
 * "you got content that is not the content", which for an agent that acts on what it reads is the
 * difference between an outage and being fed instructions by whoever served the blob.
 */
export class SealHashMismatchError extends Error {
  override readonly name = 'SealHashMismatchError';
  constructor(
    readonly blobId: string,
    readonly expected: string,
    readonly actual: string,
  ) {
    super(
      `the bytes returned for blob ${blobId} do not match the hash recorded at publish ` +
        `(expected ${expected}, got ${actual})`,
    );
  }
}

/**
 * The one step that needs a threshold committee on the network, behind a seam.
 *
 * Everything else in this module is arithmetic, a public HTTP GET, or a transaction build — all of
 * which can be proven offline. This cannot: there are no open Seal key servers on Sui mainnet, every
 * provider is permissioned, and enrolling one costs money. The seam is what lets the pipeline be
 * tested end to end without it, and it is not a mock in production — the real implementation is the
 * five lines in {@link SealDecryptor.recoverKeyFromCommittee}.
 */
export type RecoverKey = (input: {
  /** The Seal `EncryptedObject`, raw bytes. */
  wrappedKey: Uint8Array;
  /** The serialised approval, `onlyTransactionKind`. */
  txBytes: Uint8Array;
}) => Promise<Uint8Array>;

export interface SealDecryptorOptions {
  /** The deployment. `packageId` namespaces every identity; `latestPackageId` is the call target. */
  config: ProjectXSocialConfig;
  /**
   * The key server committee, from `loadSealConfig`.
   *
   * Optional only because a caller supplying its own {@link recoverKey} — the offline tests, and
   * any future proxy arrangement — has no committee to name. A decryptor with neither refuses at
   * the point of use rather than at construction, so an agent that only ever reads free content
   * does not fail to start over a variable it will never use.
   */
  seal?: SealConfig;
  /** The agent's own key. It signs the session certificate; nothing else in this module signs. */
  key: AgentKey;
  /**
   * A chain client. gRPC, always.
   *
   * Sui JSON-RPC is dead on public fullnodes — `sui-contracts/deploy/mainnet.json` records
   * `suix_getLatestSuiSystemState` answering `-32601 "JSON-RPC on public fullnodes has been
   * deprecated"` on 14 Aug 2026. `createClient` returns a `SuiGrpcClient` and there is no other
   * constructor reachable from here. Verified this session that `SuiGrpcClient` satisfies Seal's
   * `SealCompatibleClient`: it exposes `.core`, which is the only member Seal reaches for.
   */
  suiClient?: SuiGrpcClient;
  /** Where to read ciphertext from. Defaults to {@link PUBLIC_WALRUS_AGGREGATORS}. */
  aggregators?: readonly string[];
  /** Injectable for tests and for a deployment behind a proxy. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Minutes, 1 to 30. Defaults to {@link SESSION_TTL_MIN}. */
  sessionTtlMin?: number;
  /** Replaces the key server round trip. See {@link RecoverKey}. */
  recoverKey?: RecoverKey;
  /** Injectable so a test does not sleep for eleven seconds. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
}

/** The identity an approval covers, derived by the shared code the contract is held against. */
export function identityForApproval(approval: SealApproval): Uint8Array {
  return approval.kind === 'unlock'
    ? /*
         UTF-8, because `content_key` is `vector<u8>` in Move and the contract matches it
         byte-for-byte without interpreting it. The application stores it as text, so UTF-8 is the
         encoding that round-trips — and it must be the same encoding `creator::unlock` was called
         with, or the agent holds an `Unlock` whose identity does not match the one the content was
         sealed to.
      */
      unlockIdentity(approval.vaultId, new TextEncoder().encode(approval.contentKey))
    : periodIdentity(approval.vaultId, approval.tier, approval.period);
}

/**
 * Build the transaction the key servers will dry-run to decide.
 *
 * Never signed and never submitted. It is evidence, not an action: the key servers execute it with
 * the agent as sender and release a share if it does not abort. No gas budget, gas price or payment
 * is set, and the absence of them is correct rather than an oversight — see `approvalBytes`.
 *
 * The dispatch is the same one `approvalFor` performs in `packages/web/lib/seal-open.ts`, and both
 * delegate to the SDK builders. `test/seal-node.test.ts` asserts the two produce identical
 * transaction data for both kinds, which is the property that stops them drifting.
 */
export function approvalTransactionFor(
  config: ProjectXSocialConfig,
  approval: SealApproval,
): Transaction {
  const identity = identityForApproval(approval);
  return approval.kind === 'unlock'
    ? approveUnlock(config, { identity, unlockId: approval.unlockId })
    : approveSubscription(config, {
        identity,
        tier: approval.tier,
        period: approval.period,
        subscriptionId: approval.subscriptionId,
        vaultId: approval.vaultId,
        coinType: approval.coinType,
      });
}

/*
 * REMOVED 2026-08-31: `makeEntitlementRefsResolvable`, the build plugin that stripped `mutable`.
 *
 * `packages/sdk/src/seal.ts::entitlementRef()` declared `mutable: false` on entitlements. That key
 * is a SHARED-object property and `Unlock`/`Subscription` are owned, so `@mysten/sui` refused every
 * approval it appeared on — `transactions/TransactionData.ts` rejects on `original.mutable != null`,
 * the PRESENCE of the key, so `mutable: true` failed identically. Measured on mainnet against real
 * objects with 2.27.1: `approvalFor` FAILED on both an unlock and a subscription; plain
 * `tx.object(id)` built 207 bytes. Present in 2.24.0 through 2.27.1 — never a regression, never
 * buildable.
 *
 * This module carried a plugin that deleted the key on the way past. **The SDK is now fixed at
 * source, so the plugin is deleted rather than left as a no-op.** A no-op that strips a key nobody
 * sets is worse than nothing: it would silently absorb the regression if anyone reintroduced
 * `mutable`, and the point of fixing it in the SDK was to have exactly one guard in exactly one
 * place. That guard is `packages/sdk/test/entitlement-ref.test.ts`, which asserts the key is ABSENT
 * — not that it holds some value — because any value fails.
 */

/** Lower-case hex SHA-256, to compare against what the publisher recorded. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Open the blob once the key has been recovered.
 *
 * The layout is `blob-crypto.ts`'s and is transcribed rather than imported, because that module
 * carries `import 'server-only'` and throws outside a Next server bundle:
 *
 * ```
 * ciphertext = AES-256-GCM body ‖ 16-byte tag      nonce = 12 bytes      key = 32 bytes
 * ```
 *
 * `decipher.final()` is what raises on a failed tag check, and it is the reason the tag is not
 * skipped: without it a forged or altered blob decodes to plausible-looking plaintext, which is the
 * whole failure this mode exists to prevent.
 */
export function openBlob(input: {
  ciphertext: Uint8Array;
  key: Uint8Array;
  nonce: Uint8Array;
}): Uint8Array {
  if (input.key.length !== KEY_BYTES) {
    throw new Error(`a blob key must be ${KEY_BYTES} bytes; this one is ${input.key.length}`);
  }
  if (input.nonce.length !== NONCE_BYTES) {
    throw new Error(`a blob nonce must be ${NONCE_BYTES} bytes; this one is ${input.nonce.length}`);
  }
  if (input.ciphertext.length <= TAG_BYTES) {
    throw new Error('this ciphertext is too short to carry an authentication tag');
  }

  const split = input.ciphertext.length - TAG_BYTES;
  const decipher = createDecipheriv('aes-256-gcm', input.key, input.nonce);
  decipher.setAuthTag(input.ciphertext.subarray(split));
  return new Uint8Array(
    Buffer.concat([decipher.update(input.ciphertext.subarray(0, split)), decipher.final()]),
  );
}

/**
 * A refusal that may simply be the chain catching up, rather than an agent without entitlement.
 *
 * `instanceof`, not a regex on the message. Every error `@mysten/seal` throws reports
 * `error.name === "Error"` (its classes are anonymous class expressions), and the text this used
 * to match — "not yet exist" — is one word away from what `InvalidParameterError` actually says
 * ("… the FN has not yet seen"). So the retry never fired on the one case it was written for: an
 * agent that has just paid and is told it has no access. The web side (`lib/seal-open.ts`,
 * `isSettling`) made the same correction; this is the agent's half of it.
 */
export function looksLikeSettling(error: unknown): boolean {
  if (error instanceof InvalidParameterError) return true;
  if (error instanceof NoAccessError) return true;
  // The committee was unreachable, not the reader unentitled: also worth the bounded retry.
  const text = error instanceof Error ? error.message : String(error);
  return /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed? ?out|503|502/i.test(text);
}

function base64(value: string, field: string, expected?: number): Uint8Array {
  const bytes = new Uint8Array(Buffer.from(value, 'base64'));
  /*
    `Buffer.from(…, 'base64')` never throws — it discards anything that is not base64 and returns
    whatever it managed to decode. So the length check is not belt-and-braces, it is the only
    check: a mangled header silently becomes a short buffer, and a short nonce or key produces an
    authentication failure attributed to the wrong cause. Where no length is known (the wrapped
    key), an empty result is still refused, because "" decodes happily to zero bytes.
  */
  if (bytes.length === 0) throw new Error(`${field} decoded to nothing; it is not base64`);
  if (expected !== undefined && bytes.length !== expected) {
    throw new Error(`${field} must be ${expected} bytes; this one is ${bytes.length}`);
  }
  return bytes;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sealed content, opened by an agent, for that agent.
 *
 * Construct one per agent key and keep it: the session key is created lazily, signed once, and
 * reused until it expires, so a run that opens twenty posts signs one certificate rather than
 * twenty. Concurrent calls share the in-flight creation instead of racing to make several.
 */
export class SealDecryptor {
  readonly #options: SealDecryptorOptions;
  readonly #client: SuiGrpcClient;
  readonly #fetch: typeof fetch;
  readonly #aggregators: readonly string[];
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #ttlMin: number;

  /** The current session, or the promise creating it. Never two at once. */
  #session: Promise<SessionKey> | null = null;
  #seal: SealClient | null = null;

  constructor(options: SealDecryptorOptions) {
    this.#options = options;
    this.#client = options.suiClient ?? createClient(options.config);
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#aggregators = options.aggregators ?? PUBLIC_WALRUS_AGGREGATORS;
    this.#sleep = options.sleep ?? realSleep;
    this.#ttlMin = options.sessionTtlMin ?? SESSION_TTL_MIN;

    if (this.#aggregators.length === 0) {
      throw new Error('a decryptor needs at least one Walrus aggregator to read ciphertext from');
    }
  }

  /** The address every key this decryptor recovers is derived on behalf of. Never another. */
  get address(): string {
    return this.#options.key.address;
  }

  /**
   * Recover the key, open the blob, and refuse anything that is not what the publisher stored.
   *
   * Throws rather than returning a `Reading`, which is the opposite of the SDK's habit and is
   * deliberate. The estate uses `Reading` where a failure is a fact the caller routes on — an
   * unconfigured variable, an absent object. Here every failure means the agent does not have the
   * content, and the one failure that must be impossible to ignore is the hash mismatch. A value a
   * caller can forget to check is exactly the wrong shape for "these bytes are not the bytes".
   */
  async decrypt(ref: SealedRef): Promise<Uint8Array> {
    const identity = identityForApproval(ref.approval);
    const wrappedKey = base64(ref.sealWrappedKey, 'sealWrappedKey');
    const nonce = base64(ref.nonce, 'nonce', NONCE_BYTES);

    /*
      Checked here, before anything is fetched and before a metered request is spent.

      The identity is already inside the encrypted object, and the key servers assert
      `id == unlock_identity(unlock.vault, unlock.content_key)`. So an approval that names a
      different vault, a different content key, or a different period than the one this object was
      sealed to is refused by `EWrongIdentity` — which arrives as a `MoveAbort` and reads, to
      anything above it, exactly like "you have no entitlement". That is a wrong and alarming
      answer to give an agent that holds a perfectly good `Unlock` for the wrong post.
    */
    const sealedTo = EncryptedObject.parse(wrappedKey).id;
    const asked = sealId(identity);
    if (sealedTo !== asked) {
      throw new Error(
        `this content is sealed to identity ${sealedTo} and the approval offered covers ` +
          `${asked} — the entitlement named does not open this blob`,
      );
    }

    // Ciphertext first. Free and unmetered; see this file's header.
    const ciphertext = await this.#fetchBlob(ref.blobId);

    const txBytes = await this.approvalBytesFor(ref.approval);
    const recover = this.#options.recoverKey ?? ((input) => this.recoverKeyFromCommittee(input));

    let key: Uint8Array | undefined;
    let last: unknown;
    for (let attempt = 0; attempt < SETTLING_ATTEMPTS; attempt += 1) {
      try {
        key = await recover({ wrappedKey, txBytes });
        break;
      } catch (error) {
        last = error;
        if (!looksLikeSettling(error)) throw error;
        const backoff = SETTLING_BACKOFF_MS[attempt];
        if (backoff === undefined) break;
        await this.#sleep(backoff);
      }
    }
    if (key === undefined) throw last ?? new Error('the key could not be recovered');

    const bytes = openBlob({ ciphertext, key, nonce });

    const digest = sha256Hex(bytes);
    if (digest !== ref.sha256) {
      // Not returned with a warning, and not logged and passed on. Bytes that are not what the
      // publisher stored are not the publisher's work, and an agent that acts on them is acting on
      // whatever the aggregator chose to serve.
      throw new SealHashMismatchError(ref.blobId, ref.sha256, digest);
    }

    return bytes;
  }

  /**
   * Serialise an approval for the key servers.
   *
   * `onlyTransactionKind: true` is required, not a size optimisation: the agent is not paying for
   * this and may hold no gas coin at all, so a fully built transaction would fail to serialise for
   * want of a gas payment before it ever reached a key server.
   *
   * The sender is set anyway, matching `SealedBody.tsx`. It is not serialised under
   * `onlyTransactionKind` — the key servers substitute the certificate's `user` — but leaving it
   * unset means the one place this module names the address it is acting for is the session key,
   * and this call should read the same way it reads in the browser.
   */
  async approvalBytesFor(approval: SealApproval): Promise<Uint8Array> {
    const tx = approvalTransactionFor(this.#options.config, approval);
    tx.setSender(this.address);
    return approvalBytes(tx, this.#client);
  }

  /**
   * The agent's signed session, created once and reused until it expires.
   *
   * This is the whole point of the module and it is four lines. `signer` is the agent's
   * `Ed25519Keypair`; `SessionKey`'s own constructor asserts
   * `signer.getPublicKey().toSuiAddress() === address`, so a decryptor built with a key and an
   * address that disagree throws here rather than producing a certificate no key server accepts.
   *
   * `getCertificate()` is called eagerly to force the signature now. The SDK would otherwise sign
   * lazily inside `decrypt`, and a signing failure surfacing from the middle of a threshold key
   * fetch is a failure attributed to the wrong thing.
   */
  async sessionKey(): Promise<SessionKey> {
    const existing = this.#session;
    if (existing !== null) {
      const session = await existing;
      if (!session.isExpired()) return session;
      // Expired. Dropped rather than mutated, so a concurrent caller awaiting the old promise still
      // gets a coherent object and the next caller creates the replacement.
      this.#session = null;
    }

    this.#session ??= (async () => {
      const session = await SessionKey.create({
        address: this.address,
        // The ORIGINAL package. `SessionKey.create` reads the package object and throws
        // `InvalidPackageError` unless its version is exactly 1 — measured this session against
        // both ids on mainnet.
        packageId: sealPackageId(this.#options.config),
        ttlMin: this.#ttlMin,
        signer: this.#options.key.keypair,
        suiClient: this.#client,
      });
      await session.getCertificate();
      return session;
    })().catch((error: unknown) => {
      // Discarded on failure so a process that started before its network did can succeed later,
      // rather than caching the outage for its lifetime.
      this.#session = null;
      throw error;
    });

    return this.#session;
  }

  /**
   * Ask the committee for the key. The only network path to a key server in this package.
   *
   * `verifyKeyServers` is set explicitly and set to `true`. The shipped 1.4.6 code reads
   * `options.verifyKeyServers ?? false` while Mysten's published documentation states the default
   * is `true` — anyone following their documentation gets unverified key servers. The estate sets
   * it at every call site for that reason and this is another one; it is never left to the default.
   */
  async recoverKeyFromCommittee(input: {
    wrappedKey: Uint8Array;
    txBytes: Uint8Array;
  }): Promise<Uint8Array> {
    const seal = this.#options.seal;
    if (seal === undefined) {
      throw new Error(
        'this decryptor was built with no key server committee and no recoverKey seam, so it ' +
          'cannot open sealed content — set PROJECTX_SOCIAL_SEAL_KEY_SERVERS and pass loadSealConfig()',
      );
    }

    this.#seal ??= new SealClient({
      suiClient: this.#client,
      serverConfigs: seal.keyServers.map((server) => ({
        objectId: server.objectId,
        weight: server.weight,
        /*
          Spread rather than assigned, in both cases, because the SDK distinguishes a
          committee-mode server from an independent one by whether `aggregatorUrl` is *present* —
          `aggregatorUrl: undefined` is not the same thing as absent — and it throws
          `InvalidClientOptionsError` unless `apiKeyName` and `apiKey` are both present or both
          absent, where an explicit `undefined` counts as present.
        */
        ...(server.aggregatorUrl === undefined ? {} : { aggregatorUrl: server.aggregatorUrl }),
        ...(server.apiKeyName === undefined || server.apiKey === undefined
          ? {}
          : { apiKeyName: server.apiKeyName, apiKey: server.apiKey }),
      })),
      verifyKeyServers: true,
    });

    const sessionKey = await this.sessionKey();
    const key = await this.#seal.decrypt({
      data: input.wrappedKey,
      sessionKey,
      txBytes: input.txBytes,
    });
    return new Uint8Array(key);
  }

  /**
   * Fetch ciphertext from the first aggregator that answers.
   *
   * Every aggregator is tried before failing, and the failure names all of them. One operator being
   * unreachable is a fact about that operator, not about the agent's entitlement, and a paid post
   * should not be unreadable because one public gateway is down. Nothing is trusted about the bytes
   * that come back — GCM's tag and the SHA-256 both still have to pass.
   */
  async #fetchBlob(blobId: string): Promise<Uint8Array> {
    const failures: string[] = [];
    for (const base of this.#aggregators) {
      const url = `${base.replace(/\/+$/, '')}/v1/blobs/${encodeURIComponent(blobId)}`;
      try {
        const response = await this.#fetch(url);
        if (!response.ok) {
          failures.push(`${base} answered ${response.status}`);
          continue;
        }
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        failures.push(`${base} ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(
      `no aggregator served blob ${blobId} — its storage lease may have expired. ` +
        `Tried: ${failures.join('; ')}`,
    );
  }
}
