// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `@projectx-social/agent` — weir, for a program.
 *
 * # What this is
 *
 * A headless Node library that lets an AI agent hold a weir account, read what it has paid for,
 * and pay for more. It has its own Ed25519 keypair, its own address, its own `SocialAccount` and
 * its own coins. There is no browser, no wallet extension and no zkLogin anywhere in it.
 *
 * # What it is not, and this is the important half
 *
 * **It adds no authority.** Every call below goes through a door that already existed:
 *
 *   - Writes are `verifyAction` signatures over statements this package formats byte-for-byte the
 *     way `packages/web/lib/identity.ts` does. The server rebuilds them and cannot tell an agent
 *     from a hardware wallet, because there is nothing to tell apart.
 *   - Reads are the same day-long, revocable, read-only session a browser gets from
 *     `POST /api/session`.
 *   - Money moves through `creator::unlock`, `creator::subscribe` and `creator::tip` on the
 *     deployed package, built by `packages/sdk/src/tx.ts`. **No Move code was changed for this and
 *     no package upgrade is implied.**
 *
 * There is no capability, no admin path, no privileged route and no bypass. An agent that lost its
 * key loses exactly what any address loses.
 *
 * # The one thing that is genuinely new: a spending ceiling
 *
 * An agent decides what to buy from text somebody else wrote. `maxPrice` is required on every
 * method here that can spend, it is compared against a price read **from the chain** rather than
 * from any feed or API, and over the ceiling the call refuses rather than clamping. See
 * {@link guardPrice} in `tx.ts` for the full argument — it is the reason this package can be
 * pointed at a language model at all.
 *
 * # Every read returns a `Reading`, including the refusals
 *
 * Nothing here throws for an expected outcome and nothing returns a default. An agent runs
 * unattended, and the SDK's own reason applies with force: a failure flattened to a plausible zero
 * is an outage that looks like an observation, and the process acts on the observation.
 */

import { accessStatement, createClient, fail, ok, readVaultCoinType, type ProjectXSocialConfig, type Reading } from '@projectx-social/sdk';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  agentKeyFromEnv,
  agentKeyFromSecret,
  generateAgentKey,
  normaliseAddress,
  sameAddress,
  type AgentKey,
} from './keys.js';
import {
  paidStatementFor,
  publishContentSha256,
  signAction,
  type Action,
  type SignedAction,
} from './statements.js';
import { openSession, type FetchLike, type SessionCredential } from './session.js';
import { looksLikeSettling } from './seal-node.js';
import {
  buildSubscribe,
  buildTip,
  buildUnlock,
  buildOpenAccount,
  buildSetContentPrice,
  findAgentAccount,
  findCreatorCap,
  guardPrice,
  MACHINE_EDITION_MARKER,
  livePriceOfContent,
  readPayableVault,
  refusePrecondition,
  simulateAndExecute,
  tierAt,
  totalBalance,
  type Executed,
  type SpendCeiling,
  type PaymentSource,
  type TransactionSigner,
} from './tx.js';
import { loadAgentManifest, type AgentManifest } from './manifest.js';
import {
  buildPublishKey,
  deriveMindKey,
  fetchBlob,
  LABEL,
  openMind,
  PUBLIC_WALRUS_AGGREGATORS,
  registryStateFor,
  sealMind,
  type MindKeyPair,
  type MindSigner,
  type Recalled,
  type Remembered,
} from './mind.js';

export {
  agentKeyFromEnv,
  agentKeyFromSecret,
  generateAgentKey,
  normaliseAddress,
  sameAddress,
  type AgentKey,
} from './keys.js';
export {
  paidStatementFor,
  publishContentSha256,
  signAction,
  statementFor,
  SIGNATURE_WINDOW_MS,
  STATEMENT_SHAPES,
  type Action,
  type SignedAction,
} from './statements.js';
export {
  openSession,
  readSessionCookieFrom,
  BEARER_FIELDS,
  READ_SESSION_COOKIE,
  type FetchLike,
  type SessionCredential,
} from './session.js';
export {
  ABORT_CLASSIFICATION,
  PRECONDITION_MARKER,
  type PaymentSource,
  type TransactionSigner,
  buildOpenAccount,
  buildSetContentPrice,
  buildSubscribe,
  buildTip,
  buildUnlock,
  classificationOf,
  classifyAbort,
  findAgentAccount,
  findCreatorCap,
  guardPrice,
  livePriceOfContent,
  MACHINE_EDITION_MARKER,
  preconditionOf,
  readPayableVault,
  refusePrecondition,
  simulateAndExecute,
  tierAt,
  totalBalance,
  type Executed,
  type Precondition,
  type PreconditionName,
  type SpendCeiling,
} from './tx.js';
export {
  loadAgentManifest,
  isCoinType,
  isObjectId,
  AGENT_ENV,
  DEFAULT_GAS_BUDGET_MIST,
  MAINNET_RECORD,
  type AgentManifest,
} from './manifest.js';

// === Seal ===

/*
  The two Seal shapes below are IMPORTED, not declared.

  They were declared here — a `SealApproval` union and a `decrypt(input: {...})` parameter written
  out field by field — with a doc block that ended "the type system will not catch this one, so the
  two definitions have to be kept aligned by hand". That sentence was the defect. `seal-node.ts`
  builds the identity from these fields; this file only names them; and a shape that one module
  constructs and another retypes is a shape that drifts, silently, in the direction of an identity
  built from `undefined` — which is the right length, the wrong bytes, and reads to a key server
  exactly like an agent with no entitlement at all.

  `import type` is erased entirely under `verbatimModuleSyntax`, so this costs nothing at runtime
  and nothing in this file's runtime graph: no `@mysten/seal`, no key server credential, no
  threshold. What it buys is that there is now one definition of each shape and the compiler owns
  the alignment instead of a comment asking a human to.
*/
export type { SealApproval, SealedRef } from './seal-node.js';
export {
  deriveMindKey,
  registryStateFor,
  buildPublishKey,
  sealMind,
  openMind,
  fetchBlob,
  sha256Hex,
  LABEL as MIND_LABEL,
  AGGREGATOR_TIMEOUT_MS,
  type MindSigner,
  type MindKeyPair,
  type Remembered,
  type Recalled,
  type RegistryState,
} from './mind.js';
import type { SealedRef } from './seal-node.js';

/**
 * Turning sealed bytes back into content. **This package's `index` does not implement it.**
 *
 * # Property-function syntax, and it is not a style choice
 *
 * `decrypt` is declared `decrypt: (input: SealedRef) => Promise<Uint8Array>` and **must never be
 * rewritten as `decrypt(input: SealedRef): Promise<Uint8Array>`.** The two look identical and are
 * checked by completely different rules.
 *
 * Under `strictFunctionTypes`, TypeScript compares **method** parameters **bivariantly** — a
 * deliberate unsoundness kept for arrays and the DOM — and compares **property-function**
 * parameters **contravariantly**, which is the sound rule. Method syntax therefore accepts an
 * implementation that demands MORE of its argument than the interface promises to supply.
 *
 * That is not hypothetical here; it is what happened. This interface was written with method
 * syntax and a `SealApproval` that had no `vaultId` and no `contentKey`. The real implementation
 * requires both, because `unlockIdentity(vaultId, contentKey)` and `periodIdentity(vaultId, tier,
 * period)` in `packages/sdk/src/seal.ts` derive the identity from the vault's bytes — an approval
 * without the vault cannot produce an identity at all. **The compiler accepted the mismatch in
 * silence.** It would have surfaced at run time as a key server refusing an identity built from
 * `undefined`, which is indistinguishable from having no entitlement.
 *
 * `test/interface-variance.test.ts` proves the hole is shut and keeps proving it: it compiles a
 * deliberately over-specified implementation under `@ts-expect-error`, so if anyone restores
 * method syntax the error stops appearing, the directive becomes unused, and `tsc` fails. It also
 * scans this package's own sources for method-syntax members and fails on any it finds, which is
 * the half that catches the NEXT interface somebody adds rather than only this one.
 *
 * # Why the interface lives here and the implementation does not
 *
 * `createAgent` takes an optional instance and calls nothing on it unless asked. `seal-node.ts`
 * exports a class that satisfies this shape; a caller may supply their own. Every field of
 * {@link SealedRef} is required and none has a default — a decryptor missing the nonce or the
 * wrapped key cannot fail safely, only late, with an error describing arithmetic rather than a
 * missing input.
 */
export interface SealDecryptor {
  decrypt: (input: SealedRef) => Promise<Uint8Array>;
}

// === The agent ===

/*
  `FeedPost` and `Agent.feed()` are GONE, and so is `quote(postId)`. They are not commented out and
  they are not deprecated; they are removed.

  # Why they could never have worked

  Both went through `GET /api/posts`. `packages/web/app/api/posts/route.ts` exports exactly two
  things — `dynamic` at :18 and `POST` at :47. There is no `GET`, there never was one on this
  deployment, and Next.js answers an unimplemented method with 405. So every call returned a
  refusal, always, on every deployment.

  The old `feed()` carried a long, accurate, apologetic failure message explaining that the endpoint
  probably did not exist yet. That message was the tell. **An honest error does not make an
  exported method honest**: a public surface that cannot succeed is a promise, and a caller reading
  the type signature has no way to learn from it that the answer is always no. It also conflated
  two different facts under one `not-found` — "this deployment has no such endpoint" and "there is
  no such post" — which are opposite instructions to an agent.

  # Why they were not rebuilt from chain events instead

  That was the other option and it was measured rather than assumed. It cannot be done, because a
  post is not on chain and never has been. `sui-contracts/sources/creator.move` emits ten event
  types; the only one touching content is `ContentPriced { vault, content_key, price }` at :205,
  with `ContentUnpriced` at :211. There is no title, no preview, no body, no author handle and no
  publication time in any of them — a post lives in Postgres, and the chain knows only that some
  opaque key under some vault has a price. Reconstructing a feed from that would produce a list of
  byte strings with numbers beside them, which is not a feed; it would be a worse lie than the 405.

  # What is left, and it works

  `quote({ vaultId, contentKey })` reads the price from the vault on chain and is untouched. That
  is the call that matters, because it is the one a spending decision depends on, and it was always
  the honest half: `locatePost` existed only to turn a post id into those two identifiers by asking
  an HTTP endpoint, and it explicitly threw the endpoint's price away.

  When a JSON feed endpoint exists, `feed()` comes back — against a route somebody can point at.
*/

/** What one purchase would cost, priced from the chain and nowhere else. */
export interface Quote {
  vaultId: string;
  contentKey: string;
  coinType: string;
  /** The live on-chain price, in minor units. This is the number `maxPrice` is compared against. */
  priceMinorUnits: bigint;
  /** The creator. An agent cannot buy from a vault it owns. */
  owner: string;
  /** False when the creator has closed the vault to new payments. */
  accepting: boolean;
  observedAtMs: number;
}

/**
 * The agent's public surface.
 *
 * # Every member is declared with property-function syntax and that is load-bearing
 *
 * `sign: (action: Action) => Promise<SignedAction>`, never `sign(action: Action): ...`. The reason
 * is given in full at {@link SealDecryptor}: method syntax is checked **bivariantly** even under
 * `strictFunctionTypes`, so an implementation demanding more of its arguments than this interface
 * promises compiles silently. That already cost this package one shipped-shaped defect on the Seal
 * boundary, and the same hole is open on every method-syntax member of every interface — this one
 * included, where the arguments are addresses, prices and handles.
 *
 * `test/interface-variance.test.ts` fails on any method-syntax member it finds anywhere in `src/`,
 * so this does not depend on the next author reading this paragraph.
 *
 * # Two surfaces, one shape: the read set, and the read set plus the key
 *
 * `ReadOnlyAgent` is what `createAgent({ keypair: null, … })` returns. A hosted `weir-mcp` holds
 * no key by construction — `packages/mcp/src/transport.ts` `openWeir` passes `keypair: null` under
 * `--http`, and a set `WEIR_AGENT_KEY` there is a startup refusal — and until this type existed
 * `createAgent` required a key and read `key.address` at construction. The keyless deployment that
 * package is designed around therefore died with `TypeError: Cannot read properties of null
 * (reading 'address')` before it could serve a single read.
 *
 * The shape follows `WeirPort` in that package rather than inventing a second mechanism: **a
 * capability that does not exist is a member that is not there.** `capabilitiesOf` decides what
 * to register by `typeof port[name] === 'function'`, so a spending method that was
 * present-and-throwing would be registered as a tool that always fails — exactly what that package
 * refuses to ship. And because the two are distinct types, a caller holding a `ReadOnlyAgent` who
 * writes `.unlock(…)` gets a compile error, not a refusal at run time.
 *
 * The alternative — minting a throwaway keypair to satisfy the old signature — is rejected and
 * stays rejected. A public server that can sign `publish` and `send` statements as an ephemeral
 * identity is a capability increase bought for convenience.
 *
 * What a `ReadOnlyAgent` does NOT have, and why each is absent rather than refusing:
 *   - `address` — no key, no address.
 *   - `sign`, `session` — a read session is minted by signing a statement (`session.ts`).
 *   - `openAccount`, `unlock`, `subscribe`, `tip` — transactions; each signs.
 *   - `post`, `send` — signed writes.
 *   - `balance` — the agent's OWN balance, which needs an address. `balanceOf` takes one instead.
 */
/**
 * One post as the shop window shows it — `GET /api/browse` — with the author-written strings
 * carried as they came. Whoever renders `title` or `preview` to a model frames them first; this
 * package does not, because it does not know who is reading.
 */
export interface FeedPost {
  postId: string;
  handle: string;
  title: string;
  preview: string;
  access: 'public' | 'paid' | 'subscribers';
  /** Smallest on-chain unit as a decimal string. `null` when not individually for sale. */
  price: string | null;
  /** The manifest coin's symbol (`USDC`, `SUI`) when the post has a price; `null` otherwise. */
  currency: string | null;
}

/**
 * One page of the shop window. `truncated` is the server's word — it fetched one row past the page
 * to know — and `nextCursor` is opaque and goes back exactly as it came. The page size is the
 * server's too; there is no way to ask for a bigger one, by design.
 */
export interface FeedPage {
  posts: FeedPost[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface FeedInput {
  /** One creator's posts only. Omit for everybody's. */
  handle?: string;
  /** `nextCursor` from a previous page, verbatim. Omit for the first page. */
  cursor?: string;
}

export interface ReadOnlyAgent {
  /** What it is pointed at and what it may spend. */
  readonly manifest: AgentManifest;
  /** The gRPC client, exposed so a caller can make reads this surface does not cover. */
  readonly client: SuiGrpcClient;
  /** The Seal implementation, if one was supplied. `null` means sealed content stays sealed. */
  readonly seal: SealDecryptor | null;

  /**
   * What one content key costs, read from the chain.
   *
   * Takes the vault and the key, never a post id. See the note above `Quote` for why the post-id
   * form was removed rather than left to fail.
   *
   * On an agent that holds a key, a quote for a vault that key owns is refused, because the
   * purchase would be (`ESelfPayment`). A read-only agent has no address to compare, so it prices
   * every vault; the refusal it keeps is the one about the vault itself, `vault-not-accepting`.
   */
  quote: (post: { vaultId: string; contentKey: string }) => Promise<Reading<Quote>>;

  /**
   * Spendable balance of a named address, in minor units of the manifest's coin type unless
   * another is given. This is `balance` with the address said out loud, and it is the only form a
   * keyless agent can offer: `balance()` means "mine", and a read-only agent has no "mine".
   */
  balanceOf: (owner: string, coinType?: string) => Promise<Reading<bigint>>;

  /**
   * Browse the shop window: one page of posts, newest first, optionally one creator's, optionally
   * continuing from a cursor. The one HTTP read on this surface, and it is unauthenticated — the
   * endpoint is public and shows nothing a session would add.
   *
   * A failed read is a failure kind (`transport`, `not-found`, `malformed`), never `ok` with an
   * empty page: "there is nothing here" and "we could not look" are different facts and a caller
   * acts on the first and waits on the second.
   */
  feed: (input: FeedInput) => Promise<Reading<FeedPage>>;

  /**
   * One post as an anonymous reader sees it: the plaintext of a PUBLIC post, or `null` for a post
   * that exists and is gated. `GET /api/posts/{id}`. A gated body is never returned by this call —
   * it is ciphertext only the reader's own Seal session can open; see `seal-node.ts`.
   */
  readPreview: (input: { postId: string }) => Promise<Reading<PublicPost | null>>;
}

/** What `requestDeclaration` hands back: when the operator's window closes, and where they sign. */
export interface DeclarationRequested {
  /** The `issued:` instant inside the agent's statement; the operator's half repeats it. */
  issuedAtMs: number;
  expiresAtMs: number;
  /** Absolute, on this deployment: send it to the operator. */
  operatorPage: string;
}

/** What `read` hands back: the words, and how this agent was entitled to them. */
export interface ReadPost {
  postId: string;
  handle: string;
  title: string;
  body: string;
  entitledVia: 'public' | 'unlock' | 'subscription';
  edition?: 'human' | 'machine';
}

/** What `readPreview` hands back for a public post. */
export interface PublicPost {
  postId: string;
  handle: string;
  title: string;
  body: string;
  entitledVia: 'public';
}

/**
 * The full surface: everything above, plus everything that needs the key.
 *
 * `extends` rather than a union, so a function written against `ReadOnlyAgent` accepts either and
 * a function written against `Agent` accepts only the one that can sign. That is the direction
 * that matters: code that only reads should not demand a key, and code that spends must not be
 * handed an agent that cannot.
 */
export interface Agent extends ReadOnlyAgent {
  /** The agent's Sui address, padded. Safe to log. */
  readonly address: string;

  /** Sign a statement. The bytes match `identity.ts` exactly; nothing is sent. */
  sign: (action: Action) => Promise<SignedAction>;

  /** Take a day-long read session, or reuse the live one. */
  session: () => Promise<Reading<SessionCredential>>;

  /** `account::open` — claim a handle on chain. */
  openAccount: (handle: string, referrer?: string | null) => Promise<Reading<Executed>>;

  /**
   * Name an open vault, so posts can hang off it. Once, after the vault is open, before the first
   * post: until then `POST /api/posts` answers "no such creator". A signed write, no gas, no seat.
   * `coinType` is read from the vault when not given; the route refuses one that disagrees with it.
   */
  nameVault: (input: {
    vaultId: string;
    displayName: string;
    bio?: string;
    coinType?: string;
  }) => Promise<Reading<{ handle: string }>>;

  /** Set the display name on the handle the registry holds for this address. */
  setProfile: (input: { handle: string; displayName: string }) => Promise<Reading<{ handle: string }>>;

  /** Buy permanent access to one content key. Refuses over `maxPrice`. */
  unlock: (
    input: { vaultId: string; contentKey: string; priceMinorUnits: bigint } & SpendCeiling,
  ) => Promise<Reading<Executed>>;

  /** Join a tier for one period. Refuses over `maxPrice`. */
  subscribe: (input: { vaultId: string; tierIndex: number } & SpendCeiling) => Promise<Reading<Executed>>;

  /** Pay a creator with nothing in return. Refuses over `maxPrice`. */
  tip: (input: { vaultId: string; amount: bigint } & SpendCeiling) => Promise<Reading<Executed>>;

  /**
   * Read a post this agent is entitled to, by software.
   *
   * `GET /api/posts/{id}` with the read session. A public post's words come back as they are. A
   * gated post the agent holds the entitlement for comes back as a sealed reference, which the
   * bound {@link SealDecryptor} opens: the key servers re-run the on-chain approval with THIS
   * agent as sender and release the key to it — never to the platform. The plaintext's SHA-256 is
   * verified before the words are returned. Without a decryptor a gated post is `unconfigured`;
   * without the entitlement it is `not-found` (exists, not yours), which the tools report as such.
   */
  read: (input: { postId: string }) => Promise<Reading<ReadPost>>;

  /**
   * Hand this agent's half of a declaration to the site, so the operator can sign the other half
   * in a browser at `/agents/declare`. Signs the `declare-agent` statement naming the operator and
   * posts it to `POST /api/agents/declare/pending`. Nothing enters the register until the operator
   * signs; the request lives ten minutes and a later call replaces it.
   */
  requestDeclaration: (input: { operatorAddress: string; model: string; purpose: string }) => Promise<Reading<DeclarationRequested>>;

  /**
   * The public half of this agent's mind key, derived from a signature over `KEY_STATEMENT`.
   * The secret is never returned. See `mind.ts` for what the key is and what it is not.
   */
  mindKey: () => Promise<Reading<{ x25519Public: string }>>;

  /**
   * Put the derived key in the on-chain `key_registry`, or confirm it is already there.
   *
   * One transaction, gas only, the agent's own, simulated first. Needs
   * `PROJECTX_SOCIAL_KEY_REGISTRY_ID`. A registry already holding this exact key is left alone
   * (`alreadyPublished: true`, no transaction); one holding a DIFFERENT key is replaced, which is a
   * rotation — every blob remembered under the old key then needs the old secret to open.
   */
  publishMindKey: () => Promise<Reading<{ x25519Public: string; alreadyPublished: boolean; digest: string | null }>>;

  /**
   * Store the whole state under a label. Encrypted here to the agent's registered key (one
   * envelope, its own), signed as a `remember` statement over the ciphertext's hash and length,
   * posted to `POST /api/agents/mind`, which fronts the WAL and returns the blob and its lease.
   * Refused when the registry does not hold the derived key: publish first.
   *
   * Whole state, not a delta — the platform pays per blob and the route's per-address quota is
   * sized for one blob per working session. The size ceiling is the deployment's, returned in the
   * refusal when it is hit.
   */
  remember: (input: { label: string; plaintext: Uint8Array }) => Promise<Reading<Remembered>>;

  /**
   * The newest blob under a label: `GET /api/agents/mind`, the bytes from a public aggregator,
   * the hash checked, the envelope opened with the derived secret. A hash mismatch or a key that
   * cannot open it is a `malformed` reading, never a partial plaintext.
   */
  recall: (input: { label: string }) => Promise<Reading<Recalled>>;

  /** Publish a post under a handle this agent's address owns the vault for. */
  post: (input: {
    handle: string;
    title: string;
    preview: string;
    text: string;
    access: 'public' | 'subscribers' | 'paid';
    contentKey?: string;
    price?: string;
    /** Subscriber posts only: the tier index the body is sealed to (0 = every subscriber). Bound into the signature. */
    tier?: number;
    /**
     * Sent as `Idempotency-Key`. A retry with the same key and the same body is answered with the
     * first publish's response, never a second post. An agent that retries — every agent — should
     * derive it from its own request, not from the clock.
     */
    idempotencyKey?: string;
  }) => Promise<Reading<{ postId: string }>>;

  /** Send a direct message. */
  send: (input: {
    to: string;
    text: string;
    preview: string;
    paid?: { handle: string; contentKey: string; price: string };
    /** Sent as `Idempotency-Key`; see `post`. */
    idempotencyKey?: string;
  }) => Promise<Reading<{ sent: true }>>;

  /** This agent's own spendable balance of the manifest's coin type, in minor units. */
  balance: (coinType?: string) => Promise<Reading<bigint>>;

  /**
   * Put one content key of this agent's own vault up for sale, or reprice it.
   *
   * The call that makes a paid post buyable: `/api/posts` refuses a `paid` post whose key has no
   * price on the vault, and `creator::unlock` reads the price from there. Moves no coin — see
   * `buildSetContentPrice` for what the operator's policy must therefore allow instead.
   *
   * Refused before anything is read: an empty key (`EEmptyName`), a price that is not positive
   * (`EZeroPrice` — unpriced means not for sale, never free), and a key carrying the reserved
   * `#machine` marker. Then the cap for THIS vault is found, the transaction built once, simulated
   * on those bytes, signed and executed, like every other call here.
   */
  priceContent: (input: {
    vaultId: string;
    /** The HUMAN key, always — `edition: 'machine'` derives `<contentKey>#machine` here. */
    contentKey: string;
    edition?: 'human' | 'machine';
    price: bigint;
  }) => Promise<Reading<Executed>>;

  /**
   * Whether the machine edition of a human key can be delivered on a vault, from
   * `GET /api/studio/content-price`. Ask before pricing a machine edition: `absent` is a paid post
   * sealed before machine editions were (the web's migration 034), whose plaintext is gone, so an
   * `Unlock` sold for its machine key would open nothing. `no-post` means nothing is published
   * under the key yet; `sealed` means every sealed post under it carries a machine body.
   */
  machineBody: (input: { vaultId: string; contentKey: string }) => Promise<Reading<'no-post' | 'sealed' | 'absent'>>;
}

export interface CreateAgentInput {
  /**
   * A signer that applies the operator's policy before signing — a `PolicySigner` from
   * `@projectx-social/signer`, or a factory given the agent's chain client. When bound, the bare
   * key signs statements and Seal sessions only; every transaction goes through this. With it,
   * payments are built as `SplitCoins` from gas or from `PROJECTX_SOCIAL_AGENT_PAYMENT_COIN`, the
   * only shapes a policy can allow-list (`PaymentSource` in tx.ts); a spend that would need the
   * merged shape is refused before anything is built.
   */
  transactionSigner?: TransactionSigner | ((client: SuiGrpcClient) => TransactionSigner);
  /**
   * The agent's key. Accepts a loaded {@link AgentKey} or a bech32 `suiprivkey1…` secret.
   *
   * For an agent with no key, pass `null` — written out — and see {@link CreateReadOnlyAgentInput}.
   */
  keypair: AgentKey | string;
  /** Origin of the weir deployment. Overrides the manifest's, when both are given. */
  baseUrl?: string;
  /**
   * Where to point. A full {@link AgentManifest}, or a raw environment to load one from.
   *
   * There is no third option and in particular no "default to mainnet". `manifest.ts` gives the
   * reason at length: a human paying the wrong deployment sees a confirmation screen, and an agent
   * discovers it in a balance report days later.
   */
  config: AgentManifest | Record<string, string | undefined>;
  /** Optional. Without it, sealed content is reported as sealed rather than silently skipped. */
  seal?: SealDecryptor;
  /** Injected for tests, and for a caller who wants their own retry policy. */
  fetchImpl?: FetchLike;
  /** Injected for tests, and for a caller who already holds a client for this deployment. */
  client?: SuiGrpcClient;
  /**
   * How the mind key's derivation signature is produced. Default: the keypair above, in process.
   * An agent whose key lives in the Sui keystore passes a function that runs `sui keytool sign`
   * and returns the printed signature — this package never reads a keystore. See `mind.ts`.
   */
  mindSigner?: MindSigner;
  /** Walrus aggregators `recall` reads from, in order. Default: the public mainnet list. */
  aggregators?: readonly string[];
}

/**
 * The input that builds a {@link ReadOnlyAgent}.
 *
 * `keypair` is `null` and it is **required**, not optional. Absence would let a caller who forgot
 * the key build a silently read-only agent, and a `string | undefined` read from `process.env`
 * would compile straight into one. Neither is accepted: the only value that opens the read-only
 * path is the literal `null` that `openWeir` passes under `--http`, and a missing or undefined key
 * is a compile error. At run time an `undefined` that a JavaScript caller slips past the types is
 * refused with a `Reading` that says which of the two to write; see {@link createAgent}.
 *
 * `fetchImpl` exists because the read surface makes exactly one HTTP call: `feed`, an
 * unauthenticated `GET /api/browse`. `quote` and `balanceOf` read the chain. The read session —
 * the other HTTP path this package has — is minted by signing and is not on this surface.
 */
export interface CreateReadOnlyAgentInput {
  /** `null`, written out. See the type's doc block for why it is not optional. */
  keypair: null;
  /** Origin of the weir deployment. Overrides the manifest's, when both are given. */
  baseUrl?: string;
  /** As on {@link CreateAgentInput}: a manifest or an environment, and no default. */
  config: AgentManifest | Record<string, string | undefined>;
  /** Optional. Without it, sealed content is reported as sealed rather than silently skipped. */
  seal?: SealDecryptor;
  /** Injected for tests, and for a caller who already holds a client for this deployment. */
  client?: SuiGrpcClient;
  /** Injected for tests, and for a caller who wants their own retry policy. Used by `feed` only. */
  fetchImpl?: FetchLike;
}

/**
 * Build an agent.
 *
 * Returns a `Reading` rather than throwing, because every way this fails is a configuration
 * problem an operator has to read: a missing variable, an unparseable key, a coin type that is not
 * one. A constructor that threw would make the first line of every agent a try/catch whose only
 * job is to print the message this already carries.
 *
 * # Two overloads, chosen by the type of `keypair`
 *
 * A key produces an {@link Agent}; an explicit `null` produces a {@link ReadOnlyAgent}. The
 * overloads are what make the second a distinct type at the call site: a caller who passed `null`
 * cannot call `unlock`, because the compiler never gave them one. A caller with a value of type
 * `AgentKey | null` must branch first, which is the point.
 */
export function createAgent(input: CreateAgentInput): Reading<Agent>;
export function createAgent(input: CreateReadOnlyAgentInput): Reading<ReadOnlyAgent>;
export function createAgent(
  input: CreateAgentInput | CreateReadOnlyAgentInput,
): Reading<Agent> | Reading<ReadOnlyAgent> {
  const manifestReading = isManifest(input.config)
    ? ok(input.config)
    : loadAgentManifest(input.config);
  if (!manifestReading.ok) return manifestReading;

  const base = manifestReading.value;
  const manifest: AgentManifest =
    input.baseUrl === undefined ? base : { ...base, baseUrl: stripSlash(input.baseUrl) };

  const client = input.client ?? createClient(manifest.config);
  const boundSigner = 'transactionSigner' in input ? input.transactionSigner : undefined;
  const transactionSigner = typeof boundSigner === 'function' ? boundSigner(client) : boundSigner;
  const payment = paymentSourceFor(manifest);

  if (input.keypair === null) {
    const doFetch = input.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    return ok(readSurface({ client, manifest, seal: input.seal ?? null, payer: null, doFetch }));
  }

  /*
    Not reachable through the types — neither overload accepts `undefined` — and reachable from
    JavaScript in one keystroke. Before this branch existed, an `undefined` here reached
    `key.address` below and threw `TypeError: Cannot read properties of undefined`, which names a
    line in this file rather than the missing key. A `null` did the same, and that is the failure
    the read-only path closes; this is the same failure's other spelling.
  */
  if (input.keypair === undefined) {
    return fail(
      'unconfigured',
      'createAgent',
      'keypair is undefined. Pass a loaded AgentKey or a bech32 secret to build an agent that can ' +
        'sign and spend, or pass null — written out — to build a read-only agent that cannot.',
    );
  }

  const keyReading =
    typeof input.keypair === 'string' ? agentKeyFromSecret(input.keypair) : ok(input.keypair);
  if (!keyReading.ok) return keyReading;
  const key = keyReading.value;
  const address = normaliseAddress(key.address);

  const doFetch = input.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);

  /*
    One session, held in this closure and re-minted when it expires.

    Not in a module-level variable, which would be shared by every agent in the process — two
    agents with two keys would take turns overwriting each other's session and each would
    intermittently read as the other. That is a data leak between agents, and a closure is the
    cheapest way to make it impossible.
  */
  let live: SessionCredential | null = null;

  /*
    The mind key, derived once per agent and held in this closure — not on the object, where a
    caller could read the secret, and not module-wide, where two agents would share it.
  */
  const mindSigner: MindSigner =
    input.mindSigner ?? (async (message) => (await key.keypair.signPersonalMessage(message)).signature);
  const aggregators: readonly string[] = input.aggregators ?? PUBLIC_WALRUS_AGGREGATORS;
  let derived: MindKeyPair | null = null;
  async function mindPair(): Promise<Reading<MindKeyPair>> {
    if (derived !== null) return ok(derived);
    const pair = await deriveMindKey(mindSigner);
    if (pair.ok) derived = pair.value;
    return pair;
  }

  /** The vault's coin type from chain, or '' when it cannot be read (reported as malformed by the caller). */
  async function vaultCoinTypeOf(vaultId: string): Promise<string> {
    const read = await readVaultCoinType(client, vaultId);
    return read.ok ? read.value : '';
  }

  const agent: Agent = {
    // The read set is built once, by the same function the keyless path uses, so the two surfaces
    // cannot drift: a keyed agent quotes and reads balances exactly as a keyless one does, with its
    // own address as the payer a quote is checked against.
    ...readSurface({ client, manifest, seal: input.seal ?? null, payer: address, doFetch }),
    address,

    async sign(action: Action): Promise<SignedAction> {
      // Bound to the deployment this agent was opened against. An agent that talks to two services
      // must sign for each separately, which is the property this argument exists to enforce.
      return signAction(key.keypair, action, manifest.baseUrl);
    },

    async session(): Promise<Reading<SessionCredential>> {
      if (live !== null && !live.isExpired()) return ok(live);
      const opened = await openSession(
        doFetch === undefined
          ? { key, baseUrl: manifest.baseUrl }
          : { key, baseUrl: manifest.baseUrl, fetchImpl: doFetch },
      );
      if (opened.ok) live = opened.value;
      return opened;
    },

    async openAccount(handle: string, referrer: string | null = null): Promise<Reading<Executed>> {
      /*
        The handle is not validated here and that is deliberate.

        `account.move` is the authority on what a handle may be, `packages/sdk/src/accounts.ts`
        exports the bounds it asserts against the Move source, and the simulation below runs the
        real `assert_handle_valid`. A second opinion in this file could only ever disagree with the
        contract, and `UPDATE.md` records what that costs: the waiting list capped handles at 32
        where `account.move` caps at 30, so every 31- and 32-character handle it accepted was one
        `account::open` aborts on. Simulation catches it before gas is spent, which is the whole
        point of simulating.
      */
      const tx = buildOpenAccount(manifest.config, { handle, referrer });
      return simulateAndExecute({
        client,
        transaction: tx,
        key,
        transactionSigner,
        gasBudgetMist: manifest.gasBudgetMist,
        what: `account::open "${handle}"`,
      });
    },

    async nameVault(input: {
      vaultId: string;
      displayName: string;
      bio?: string;
      coinType?: string;
    }): Promise<Reading<{ handle: string }>> {
      const what = 'name vault';
      if (!/^0x[0-9a-f]{64}$/i.test(input.vaultId)) {
        return fail('malformed', what, `vaultId must be a Sui object id; received ${JSON.stringify(input.vaultId)}`);
      }
      if (typeof input.displayName !== 'string' || input.displayName.length === 0 || input.displayName.length > 60) {
        return fail('malformed', what, 'displayName is 1–60 characters; it is signed into the statement.');
      }
      const bio = input.bio ?? '';
      if (bio.length > 280) return fail('malformed', what, 'bio is at most 280 characters; it is signed into the statement.');
      /*
        The coin type is bound into the signature and the route compares it with the vault's own
        type parameter read from chain. Reading it here rather than guessing is the same rule the
        route applies: a signed wrong coin would be refused, and a refused single-use signature has
        to be signed again to find out why.
      */
      const coinType = input.coinType ?? (await vaultCoinTypeOf(input.vaultId));
      if (coinType === '') {
        return fail('transport', what, `the vault ${input.vaultId} could not be read, so its coin type is unknown; pass coinType or retry.`);
      }
      // `app/api/creator/profile/route.ts` rebuilds exactly this: name = displayName, bio, coinType.
      const signed = await signAction(key.keypair, {
        kind: 'name-vault',
        vaultId: input.vaultId,
        name: input.displayName,
        bio,
        coinType,
      }, manifest.baseUrl);
      const response = await authorisedFetch({
        agent,
        doFetch,
        path: '/api/creator/profile',
        method: 'POST',
        what,
        body: {
          owner: signed.address,
          vaultId: input.vaultId,
          coinType,
          displayName: input.displayName,
          bio,
          signature: signed.signature,
          timestampMs: signed.timestampMs,
        },
      });
      if (!response.ok) return response;
      const handle = response.value['handle'];
      if (typeof handle !== 'string' || handle === '') {
        return fail('malformed', what, 'the vault was named but the route returned no handle.');
      }
      return ok({ handle });
    },

    async setProfile(input: { handle: string; displayName: string }): Promise<Reading<{ handle: string }>> {
      const what = 'set profile';
      if (typeof input.displayName !== 'string' || input.displayName.length === 0 || input.displayName.length > 60) {
        return fail('malformed', what, 'displayName is 1–60 characters; it is signed into the statement.');
      }
      // `app/api/account/profile/route.ts` rebuilds `{ kind: 'set-profile', handle, name: displayName }`.
      const signed = await signAction(key.keypair, { kind: 'set-profile', handle: input.handle, name: input.displayName }, manifest.baseUrl);
      const response = await authorisedFetch({
        agent,
        doFetch,
        path: '/api/account/profile',
        method: 'POST',
        what,
        body: {
          address: signed.address,
          handle: input.handle,
          displayName: input.displayName,
          signature: signed.signature,
          timestampMs: signed.timestampMs,
        },
      });
      if (!response.ok) return response;
      return ok({ handle: input.handle });
    },

    async unlock(
      spend: { vaultId: string; contentKey: string; priceMinorUnits: bigint } & SpendCeiling,
    ): Promise<Reading<Executed>> {
      // Before any read: a spend a policy can never approve is refused without touching the chain.
      const shaped = policyShaped(payment, transactionSigner, `creator::unlock "${spend.contentKey}"`);
      if (!shaped.ok) return shaped;

      const vault = await readPayableVault(client, spend.vaultId, agent.address);
      if (!vault.ok) return vault;

      const live_ = await livePriceOfContent(client, vault.value, spend.contentKey);
      if (!live_.ok) return live_;

      // The guard, before anything is built. Both the ceiling and the agent's own expectation.
      const guarded = guardPrice({
        livePrice: live_.value,
        maxPrice: spend.maxPrice,
        expected: spend.priceMinorUnits,
        what: `unlock "${spend.contentKey}" from vault ${spend.vaultId}`,
        coinType: manifest.coinType,
      });
      if (!guarded.ok) return guarded;

      const ready = await payable(agent, guarded.value);
      if (!ready.ok) return ready;

      const tx = buildUnlock(manifest.config, {
        coinType: manifest.coinType,
        vaultId: spend.vaultId,
        accountId: ready.value,
        contentKey: spend.contentKey,
        price: guarded.value,
        sender: agent.address,
        payment,
      });
      return simulateAndExecute({
        client,
        transaction: tx,
        key,
        transactionSigner,
        gasBudgetMist: manifest.gasBudgetMist,
        what: `creator::unlock "${spend.contentKey}"`,
      });
    },

    async subscribe(
      spend: { vaultId: string; tierIndex: number } & SpendCeiling,
    ): Promise<Reading<Executed>> {
      const shaped = policyShaped(payment, transactionSigner, `creator::subscribe tier ${spend.tierIndex}`);
      if (!shaped.ok) return shaped;

      const vault = await readPayableVault(client, spend.vaultId, agent.address);
      if (!vault.ok) return vault;

      const tier = tierAt(vault.value, spend.tierIndex);
      if (!tier.ok) return tier;

      /*
        No `expected` here, unlike `unlock`.

        A tier price is read from the same vault object the subscription will execute against, in
        the same read — there is no second number for the agent to have been shown. `unlock` has
        one because a content price is a separate dynamic field the agent may have learned about
        elsewhere and earlier.
      */
      const guarded = guardPrice({
        livePrice: tier.value.price,
        maxPrice: spend.maxPrice,
        what: `subscribe to tier ${spend.tierIndex} ("${tier.value.name}") of vault ${spend.vaultId}`,
        coinType: manifest.coinType,
      });
      if (!guarded.ok) return guarded;

      const ready = await payable(agent, guarded.value);
      if (!ready.ok) return ready;

      const tx = buildSubscribe(manifest.config, {
        coinType: manifest.coinType,
        vaultId: spend.vaultId,
        accountId: ready.value,
        tierIndex: spend.tierIndex,
        price: guarded.value,
        sender: agent.address,
        payment,
      });
      return simulateAndExecute({
        client,
        transaction: tx,
        key,
        transactionSigner,
        gasBudgetMist: manifest.gasBudgetMist,
        what: `creator::subscribe tier ${spend.tierIndex}`,
      });
    },

    async tip(spend: { vaultId: string; amount: bigint } & SpendCeiling): Promise<Reading<Executed>> {
      const shaped = policyShaped(payment, transactionSigner, `creator::tip ${spend.amount}`);
      if (!shaped.ok) return shaped;

      const vault = await readPayableVault(client, spend.vaultId, agent.address);
      if (!vault.ok) return vault;

      /*
        A tip is guarded against the amount the agent chose, not against a price.

        There is no on-chain price for a tip — `creator::tip` takes the coin entire and returns no
        change. So the ceiling is the only thing bounding it, which makes `maxPrice` matter *more*
        here than anywhere else in this file: for an unlock, a wrong amount is refused by the
        contract, and for a tip there is nothing to refuse it.
      */
      const guarded = guardPrice({
        livePrice: spend.amount,
        maxPrice: spend.maxPrice,
        what: `tip ${spend.amount} to vault ${spend.vaultId}`,
        coinType: manifest.coinType,
      });
      if (!guarded.ok) return guarded;

      // EBelowMinTip, code 11. Named here because a tip below a creator's floor is a whole
      // transaction's gas spent to learn a number that was readable for free. A PRECONDITION: the
      // agent can raise the tip, or the creator can lower the floor, and either clears it.
      if (guarded.value < vault.value.minTip) {
        return refusePrecondition(
          'tip-below-minimum',
          `tip to vault ${spend.vaultId}`,
          `this creator's minimum tip is ${vault.value.minTip} and ${guarded.value} is below it. ` +
            `creator::tip would abort with ETipTooSmall (code 11). Nothing was spent.`,
        );
      }

      const ready = await payable(agent, guarded.value);
      if (!ready.ok) return ready;

      const tx = buildTip(manifest.config, {
        coinType: manifest.coinType,
        vaultId: spend.vaultId,
        accountId: ready.value,
        amount: guarded.value,
        payment,
      });
      return simulateAndExecute({
        client,
        transaction: tx,
        key,
        transactionSigner,
        gasBudgetMist: manifest.gasBudgetMist,
        what: `creator::tip ${guarded.value}`,
      });
    },

    async requestDeclaration(input: { operatorAddress: string; model: string; purpose: string }): Promise<Reading<DeclarationRequested>> {
      const what = 'requestDeclaration';
      const operator = input.operatorAddress.trim();
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(operator)) {
        return fail('malformed', what, `operatorAddress must be a Sui address; received ${JSON.stringify(input.operatorAddress)}`);
      }
      if (BigInt(operator) === BigInt(key.address)) {
        return fail('malformed', what, 'an agent cannot name itself as its operator — the register refuses one key signing both halves.');
      }
      const model = input.model.trim();
      const purpose = input.purpose.trim();
      if (model === '' || purpose === '' || /[\r\n]/.test(model) || /[\r\n]/.test(purpose)) {
        return fail('malformed', what, 'model and purpose are each one non-empty line; they are signed into the statement.');
      }
      const signed = await signAction(key.keypair, { kind: 'declare-agent', operator, model, purpose }, manifest.baseUrl);
      const response = await httpRead({
        doFetch,
        baseUrl: manifest.baseUrl,
        path: '/api/agents/declare/pending',
        method: 'POST',
        what,
        body: {
          address: signed.address,
          operatorAddress: operator,
          model,
          purpose,
          timestampMs: signed.timestampMs,
          agentSignature: signed.signature,
        },
      });
      if (!response.ok) return response;
      const expiresAtMs = response.value['expiresAtMs'];
      const operatorPage = response.value['operatorPage'];
      if (typeof expiresAtMs !== 'number' || typeof operatorPage !== 'string') {
        return fail('malformed', what, 'the waiting room answered without expiresAtMs and operatorPage.');
      }
      return ok({ issuedAtMs: signed.timestampMs, expiresAtMs, operatorPage: `${manifest.baseUrl}${operatorPage}` });
    },

    async mindKey(): Promise<Reading<{ x25519Public: string }>> {
      const pair = await mindPair();
      if (!pair.ok) return pair;
      return ok({ x25519Public: pair.value.x25519Public });
    },

    async publishMindKey(): Promise<Reading<{ x25519Public: string; alreadyPublished: boolean; digest: string | null }>> {
      const what = 'publishMindKey';
      if (manifest.keyRegistryId === null) return fail('unconfigured', what, 'PROJECTX_SOCIAL_KEY_REGISTRY_ID is not set, so there is no registry to publish to.');
      const pair = await mindPair();
      if (!pair.ok) return pair;
      const state = await registryStateFor({ client, keyRegistryId: manifest.keyRegistryId, address, x25519Public: pair.value.x25519Public });
      if (!state.ok) return state;
      if (state.value.kind === 'same') return ok({ x25519Public: pair.value.x25519Public, alreadyPublished: true, digest: null });
      const tx = buildPublishKey(manifest.config, { keyRegistryId: manifest.keyRegistryId, x25519Public: pair.value.x25519Public });
      const done = await simulateAndExecute({ client, transaction: tx, key, transactionSigner, gasBudgetMist: manifest.gasBudgetMist, what });
      if (!done.ok) return done;
      return ok({ x25519Public: pair.value.x25519Public, alreadyPublished: false, digest: done.value.digest });
    },

    async remember(input: { label: string; plaintext: Uint8Array }): Promise<Reading<Remembered>> {
      const what = 'remember';
      const label = input.label.trim();
      if (!LABEL.test(label)) return fail('malformed', what, `a label is 1–64 characters of letters, digits, dot, dash or underscore; received ${JSON.stringify(input.label)}`);
      if (!(input.plaintext instanceof Uint8Array) || input.plaintext.length === 0) return fail('malformed', what, 'plaintext must be a non-empty Uint8Array — the whole state, not a delta.');
      if (manifest.keyRegistryId === null) return fail('unconfigured', what, 'PROJECTX_SOCIAL_KEY_REGISTRY_ID is not set; a mind is encrypted to the key the registry names, so there is nothing to encrypt to.');
      const pair = await mindPair();
      if (!pair.ok) return pair;
      /*
        The registry is read before anything is encrypted. A blob encrypted to a key the registry
        does not name is one the agent's next device cannot open — and cannot prove is its own.
      */
      const state = await registryStateFor({ client, keyRegistryId: manifest.keyRegistryId, address, x25519Public: pair.value.x25519Public });
      if (!state.ok) return state;
      if (state.value.kind === 'absent') return fail('unconfigured', what, 'this address has published no encryption key; call publishMindKey() first.');
      if (state.value.kind === 'different') {
        return fail('malformed', what, `the registry holds a different key (version ${state.value.version}) than this signer derives; publishMindKey() to rotate, knowing older blobs then need the older secret.`);
      }
      const sealed = sealMind({ address, x25519Public: pair.value.x25519Public, plaintext: input.plaintext });
      const signed = await signAction(key.keypair, { kind: 'remember', label, sha256: sealed.sha256, bytes: String(sealed.bytes) }, manifest.baseUrl);
      const response = await httpRead({
        doFetch,
        baseUrl: manifest.baseUrl,
        path: '/api/agents/mind',
        method: 'POST',
        what,
        body: {
          address: signed.address,
          label,
          timestampMs: signed.timestampMs,
          signature: signed.signature,
          payload: sealed.payload,
        },
      });
      if (!response.ok) return response;
      const row = rememberedFrom(response.value['mind'], what);
      if (!row.ok) return row;
      if (row.value.sha256 !== sealed.sha256 || row.value.bytes !== sealed.bytes) {
        return fail('malformed', what, `the server recorded sha256 ${row.value.sha256} (${row.value.bytes} bytes); this agent sent ${sealed.sha256} (${sealed.bytes} bytes).`);
      }
      return row;
    },

    async recall(input: { label: string }): Promise<Reading<Recalled>> {
      const what = 'recall';
      const label = input.label.trim();
      if (!LABEL.test(label)) return fail('malformed', what, `a label is 1–64 characters of letters, digits, dot, dash or underscore; received ${JSON.stringify(input.label)}`);
      const pair = await mindPair();
      if (!pair.ok) return pair;
      const query = new URLSearchParams({ address, label });
      const response = await httpRead({ doFetch, baseUrl: manifest.baseUrl, path: `/api/agents/mind?${query.toString()}`, method: 'GET', what });
      if (!response.ok) return response;
      const row = rememberedFrom(response.value['mind'], what);
      if (!row.ok) return row;
      const raw = response.value['mind'] as Record<string, unknown>;
      const nonce = raw['nonce'];
      const envelope = raw['envelope'] as Record<string, unknown> | undefined;
      if (
        typeof nonce !== 'string' ||
        envelope === undefined ||
        typeof envelope['recipient'] !== 'string' ||
        typeof envelope['ephemeralPublic'] !== 'string' ||
        typeof envelope['nonce'] !== 'string' ||
        typeof envelope['wrappedKey'] !== 'string'
      ) {
        return fail('malformed', what, 'the record carries no envelope to open.');
      }
      const fetcher = doFetch ?? (globalThis.fetch as FetchLike | undefined);
      if (fetcher === undefined) return fail('unconfigured', what, 'no fetch implementation is available in this runtime.');
      const blob = await fetchBlob({ blobId: row.value.blobId, aggregators, doFetch: fetcher });
      if (!blob.ok) return blob;
      const opened = openMind({
        address,
        secret: pair.value.secret,
        ciphertext: blob.value,
        expectedSha256: row.value.sha256,
        nonce,
        envelope: {
          recipient: envelope['recipient'],
          ephemeralPublic: envelope['ephemeralPublic'],
          nonce: envelope['nonce'],
          wrappedKey: envelope['wrappedKey'],
        },
      });
      if (!opened.ok) return opened;
      return ok({ ...row.value, plaintext: opened.value });
    },
    async read(input: { postId: string }): Promise<Reading<ReadPost>> {
      const id = input.postId.trim();
      if (id === '' || /[^A-Za-z0-9_-]/.test(id)) {
        return fail('malformed', 'read', `a post id is a short token; received ${JSON.stringify(input.postId)}`);
      }
      const response = await authorisedFetch({ agent, doFetch, path: `/api/posts/${encodeURIComponent(id)}`, method: 'GET', what: 'read' });
      if (!response.ok) return response;
      const post = response.value['post'] as { id?: unknown; handle?: unknown; title?: unknown } | undefined;
      if (post === undefined || typeof post.id !== 'string' || typeof post.handle !== 'string' || typeof post.title !== 'string') {
        return fail('malformed', 'read', 'the post answer carried no id, handle and title.');
      }
      const edition = response.value['edition'];
      const editionField: { edition?: 'human' | 'machine' } = edition === 'human' || edition === 'machine' ? { edition } : {};
      const body = response.value['body'];
      if (typeof body === 'string' && response.value['entitledVia'] === 'public') {
        return ok({ postId: post.id, handle: post.handle, title: post.title, body, entitledVia: 'public', ...editionField });
      }
      const sealed = response.value['sealed'] as
        | { blobId?: unknown; sealWrappedKey?: unknown; nonce?: unknown; sha256?: unknown; approval?: Record<string, unknown> }
        | null
        | undefined;
      if (sealed === null || sealed === undefined) {
        return fail('not-found', 'read', `${id} exists and this agent holds no entitlement to it (or the words were never sealed under the key it holds).`);
      }
      if (agent.seal === null) {
        return fail('unconfigured', 'read', 'this post is sealed and no SealDecryptor is bound; pass `seal` to createAgent with loadSealConfig().');
      }
      const a = sealed.approval ?? {};
      const approval =
        a['kind'] === 'unlock' && typeof a['vaultId'] === 'string' && typeof a['contentKey'] === 'string' && typeof a['unlockId'] === 'string'
          ? { kind: 'unlock' as const, vaultId: a['vaultId'], contentKey: a['contentKey'], unlockId: a['unlockId'] }
          : a['kind'] === 'subscription' && typeof a['vaultId'] === 'string' && typeof a['subscriptionId'] === 'string'
            ? {
                kind: 'subscription' as const,
                vaultId: a['vaultId'],
                tier: BigInt(String(a['tier'])),
                period: BigInt(String(a['period'])),
                subscriptionId: a['subscriptionId'],
                // v5: the approval names CreatorVault<T>. The route sends the coin when it knows
                // it; otherwise the vault's own type on chain is the authority.
                coinType: typeof a['coinType'] === 'string' ? a['coinType'] : await vaultCoinTypeOf(a['vaultId']),
              }
            : null;
      if (approval !== null && approval.kind === 'subscription' && approval.coinType === '') {
        return fail('malformed', 'read', 'the vault\'s coin type could not be read, so the subscription approval cannot be built.');
      }
      if (approval === null || typeof sealed.blobId !== 'string' || typeof sealed.sealWrappedKey !== 'string' || typeof sealed.nonce !== 'string' || typeof sealed.sha256 !== 'string') {
        return fail('malformed', 'read', 'the sealed reference is missing a field.');
      }
      const via = response.value['entitledVia'] === 'subscription' ? 'subscription' : 'unlock';
      try {
        const bytes = await agent.seal.decrypt({ blobId: sealed.blobId, sealWrappedKey: sealed.sealWrappedKey, nonce: sealed.nonce, sha256: sealed.sha256, approval });
        return ok({ postId: post.id, handle: post.handle, title: post.title, body: new TextDecoder().decode(bytes), entitledVia: via, ...editionField });
      } catch (error) {
        return fail(looksLikeSettling(error) ? 'timeout' : 'malformed', 'read', `the sealed body could not be opened: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async post(article: {
      handle: string;
      title: string;
      preview: string;
      text: string;
      access: 'public' | 'subscribers' | 'paid';
      contentKey?: string;
      price?: string;
      tier?: number;
      idempotencyKey?: string;
    }): Promise<Reading<{ postId: string }>> {
      /*
        `contentKey` and `price` are signed as empty strings when the post is not for sale.

        `app/api/posts/route.ts` binds `body.contentKey ?? ''` and `body.price ?? ''` into the
        statement, before its own paid branch reads them, and says why: the statement must be
        rebuilt from the request exactly as the client built it. Omitting the fields from the
        signature and sending them, or the reverse, produces a statement the server cannot rebuild
        — and the error it returns names the key, not the mismatch.
      */
      const contentKey = article.contentKey ?? '';
      const price = article.price ?? '';

      const signed = await signAction(key.keypair, {
        kind: 'publish',
        handle: article.handle,
        title: article.title,
        // The tier rides on the access line; the route rebuilds it the same way (SDK `accessStatement`).
        access: accessStatement(article.access, article.access === 'subscribers' ? article.tier : undefined),
        // Hashed with the same length prefixes the route uses. See `publishContentSha256`.
        contentSha256: publishContentSha256(article.preview, article.text),
        contentKey,
        price,
      }, manifest.baseUrl);

      const response = await authorisedFetch({
        agent,
        doFetch,
        path: '/api/posts',
        method: 'POST',
        what: 'publish',
        ...(article.idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': article.idempotencyKey } }),
        body: {
          handle: article.handle,
          author: signed.address,
          title: article.title,
          preview: article.preview,
          text: article.text,
          access: article.access,
          ...(article.access === 'subscribers' && article.tier !== undefined ? { tier: article.tier } : {}),
          ...(contentKey === '' ? {} : { contentKey }),
          ...(price === '' ? {} : { price }),
          signature: signed.signature,
          timestampMs: signed.timestampMs,
        },
      });
      if (!response.ok) return response;

      /*
        The route answers `{ post: { id, access } }` (`app/api/posts/route.ts`, its last line). This
        read `postId` at the top level until 2026-09-02, so every publish the route ACCEPTED was
        reported here as malformed — a post existed, and the agent said none did. Read the shape the
        route actually returns; the flat name is kept as a fallback so an older deployment still
        answers.
      */
      const nested = (response.value['post'] as { id?: unknown } | undefined)?.id;
      const postId = typeof nested === 'string' ? nested : response.value['postId'];
      if (typeof postId !== 'string' || postId === '') {
        return fail('malformed', 'publish', 'the post was accepted but no post id was returned.');
      }
      return ok({ postId });
    },

    async send(message: {
      to: string;
      text: string;
      preview: string;
      paid?: { handle: string; contentKey: string; price: string };
      /** Sent as `Idempotency-Key`; see `post`. */
      idempotencyKey?: string;
    }): Promise<Reading<{ sent: true }>> {
      /*
        The text is trimmed before signing and the preview is not, and the asymmetry is the
        server's, not a mistake here.

        `app/api/messages/route.ts` verifies `{ text: trimmed, preview }` — it trims the body and
        takes the preview exactly as sent, with its own comment explaining that "normalising one
        side and not the other is a signature that fails for a reason no error message can
        explain". Signing untrimmed text against a server that trims is precisely that failure, and
        it only appears when a message happens to have leading or trailing whitespace, which is
        most messages a language model writes.
      */
      const trimmed = message.text.trim();
      if (trimmed === '') {
        return fail('malformed', 'send', 'the message is empty.');
      }
      if (sameAddress(message.to, agent.address)) {
        return fail('malformed', 'send', 'an agent cannot message itself.');
      }

      const signed = await signAction(key.keypair, {
        kind: 'send',
        to: message.to,
        text: trimmed,
        preview: message.preview,
        paid: paidStatementFor(message.paid),
      }, manifest.baseUrl);

      const response = await authorisedFetch({
        agent,
        doFetch,
        path: '/api/messages',
        method: 'POST',
        what: 'send',
        ...(message.idempotencyKey === undefined ? {} : { headers: { 'idempotency-key': message.idempotencyKey } }),
        body: {
          from: signed.address,
          to: message.to,
          // The trimmed text is sent, so what is stored is what was signed.
          text: trimmed,
          preview: message.preview,
          ...(message.paid === undefined ? {} : { paid: message.paid }),
          signature: signed.signature,
          timestampMs: signed.timestampMs,
        },
      });
      if (!response.ok) return response;
      return ok({ sent: true });
    },

    async priceContent(input: {
      vaultId: string;
      contentKey: string;
      edition?: 'human' | 'machine';
      price: bigint;
    }): Promise<Reading<Executed>> {
      const human = input.contentKey.trim();
      const edition = input.edition ?? 'human';
      /*
        The machine key is DERIVED, never typed: the same rule as `packages/web/lib/machine-pricing.ts`
        (trim, then append the marker), so the key this agent prices is the key the publish route
        sealed to. The hand-typed marker below stays refused for the reason given there — a
        creator-chosen key carrying it could collide with another post's machine edition.
      */
      const key_ = edition === 'machine' ? `${human}${MACHINE_EDITION_MARKER}` : human;
      const source = `creator::set_content_price "${key_}"`;
      if (human === '') {
        return fail('malformed', source, 'a content key cannot be empty; the contract refuses it (EEmptyName), so nothing is sent.');
      }
      if (human.includes(MACHINE_EDITION_MARKER)) {
        return fail(
          'malformed',
          source,
          `"${MACHINE_EDITION_MARKER}" is reserved: it names the machine edition of a key and is appended by the ` +
            'platform. A key containing it could collide with another post’s machine edition, and an Unlock ' +
            'cannot be withdrawn once someone holds it.',
        );
      }
      if (input.price <= 0n) {
        return fail('malformed', source, 'a price must be greater than zero — free posts are public, and the contract refuses zero (EZeroPrice).');
      }
      const cap = await findCreatorCap(client, manifest.config, agent.address, input.vaultId);
      // Re-sourced under THIS call, so a refusal names the key that was about to be priced — the
      // derived machine key included — rather than only the cap lookup that stopped it.
      if (!cap.ok) return fail(cap.failure.kind, source, cap.failure.detail);
      const tx = buildSetContentPrice(manifest.config, {
        coinType: manifest.coinType,
        vaultId: input.vaultId,
        capId: cap.value,
        contentKey: key_,
        price: input.price,
      });
      return simulateAndExecute({ client, transaction: tx, key, transactionSigner, gasBudgetMist: manifest.gasBudgetMist, what: source });
    },

    async machineBody(input: { vaultId: string; contentKey: string }): Promise<Reading<'no-post' | 'sealed' | 'absent'>> {
      const what = 'machine body';
      const query = new URLSearchParams({ vaultId: input.vaultId, contentKey: input.contentKey.trim() });
      const read = await httpRead({
        doFetch,
        baseUrl: manifest.baseUrl,
        path: `/api/studio/content-price?${query.toString()}`,
        method: 'GET',
        what,
      });
      if (!read.ok) return read;
      const state = read.value['machineBody'];
      if (state === 'no-post' || state === 'sealed' || state === 'absent') return ok(state);
      // An older deployment answers without the field. That is not "sealed"; it is not knowing.
      return fail('malformed', what, `the deployment did not say whether a machine edition can be delivered (machineBody=${JSON.stringify(state)}).`);
    },

    async balance(coinType?: string): Promise<Reading<bigint>> {
      return totalBalance(client, agent.address, coinType ?? manifest.coinType);
    },
  };

  return ok(agent);
}

/**
 * Whether an agent can sign — the agent-side twin of `capabilitiesOf` in `packages/mcp`.
 *
 * Decided by the presence of `sign`, not by a flag, for the reason that package gives: a flag says
 * what a constructor intended, and presence says what the object can do. The two surfaces here are
 * built so that they cannot disagree, but a guard that reads the object is right even if that
 * changes.
 */
export function canSign(agent: ReadOnlyAgent): agent is Agent {
  return typeof (agent as Partial<Agent>).sign === 'function';
}

// === Internals ===

/**
 * The read set — the members an agent has whether or not it holds a key.
 *
 * One builder for both surfaces. `createAgent` spreads this into the full agent and returns it
 * bare for the keyless one, so there is exactly one `quote` and one `balanceOf` and the two paths
 * cannot drift. `payer` is the address a quote is checked against for self-payment; `null` means
 * there is no such address, and only that check is skipped.
 */
function readSurface(input: {
  client: SuiGrpcClient;
  manifest: AgentManifest;
  seal: SealDecryptor | null;
  payer: string | null;
  doFetch: FetchLike | undefined;
}): ReadOnlyAgent {
  const { client, manifest, seal, payer, doFetch } = input;
  return {
    manifest,
    client,
    seal,

    async quote(post: { vaultId: string; contentKey: string }): Promise<Reading<Quote>> {
      /*
        A quote is priced from the chain, always, even when the caller handed us a post id and the
        HTTP API would happily have reported a price alongside it.

        This is the injection guard's foundation rather than an efficiency question. The API's
        price is a number that travelled through the same channel as the content, and content is
        what an agent is being manipulated by. The vault is the authority — it is the authority for
        `creator::unlock` too, which reads the price itself and takes exactly that.
      */
      const target = post;

      const vault = await readPayableVault(client, target.vaultId, payer);
      if (!vault.ok) return vault;

      const price = await livePriceOfContent(client, vault.value, target.contentKey);
      if (!price.ok) return price;

      return ok({
        vaultId: target.vaultId,
        contentKey: target.contentKey,
        coinType: manifest.coinType,
        priceMinorUnits: price.value,
        owner: vault.value.owner,
        accepting: vault.value.accepting,
        observedAtMs: Date.now(),
      });
    },

    async balanceOf(owner: string, coinType?: string): Promise<Reading<bigint>> {
      return totalBalance(client, owner, coinType ?? manifest.coinType);
    },

    async readPreview(input: { postId: string }): Promise<Reading<PublicPost | null>> {
      const id = input.postId.trim();
      if (id === '' || /[^A-Za-z0-9_-]/.test(id)) {
        return fail('malformed', 'readPreview', `a post id is a short token; received ${JSON.stringify(input.postId)}`);
      }
      const response = await httpRead({
        doFetch,
        baseUrl: manifest.baseUrl,
        path: `/api/posts/${encodeURIComponent(id)}`,
        method: 'GET',
        what: 'readPreview',
      });
      if (!response.ok) return response;
      const post = response.value['post'] as { id?: unknown; handle?: unknown; title?: unknown } | undefined;
      const body = response.value['body'];
      const via = response.value['entitledVia'];
      if (post === undefined || typeof post.id !== 'string' || typeof post.handle !== 'string' || typeof post.title !== 'string') {
        return fail('malformed', 'readPreview', 'the post answer carried no id, handle and title.');
      }
      if (body === null || via === null) return ok(null);
      if (typeof body !== 'string' || via !== 'public') {
        return fail('malformed', 'readPreview', 'the post answer named an entitlement this reader cannot have.');
      }
      return ok({ postId: post.id, handle: post.handle, title: post.title, body, entitledVia: 'public' });
    },

    async feed(input: FeedInput): Promise<Reading<FeedPage>> {
      const what = 'feed';
      /*
        Exactly the parameters the endpoint defines: `kind`, `handle`, `cursor`. No `limit` is
        sent because none is accepted — the server's page is the page — and none is offered here
        because a caller-raisable ceiling is not a ceiling. `URLSearchParams` encodes the cursor,
        which is base64url and survives it unchanged.
      */
      const query = new URLSearchParams({ kind: 'posts' });
      if (input.handle !== undefined) query.set('handle', input.handle);
      if (input.cursor !== undefined) query.set('cursor', input.cursor);
      const read = await httpRead({
        doFetch,
        baseUrl: manifest.baseUrl,
        path: `/api/browse?${query.toString()}`,
        method: 'GET',
        what,
      });
      if (!read.ok) return read;
      return feedPageFrom(read.value, manifest.coinType, what);
    },
  };
}

/**
 * The response, checked field by field before it becomes a page.
 *
 * Every field the page carries is asserted to be the type the endpoint documents, and a response
 * that is not — an `items` that is not an array, a `truncated` that is not a boolean, a post with
 * no id — is `malformed`, never a partial page. A partial page would be a page that lies about
 * what is there.
 */
function feedPageFrom(body: Record<string, unknown>, coinType: string, what: string): Reading<FeedPage> {
  const items = body['items'];
  const truncated = body['truncated'];
  const nextCursor = body['nextCursor'];
  if (!Array.isArray(items) || typeof truncated !== 'boolean' || (nextCursor !== null && typeof nextCursor !== 'string')) {
    return fail('malformed', what, 'GET /api/browse answered 200 without items, truncated and nextCursor in the documented shapes.');
  }
  const symbol = coinType.split('::').pop() ?? null;
  const posts: FeedPost[] = [];
  for (const item of items) {
    const row = item as Record<string, unknown>;
    const access = row['access'] as Record<string, unknown> | undefined;
    const kind = access?.['kind'];
    if (
      typeof row['id'] !== 'string' ||
      typeof row['authorHandle'] !== 'string' ||
      typeof row['title'] !== 'string' ||
      typeof row['preview'] !== 'string' ||
      (kind !== 'public' && kind !== 'paid' && kind !== 'subscribers')
    ) {
      return fail('malformed', what, `GET /api/browse returned a post that is not one: ${JSON.stringify(row).slice(0, 200)}`);
    }
    const price = kind === 'paid' && typeof access?.['price'] === 'string' ? access['price'] : null;
    posts.push({
      postId: row['id'],
      handle: row['authorHandle'],
      title: row['title'],
      preview: row['preview'],
      access: kind,
      price,
      currency: price === null ? null : symbol,
    });
  }
  return ok({ posts, truncated, nextCursor: nextCursor as string | null });
}

/**
 * The agent's account id, plus a balance check, before a payment is built.
 *
 * The balance check is here rather than left to simulation because a shortfall is the one failure
 * an agent can act on: it means "fund me", and an abort code does not say that. Simulation would
 * catch it too, one round trip later, as `EInsufficientPayment` (code 5).
 */
/**
 * How this agent pays, decided once from its manifest.
 *
 * SUI splits from gas — the shape the policy fixture was recorded from. Any other coin splits from
 * the one coin the operator named, when they named one; otherwise the merged shape, which no
 * policy can allow-list and which {@link policyShaped} refuses the moment a policy signer is bound.
 */
export function paymentSourceFor(manifest: { coinType: string; paymentCoin: string | null }): PaymentSource {
  if (/::sui::SUI$/.test(manifest.coinType)) return { kind: 'gas' };
  if (manifest.paymentCoin !== null) return { kind: 'object', objectId: manifest.paymentCoin };
  return { kind: 'merge' };
}

function policyShaped(payment: PaymentSource, signer: TransactionSigner | undefined, source: string): Reading<true> {
  if (signer !== undefined && payment.kind === 'merge') {
    return fail(
      'unconfigured',
      source,
      'a policy signer is bound, and a merged payment (tx.coin) has object inputs whose ids rotate, so ' +
        'no policy can allow-list them. Set PROJECTX_SOCIAL_AGENT_PAYMENT_COIN to one owned coin of the ' +
        "vault's coin type and allow-list that id; payments are then split from it. Nothing was built.",
    );
  }
  return ok(true);
}

async function payable(agent: Agent, needed: bigint): Promise<Reading<string>> {
  const account = await findAgentAccount(agent.client, agent.manifest.config, agent.address);
  if (!account.ok) return account;
  if (account.value === null) {
    return fail(
      'not-found',
      `SocialAccount for ${agent.address}`,
      'this agent has no SocialAccount, and every payment in creator.move takes one as the buyer. ' +
        'Call openAccount(handle) first.',
    );
  }

  const balance = await totalBalance(agent.client, agent.address, agent.manifest.coinType);
  if (!balance.ok) return balance;
  if (balance.value < needed) {
    /*
      The archetypal precondition, and the one the old two-way classification handled worst.

      Reported as `malformed` this reads "never retry", and an agent told never to retry a payment
      it cannot yet afford will not retry it after somebody funds the wallet either. It is the
      exact case the third classification exists for: nothing is wrong, a number needs to change,
      and the agent should say which number and come back.
    */
    return refusePrecondition(
      'insufficient-balance',
      `${agent.manifest.coinType} balance of ${agent.address}`,
      `this agent holds ${balance.value} and the payment needs ${needed} (minor units). ` +
        'Nothing was signed.',
    );
  }
  return ok(account.value);
}

/** One HTTP call, carrying the read session, returning a parsed body or a `Reading` failure. */
async function authorisedFetch(input: {
  agent: Agent;
  doFetch: FetchLike | undefined;
  path: string;
  method: 'GET' | 'POST';
  what: string;
  body?: Record<string, unknown>;
  /** Extra request headers — today only `Idempotency-Key`, which a write may carry. */
  headers?: Record<string, string>;
}): Promise<Reading<Record<string, unknown>>> {
  const { agent, what, doFetch } = input;

  /*
    The session is attached to writes as well as reads, and it authorises none of them.

    A write is authorised by its single-use signature and nothing else — `read-session.ts` is
    explicit that a stolen session "cannot post, spend, unlock, or follow". The session travels
    anyway because a route may read entitlement while serving a write, and a request that arrives
    anonymous gets the anonymous view of whatever it touches. A failure to obtain one is therefore
    not fatal here: the request goes out unauthenticated rather than not at all.
  */
  const session = await agent.session();
  const auth = session.ok ? session.value.headers() : {};

  return httpRead({
    doFetch,
    baseUrl: agent.manifest.baseUrl,
    path: input.path,
    method: input.method,
    what,
    headers: { ...auth, ...(input.headers ?? {}) },
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}

/**
 * One HTTP round trip against the weir deployment, and the one mapping from its answer to a
 * `Reading`. `authorisedFetch` adds the session; `feed` adds nothing. Both end here so a status
 * code means the same thing on every path this package has.
 */
async function httpRead(input: {
  doFetch: FetchLike | undefined;
  baseUrl: string;
  path: string;
  method: 'GET' | 'POST';
  what: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}): Promise<Reading<Record<string, unknown>>> {
  const { what } = input;
  const doFetch = input.doFetch ?? (globalThis.fetch as FetchLike | undefined);
  if (doFetch === undefined) {
    return fail('unconfigured', what, 'no fetch implementation is available in this runtime.');
  }

  let response: Response;
  try {
    response = await doFetch(`${input.baseUrl}${input.path}`, {
      method: input.method,
      headers: {
        ...(input.headers ?? {}),
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
  } catch (error) {
    return fail(
      'transport',
      what,
      `could not reach ${input.baseUrl}${input.path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    const json: unknown = await response.json();
    if (typeof json === 'object' && json !== null) parsed = json as Record<string, unknown>;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const detail =
      typeof parsed?.['error'] === 'string' ? parsed['error'] : `HTTP ${response.status}`;
    /*
      404 and 405 are separated from everything else, and from each other.

      A 404 means this deployment has no such path. A **405** means the path exists and does not
      implement this method — which is precisely what `GET /api/posts` returns, because that route
      exports `POST` only. Folding 405 into the same bucket as "the server refused your request" is
      what let a structurally impossible call read as an ordinary failure for as long as it did;
      the two methods that could only ever produce it are now gone, and this branch is here so the
      next one is legible the first time somebody sees it in a log.
    */
    if (response.status === 405) {
      return fail(
        'not-found',
        what,
        `${input.method} ${input.path} is not implemented by this deployment (HTTP 405). The path ` +
          `exists; the method does not. This is a missing endpoint, not a refused request.`,
      );
    }
    return fail(response.status === 404 ? 'not-found' : 'malformed', what, detail);
  }
  return ok(parsed ?? {});
}

/** The row `/api/agents/mind` answers with, or why it is not one. */
function rememberedFrom(value: unknown, what: string): Reading<Remembered> {
  if (typeof value !== 'object' || value === null) return fail('malformed', what, 'the server answered without a mind record.');
  const r = value as Record<string, unknown>;
  const label = r['label'];
  const blobId = r['blobId'];
  const endEpoch = r['endEpoch'];
  const sha256 = r['sha256'];
  const bytes = r['bytes'];
  const createdAtMs = r['createdAtMs'];
  if (
    typeof label !== 'string' ||
    typeof blobId !== 'string' ||
    typeof endEpoch !== 'number' ||
    typeof sha256 !== 'string' ||
    typeof bytes !== 'number' ||
    typeof createdAtMs !== 'number'
  ) {
    return fail('malformed', what, 'the mind record is missing label, blobId, endEpoch, sha256, bytes or createdAtMs.');
  }
  return ok({ label, blobId, endEpoch, sha256, bytes, createdAtMs });
}

/** A manifest, or an environment to load one from. Distinguished structurally, not by a flag. */
function isManifest(value: AgentManifest | Record<string, string | undefined>): value is AgentManifest {
  const candidate = value as Partial<AgentManifest>;
  return (
    typeof candidate.baseUrl === 'string' &&
    typeof candidate.coinType === 'string' &&
    typeof candidate.gasBudgetMist === 'bigint' &&
    typeof candidate.config === 'object' &&
    candidate.config !== null
  );
}

function stripSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/** Re-exported so a caller assembling a manifest by hand does not import the SDK separately. */
export type { ProjectXSocialConfig, Reading };
