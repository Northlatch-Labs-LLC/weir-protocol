// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * How `weir-mcp` reaches the world, what it is allowed to hold while it does, and what it is
 * therefore allowed to offer.
 *
 * This file is the security boundary of the package. `tools.ts` describes what an agent may ask
 * for; this decides *who is asking*, *what authority exists to answer with*, and — new, and the
 * point of the rework below — *which tools may exist at all given that authority*.
 *
 * # The correction this file exists to record
 *
 * The previous version of this package made two claims at once and they could not both be true.
 *
 *   1. *This server can be exposed publicly, because it holds no key and therefore nothing whose
 *      theft grants an attacker anything.*
 *   2. *This server enforces the spending ceiling.*
 *
 * The first claim describes the server as **untrusted**. The second gives it a **security
 * decision**. An agent runtime — the model, the MCP client, and this server sitting inside it — is
 * precisely where hostile content arrives: a weir post body is attacker-controlled text that
 * reaches the model in the same channel as its own instructions. A component in that position may
 * *propose* a spend. It may never *bound* one. Putting the ceiling here meant the thing an attacker
 * talks to was also the thing deciding what the attacker was allowed to cost.
 *
 * So the ceiling left. `maxPrice` is now a **string of digits in the smallest on-chain unit** plus
 * an explicit `currency`, parsed for representability and passed straight through. Nothing in this
 * package compares it to a price.
 *
 * **The bounds that replaced it, and which is which:**
 *
 *   - **Bound one — the signer.** `@projectx-social/signer` holds the key and applies
 *     `@projectx-social/policy`, the principal's standing authority, to every call. It refuses
 *     before it signs. This is the bound that stops the transaction existing.
 *   - **Bound two — the chain, independently.** `sui-contracts/sources/creator.move`'s `take_price`
 *     asserts `payment.value() >= price` and splits **exactly** `price`, returning the change. The
 *     payment coin is funded at the guarded price, so a price that has risen since it was read
 *     makes the assertion fail and the whole transaction abort. Nothing partial settles. This bound
 *     holds even if every line of TypeScript above it is wrong or compromised.
 *
 * The README states both, and states which is which, because an operator who cannot name which
 * bound is load-bearing cannot tell a real regression from a cosmetic one.
 *
 * # The second property, unchanged and still true
 *
 * **This server holds no private key of its own and no session state of its own.** Not a key at
 * rest, not a key store, not an API key, not a bearer token it issues, **not a cookie it accepts**,
 * not a per-caller record it keeps between requests.
 *
 * Enforced mechanically in `resolveOptions` and `handleHttpRequest`:
 *
 *   - **stdio mode** runs beside the agent, on the operator's own machine, in a process the
 *     operator launched. The operator injects an Ed25519 secret through that process's environment.
 *     It lives in that process's memory for that process's lifetime and crosses no network.
 *   - **hosted HTTP mode signs nothing at all.** If `WEIR_AGENT_KEY` is set in HTTP mode the server
 *     **refuses to start**. It does not warn, it does not ignore it, it does not start read-only.
 *     It exits `78`.
 *
 * The refusal is the important half, and it exists because of an extremely ordinary accident:
 * somebody copies the stdio `.env` onto the box that serves the hosted endpoint. Every individual
 * step of that is reasonable. The result is a signing key behind a public HTTP port. A warning in a
 * log is not a control — nobody reads a log at the moment it would matter — so the check is fatal
 * and it happens before the listener is opened.
 *
 * # Capability, not refusal
 *
 * A tool that is registered and always answers "not available here" is worse than no tool. It costs
 * the model context on every single turn to describe a capability that does not exist, and it gives
 * the model something to keep trying. So the rule in this package is now absolute: **a tool is
 * registered if and only if the thing it calls exists and can succeed.** The capability boundary is
 * visible in `tools/list`, which is where an operator can check it in one command.
 *
 * {@link capabilitiesOf} computes that set from the bound implementation rather than from
 * configuration, so it cannot flatter. See its note for the two capabilities that are absent today
 * and exactly why.
 */

import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SUI_PRIVATE_KEY_PREFIX } from '@mysten/sui/cryptography';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
// Type-only: erased by the compiler. The agent library itself is loaded dynamically, and only then.
import type { Reading } from '@projectx-social/agent';
import { portFromAgent } from './agent-port.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/* ------------------------------------------------------------------------------------------------
 * The vocabulary the tools speak
 * ---------------------------------------------------------------------------------------------- */

/**
 * What a price is denominated in.
 *
 * A closed set on purpose. A price is never a bare number anywhere in this package, because a bare
 * number cannot be compared against a spending ceiling by anybody: `100000` under a quote in MIST
 * is 0.0001 SUI, and under a quote in USDC base units it is ten cents. The denomination is stated
 * by the caller and carried, unconverted, all the way to the layer that decides.
 */
export type Currency = 'SUI' | 'USDC';

/**
 * A spending ceiling, in transit.
 *
 * # `bigint`, and why the wire form is a string
 *
 * On-chain amounts are `u64`. `Number.MAX_SAFE_INTEGER` is `2^53 - 1`, so a JSON number cannot
 * represent the top of that range exactly — and the failure is silent and in the wrong direction,
 * because floating point rounds a limit *up* as readily as down. A ceiling that is silently rounded
 * up is a ceiling that authorises more than the principal wrote.
 *
 * So the wire form of `maxPrice` is a **string of decimal digits in the smallest on-chain unit**,
 * and it is converted to `bigint` at the tool boundary by {@link parseAmount}, which refuses
 * anything that is not exactly that. No decimals, no sign, no exponent, no separators.
 *
 * # This type carries a ceiling; nothing in this package applies one
 *
 * A `Ceiling` is *cargo*. It is parsed here, passed down through the port, and enforced by the
 * signer and by the chain. See this file's opening note for which bound is which.
 */
export interface Ceiling {
  readonly maxPrice: bigint;
  readonly currency: Currency;
}

/**
 * The largest amount that can exist on this chain: `u64::MAX`.
 *
 * Used by {@link parseAmount} for a **representability** check, which is a different thing from a
 * spending check and must not be mistaken for one. Refusing `2^64` is refusing a number the chain
 * has no way to hold; it says nothing whatever about whether a number the chain *can* hold is a
 * number the principal authorised. That question is answered two layers down.
 */
export const U64_MAX = 18_446_744_073_709_551_615n;

/**
 * Read an amount off the wire.
 *
 * Returns `null` for anything that is not a plain non-negative decimal integer within `u64`.
 *
 * # Why the grammar is this strict
 *
 * Every rejected form is one that `BigInt()` or `Number()` would otherwise accept and silently
 * reinterpret:
 *
 *  - `"0x10"` — `BigInt` reads that as 16. A hexadecimal ceiling is a ceiling nobody wrote.
 *  - `"1e9"` — `Number` reads that as a billion; `BigInt` throws. Neither is what a caller who
 *    typed it meant to happen without being told.
 *  - `"1_000"` — a numeric separator is a language feature, not a wire format.
 *  - `" 100 "` — leading and trailing space are accepted by `BigInt` and are a sign the value came
 *    from a place that was not thinking of it as a number.
 *  - `"-1"` — a negative ceiling is not a smaller ceiling, it is a nonsensical one, and a
 *    downstream comparison against it would pass everything.
 *  - `"1.0"` — a decimal point in a smallest-unit amount means the caller is thinking in whole
 *    coins, which is the exact confusion this representation exists to prevent. Refusing is
 *    correct; converting would be guessing at a factor of a billion.
 *
 * Leading zeros are accepted and normalised, because `"0100"` is unambiguous and refusing it would
 * be pedantry rather than a control.
 */
export function parseAmount(text: string): bigint | null {
  if (!/^[0-9]+$/.test(text)) return null;
  const value = BigInt(text);
  return value > U64_MAX ? null : value;
}

/** A post as it appears in a search result: enough to decide whether to pay, never the paid body. */
/**
 * One page of the shop window, as `GET /api/browse` answers it.
 *
 * `truncated` is the server's word, measured by fetching one row past the page, and it is carried
 * to the caller untouched: a page that came back full is not evidence of a next one, and a tool
 * that dropped the flag would leave an agent unable to tell "that is all" from "there is more".
 * `nextCursor` is opaque; it goes back to the server as it came.
 */
export interface WeirFeed {
  posts: WeirPost[];
  truncated: boolean;
  nextCursor: string | null;
}

export interface WeirPost {
  postId: string;
  handle: string;
  /** Author-written. Framed by `untrusted.ts` before it leaves this package. */
  title: string;
  /** Author-written. Framed by `untrusted.ts` before it leaves this package. */
  preview: string;
  access: 'public' | 'paid' | 'subscribers';
  /** Smallest on-chain unit as a decimal string. `null` when not individually for sale. */
  price: string | null;
  currency: Currency | null;
}

/**
 * The live, on-chain answer to "what would this cost me right now".
 *
 * Keyed by **vault and content key**, never by post id, and that is the correction described at
 * {@link capabilitiesOf}: a post id has to be resolved to those two identifiers by an HTTP endpoint
 * that does not exist on this deployment.
 */
export interface WeirQuote {
  vaultId: string;
  contentKey: string;
  /** Smallest on-chain unit, as a decimal string. Never a JSON number; see {@link Ceiling}. */
  price: string;
  currency: Currency;
  coinType: string;
  owner: string;
  /** False when the creator has closed the vault to new payments. Buying would abort. */
  accepting: boolean;
  observedAtMs: number;
}

/** Plaintext, once entitlement is proved. The body is author-written and is framed before it leaves. */
export interface WeirBody {
  postId: string;
  handle: string;
  title: string;
  body: string;
  entitledVia: 'public' | 'unlock' | 'subscription';
}

export interface WeirUnlockReceipt {
  txDigest: string;
  /** `null` when the executor reports no created object ids — the agent library reads no effects; the Unlock is on chain under `txDigest`. */
  unlockObjectId: string | null;
  /** Smallest on-chain unit, as a decimal string. */
  pricePaid: string;
  currency: Currency;
}

export interface WeirSubscribeReceipt {
  txDigest: string;
  /** `null` when the executor reports no created object ids; see {@link WeirUnlockReceipt}. */
  subscriptionObjectId: string | null;
  /** `null` when the tier price was not read back — never a guess. */
  pricePaid: string | null;
  currency: Currency;
}

export interface WeirBalance {
  address: string;
  /** Smallest on-chain unit, as a decimal string, of the manifest's coin type. */
  spendable: string;
  currency: Currency;
}

/**
 * Everything this package knows how to ask weir for.
 *
 * # Every member is optional, and that is the mechanism rather than laxity
 *
 * A method that is absent is a capability that does not exist, and {@link capabilitiesOf} turns
 * absence into a tool that is never registered. Declaring them required would force the binding to
 * fabricate a method in order to satisfy the type — and a fabricated method is exactly the
 * "registered tool that always fails" this package now refuses to ship.
 *
 * # Property-function syntax, not method syntax, and it is load-bearing
 *
 * `feed?: (input: …) => …`, never `feed?(input: …): …`. TypeScript checks method-syntax members
 * **bivariantly** even under `strictFunctionTypes`, so an implementation that demands *more* of its
 * arguments than this port promises compiles silently. `packages/agent` records that this already
 * cost it one shipped-shaped defect on its Seal boundary. The arguments here are addresses, prices
 * and ceilings; the same hole would be worth more.
 */
export interface WeirPort {
  /** Browse or search. Absent today — see {@link capabilitiesOf}. */
  /**
   * Browse the shop window: one page, optionally one creator's, optionally continuing from a cursor.
   *
   * No `limit` and no `query`. The page size is the server's (`BROWSE_PAGE`, not a caller
   * parameter — a ceiling a caller can raise is not a ceiling), and `/api/browse` has no free-text
   * search, so a `query` here would be a promise the endpoint cannot keep. A `Reading`, not a bare
   * array: a failed read is a failure kind the caller can act on, never an empty page.
   */
  feed?: (input: { handle?: string; cursor?: string }) => Promise<Reading<WeirFeed>>;
  /** Price one content key from the chain. */
  quote?: (input: { vaultId: string; contentKey: string }) => Promise<WeirQuote>;
  /** Fetch a body the caller is already entitled to. `null` means "exists, not entitled". */
  readPreview?: (input: { postId: string }) => Promise<WeirBody | null>;
  /** The signer's own spendable balance. */
  balance?: () => Promise<WeirBalance>;

  /** Buy permanent access. The ceiling is carried, not applied. */
  unlock?: (input: {
    vaultId: string;
    contentKey: string;
    ceiling: Ceiling;
    idempotencyKey: string;
  }) => Promise<WeirUnlockReceipt>;
  /** Join a tier. The ceiling is carried, not applied. */
  subscribe?: (input: {
    vaultId: string;
    tierIndex: number;
    ceiling: Ceiling;
    idempotencyKey: string;
  }) => Promise<WeirSubscribeReceipt>;
  /** Publish under the principal's own handle. */
  post?: (input: {
    handle: string;
    title: string;
    preview: string;
    text: string;
    access: 'public' | 'paid' | 'subscribers';
    /** Subscriber posts only: the tier index the body is sealed to. */
    tier?: number;
    contentKey?: string;
    price?: string;
    idempotencyKey: string;
  }) => Promise<{ postId: string }>;
  /** Send a direct message. */
  send?: (input: {
    to: string;
    text: string;
    preview: string;
    idempotencyKey: string;
  }) => Promise<{ sent: true }>;
  /**
   * Put one content key of the agent's own vault up for sale, or reprice it — `creator::set_content_price`.
   *
   * Moves no coin, and that is exactly why it sits behind the same signer-and-policy gate as the
   * tools that do: the bound on it is AUTHORITY (the target, the vault and the cap in the operator's
   * allow-lists), which only a policy can express. `price` and `currency` are carried unconverted,
   * like a ceiling; the vault's own coin is the only coin a price can be in, and the agent is where
   * that is compared.
   */
  priceContent?: (input: {
    vaultId: string;
    /** The HUMAN key, always. `edition: 'machine'` prices `<contentKey>#machine`; the port derives it. */
    contentKey: string;
    edition?: 'human' | 'machine';
    price: string;
    currency: Currency;
    idempotencyKey: string;
  }) => Promise<{ txDigest: string }>;
  /**
   * Whether the machine edition of a human key can be delivered on a vault — `GET
   * /api/studio/content-price`'s `machineBody`. Asked by `weir_price` before it prices a machine
   * edition: `absent` is a post sealed before machine editions were, whose plaintext is gone, and
   * pricing it would sell an `Unlock` that opens nothing.
   *
   * Answered either as the bare state or as the agent package's `Reading` of it; the tool reads
   * both, and a failed `Reading` or a throw concludes nothing (`unreadable`).
   */
  machineBody?: (input: {
    vaultId: string;
    contentKey: string;
  }) => Promise<MachineBodyState | { ok: true; value: MachineBodyState } | { ok: false; failure: unknown }>;
}

export type MachineBodyState = 'no-post' | 'sealed' | 'absent';

/* ------------------------------------------------------------------------------------------------
 * The signer, and the policy that bounds it
 * ---------------------------------------------------------------------------------------------- */

/**
 * The signing authority, as `@projectx-social/signer` presents it.
 *
 * **This interface is the contract handed to this package, reproduced exactly.** It is declared here
 * rather than imported so that this package typechecks while the sibling is still being written;
 * when that package ships, this declaration should be replaced by `import type { Signer } from
 * '@projectx-social/signer'` and the compiler will report any drift that has crept in — which is
 * strictly better than {@link assertSignerShape}, and is the reason a `TODO` is not enough here.
 *
 * # `scheme` is reported, never branched on
 *
 * An operator's most consequential question about an unattended signer is *what kind of key is
 * armed* — a single Ed25519 secret and a multisig are different amounts of trust in one process,
 * and the difference should be visible at startup rather than inferred from a config file. Nothing
 * in this package changes behaviour based on it: signing schemes are the signer's business.
 */
export interface Signer {
  readonly address: string;
  readonly scheme: 'ed25519' | 'secp256r1' | 'multisig';
  signPersonalMessage: (b: Uint8Array) => Promise<unknown>;
  signTransaction: (b: Uint8Array) => Promise<unknown>;
}

/**
 * A signer that can prove identity but cannot move money.
 *
 * # How a read-only signer is recognised, and the wrong answer that was written here first
 *
 * The first version of this file tested for the **absence of `signTransaction`**, reasoning that an
 * authority which cannot produce a transaction cannot spend. The reasoning is sound and the test is
 * wrong, because it does not match the implementation it has to classify. `readOnlySigner` in
 * `@projectx-social/signer` returns an object with **both** methods present; each resolves to
 * `fail('unconfigured', …)`. A structural test therefore sees a complete `Signer`, calls it a
 * signing signer, and **arms the spending tools on a deployment that cannot sign** — which is the
 * "tool that always fails" this package refuses to ship, arrived at from the other direction.
 *
 * So capability is determined by **trying it**. {@link probeSigner} asks the signer to sign one
 * harmless message at startup and reads the answer. A key that is there signs; a read-only
 * stand-in refuses, in the same `Reading` shape everything else in this workspace refuses in.
 *
 * `signPersonalMessage` is the right method to probe, and that is not an accident of convenience.
 * `PolicySigner` documents it as **not policy-gated**: a personal message moves nothing, so there
 * are no effects for a policy about effects to judge. Probing `signTransaction` instead would
 * conflate "there is no key" with "the policy said no to this particular spend", which are opposite
 * facts. The probe therefore measures *custody*, which is what this classification is about, and
 * leaves *authorisation* to the layer that owns it.
 *
 * A read-only binding is what a public hosted deployment is meant to hold: an identity for
 * `weir_balance` to be *about*, and no ability to spend.
 */
export type SignerBinding =
  | { kind: 'none' }
  | { kind: 'read-only'; signer: Signer }
  | { kind: 'signing'; signer: Signer };

/** What `openWeir` hands the tool layer. */
export interface WeirBinding {
  port: WeirPort;
  signer: SignerBinding;
  /**
   * Whether `@projectx-social/policy` was loadable.
   *
   * # Why loadability is the test, and the honest limit of it
   *
   * The policy module is where the principal's standing authority lives — the answer to "is a
   * ceiling of this size, for this tool, something I authorised in advance". It is consulted by the
   * signer, not by this package, and that separation is deliberate: a component that hostile
   * content talks to must not be the component that reads the policy.
   *
   * But **this package must still refuse to arm a spending tool when the thing that bounds it is
   * absent.** A spending tool with no policy behind it is a ceiling stated by a model and checked
   * by nobody, which is the defect this whole rework exists to remove. So the gate is: no policy
   * module, no spending tools.
   *
   * The check is that the module loads, and nothing more. A stronger check would mean calling into
   * an API this package would have to invent on a sibling's behalf, and an invented API that the
   * sibling then does not implement is a false assurance dressed as a strict one. Loadability is
   * weak, it is stated as weak in the README, and it is the strongest honest check available until
   * that package publishes its shape.
   */
  policyAvailable: boolean;
}

/* ------------------------------------------------------------------------------------------------
 * Capabilities
 * ---------------------------------------------------------------------------------------------- */

/** The logical things this server can offer. One tool each; see `tools.ts`. */
export type Capability =
  | 'search'
  | 'quote'
  | 'read-preview'
  | 'balance'
  | 'buy'
  | 'subscribe'
  | 'post'
  | 'send'
  | 'price';

/**
 * What this binding can actually do.
 *
 * # The rule
 *
 * A capability is present when **the method that serves it exists**, and — for anything that
 * spends or writes — when a signing signer and a policy module are both bound. Nothing here reads
 * configuration, an environment variable, or a mode flag. Configuration describes what an operator
 * intended; this describes what will succeed.
 *
 * # Two capabilities that are absent today, named so nobody rediscovers them
 *
 * **`search`.** It needs `feed`, and `@projectx-social/agent` no longer exports one. The reason is
 * recorded in that package at length and is not a gap waiting to be filled in: `feed()` went
 * through `GET /api/posts`, and `packages/web/app/api/posts/route.ts` exports exactly `dynamic` and
 * `POST`. There is no `GET`, there never was on this deployment, and Next.js answers an
 * unimplemented method with 405 — so every call returned a refusal, always. It was removed rather
 * than left to fail with an apologetic message, because an honest error does not make an exported
 * method honest.
 *
 * It also cannot be rebuilt from chain events. `sui-contracts/sources/creator.move` emits ten event
 * types and the only one touching content is `ContentPriced { vault, content_key, price }`. There is
 * no title, no preview, no body, no handle and no publication time in any of them: a post lives in
 * Postgres, and the chain knows only that some opaque key under some vault has a price.
 *
 * **`read-preview`.** It needs `readPreview`, and no method on the agent returns the plaintext of a
 * post to an already-entitled reader. `quote` prices a content key and `unlock` buys one; neither
 * reads. This is a real gap in the agent surface rather than a decision, and it is recorded in the
 * README's open list.
 *
 * Both come back the moment the method appears. Neither is registered until then, and this function
 * is the only place that decides.
 *
 * # Why `balance` is grouped with reading
 *
 * It signs nothing and spends nothing. It needs an *address* — there is no "my balance" without a
 * "my" — which is why it depends on a signer being bound at all, including a read-only one. Grouped
 * by what it needs rather than by what it costs, and `tools.ts` marks it `readOnlyHint: true` so a
 * runtime is told the truth about it.
 */
/**
 * Unwrap what `createAgent` actually returns, which is a `Reading<Agent>` and not an `Agent`.
 *
 * # The defect this exists to close
 *
 * The call site asked only whether the answer was an object. BOTH answers are: a success is
 * `{ ok: true, value: … }`, a refusal is `{ ok: false, failure: … }`. Neither carries `feed`,
 * `quote`, `unlock` or any other method — and {@link capabilitiesOf} decides what this server can
 * do by asking `typeof port[name] === 'function'` for each one.
 *
 * So the envelope passed the guard and was bound as though it were the agent, every capability
 * check answered false, and the server started and registered **zero tools** — on the SUCCESS path
 * as much as the failure path. It did not crash and it did not warn. A server with no tools is a
 * valid server, and this one reported that it was fine.
 *
 * A refusal is now a refusal rather than an inert endpoint: an operator is told at startup why the
 * agent could not be built, instead of discovering it from a client that lists nothing.
 *
 * @throws StartupRefusal when the agent refused, or when the shape is not a Reading at all.
 */
export function agentFromReading(created: unknown): WeirPort {
  const reading = created as { ok?: unknown; value?: unknown; failure?: { detail?: unknown } };
  if (reading?.ok === false) {
    const detail =
      typeof reading.failure?.detail === 'string' ? reading.failure.detail : 'no reason given';
    throw new StartupRefusal(`${AGENT_PACKAGE} createAgent() refused: ${detail}`);
  }
  if (reading?.ok !== true || reading.value === null || typeof reading.value !== 'object') {
    throw new StartupRefusal(
      `${AGENT_PACKAGE} createAgent() did not return a Reading<Agent>. Nothing was bound, because ` +
        'binding an unrecognised shape is how a server starts with no tools and reports success.',
    );
  }
  return portFromAgent(reading.value);
}

export function capabilitiesOf(binding: WeirBinding): ReadonlySet<Capability> {
  const has = (name: keyof WeirPort): boolean => typeof binding.port[name] === 'function';
  const out = new Set<Capability>();

  if (has('feed')) out.add('search');
  if (has('quote')) out.add('quote');
  if (has('readPreview')) out.add('read-preview');
  if (binding.signer.kind !== 'none' && has('balance')) out.add('balance');

  /*
    The gate. Both halves are required and neither is sufficient.

    A signing signer with no policy is a key with no standing authority behind it: the ceiling on a
    call would be whatever the model wrote, checked by nobody. A policy with no signing signer is a
    rule with nothing to apply it to. Only the conjunction arms a tool that writes or spends.
  */
  const armed = binding.signer.kind === 'signing' && binding.policyAvailable;
  if (armed && has('unlock')) out.add('buy');
  if (armed && has('subscribe')) out.add('subscribe');
  if (armed && has('post')) out.add('post');
  if (armed && has('send')) out.add('send');
  // Pricing spends nothing and is gated like a spend anyway: what it changes is what every future
  // buyer pays, and only a policy can say whether this agent may change that.
  if (armed && has('priceContent')) out.add('price');

  return out;
}

/* ------------------------------------------------------------------------------------------------
 * Options, and the rules that make the security claims true
 * ---------------------------------------------------------------------------------------------- */

export type TransportMode = 'stdio' | 'http';

export interface ServerOptions {
  mode: TransportMode;
  baseUrl: string;
  /** Present only in stdio mode. `resolveOptions` refuses to produce a non-null value under HTTP. */
  secretKey: string | null;
  /** `WEIR_AGENT_POLICY`, stdio mode only; null otherwise. */
  policyPath: string | null;
  httpHost: string;
  httpPort: number;
  /** Browser origins permitted to drive the HTTP endpoint. Empty means no browser may. */
  allowedOrigins: string[];
  /** `Host` header values this endpoint answers to. See {@link hostAllowed}. */
  allowedHosts: string[];
  /**
   * The environment the agent library is handed — {@link agentEnvironment}, a projection of exactly
   * the names in {@link AGENT_ENVIRONMENT}, never the whole process environment.
   */
  agentEnvironment: Record<string, string>;
}

/** The default the operator gets if they name nothing. Production, because that is where posts are. */
export const DEFAULT_BASE_URL = 'https://weir.social';

/** Env var names, in one place, so the README and the loader cannot drift apart. */
export const ENV = {
  key: 'WEIR_AGENT_KEY',
  baseUrl: 'WEIR_BASE_URL',
  httpHost: 'WEIR_MCP_HTTP_HOST',
  httpPort: 'WEIR_MCP_HTTP_PORT',
  allowedOrigins: 'WEIR_MCP_ALLOWED_ORIGINS',
  allowedHosts: 'WEIR_MCP_ALLOWED_HOSTS',
  /**
   * Path to the operator's policy document (`@projectx-social/policy` `PolicyDoc` as JSON). Read
   * only in stdio mode with a key, like the key itself. When present, every transaction the agent
   * signs goes through a `PolicySigner` built from it, and that is what `policyAvailable` means.
   */
  policy: 'WEIR_AGENT_POLICY',
} as const;

/**
 * The variables the agent library reads, and the only ones it is handed.
 *
 * `createAgent` loads its manifest from the record it is given — `loadAgentManifest(config)` reads
 * the six chain ids, the coin type and the base URL from THAT object, not from `process.env`. This
 * package used to pass `{ source: 'weir-mcp' }`, so the agent saw none of them and refused with
 * "missing required environment variables" whatever the operator had exported; hosted mode had never
 * started on any machine. It is handed a projection now, and a projection rather than `process.env`
 * itself so that the one secret the agent's own manifest names (`PROJECTX_SOCIAL_AGENT_SECRET`) can
 * never travel to it by accident from this side — keys reach `createAgent` through `keypair`, and in
 * HTTP mode that is `null` by construction.
 *
 * The list is checked, not trusted: `test/env-handoff.ts` compares it to the agent's and the SDK's
 * own exported names, so a variable added over there fails a test here.
 */
export const AGENT_ENVIRONMENT = [
  // The six the SDK requires (`REQUIRED_ENV` in `@projectx-social/sdk`).
  'PROJECTX_SOCIAL_NETWORK',
  'PROJECTX_SOCIAL_GRPC_URL',
  'PROJECTX_SOCIAL_PACKAGE_ID',
  'PROJECTX_SOCIAL_LATEST_PACKAGE_ID',
  'PROJECTX_SOCIAL_PLATFORM_ID',
  'PROJECTX_SOCIAL_REGISTRY_ID',
  // The two the agent's manifest requires (`AGENT_ENV` in `@projectx-social/agent`).
  'PROJECTX_SOCIAL_AGENT_COIN_TYPE',
  'PROJECTX_SOCIAL_AGENT_BASE_URL',
  // The one optional seam the SDK reads when present; absent is a supported state.
  'PROJECTX_SOCIAL_KEY_REGISTRY_ID',
] as const;

/** Exactly the {@link AGENT_ENVIRONMENT} names that are set and non-empty, trimmed. */
export function agentEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of AGENT_ENVIRONMENT) {
    const value = env[name]?.trim();
    if (value !== undefined && value !== '') out[name] = value;
  }
  return out;
}

/** Raised for every condition that must stop the process before it can do harm. */
export class StartupRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupRefusal';
  }
}

/**
 * Turn argv and the environment into the one shape the rest of the process reads.
 *
 * Every `StartupRefusal` below is a deployment mistake that is silent in every other design.
 *
 * The environment is passed in rather than read from `process.env` so that the rules are testable
 * without mutating global state — and so that no other module in this package has a reason to touch
 * `process.env` at all, which is what keeps the key's blast radius to this one function.
 */
export function resolveOptions(argv: readonly string[], env: NodeJS.ProcessEnv): ServerOptions {
  const wantsHttp = argv.includes('--http');
  const wantsStdio = argv.includes('--stdio');

  if (wantsHttp && wantsStdio) {
    throw new StartupRefusal(
      'both --stdio and --http were given. These are different trust models, not two ways to say ' +
        'the same thing: one may hold your signing key and the other may never. Pick one.',
    );
  }

  // stdio is the default because it is the safe default. A server that quietly opened a network
  // port when nobody asked it to would be the wrong way round.
  const mode: TransportMode = wantsHttp ? 'http' : 'stdio';
  const rawKey = env[ENV.key]?.trim();
  const hasKey = rawKey !== undefined && rawKey !== '';

  /*
    THE REFUSAL. See this file's opening note. The scenario is not exotic — it is one `scp` of an
    `.env` away, and everything about it looks correct while it is happening. Making it fatal here,
    before any listener exists, is the only place it can be caught by a machine rather than by
    somebody noticing.
  */
  if (mode === 'http' && hasKey) {
    throw new StartupRefusal(
      `${ENV.key} is set and the transport is --http. This server signs nothing in HTTP mode and ` +
        'will not start holding a key behind a network port. Either drop the variable, or run ' +
        '--stdio beside the agent that owns that key.',
    );
  }

  if (hasKey && rawKey !== undefined && !rawKey.startsWith(SUI_PRIVATE_KEY_PREFIX)) {
    /*
      Shape-checked, never echoed. The value is a secret and a diagnostic that prints it — or a
      prefix of it, or its length — is a secret in a log file. The only safe thing to say is what
      was expected.
    */
    throw new StartupRefusal(
      `${ENV.key} is not a Sui private key. Expected a bech32 string beginning "${SUI_PRIVATE_KEY_PREFIX}". ` +
        'The value has not been logged.',
    );
  }

  const baseUrl = env[ENV.baseUrl]?.trim() || DEFAULT_BASE_URL;
  let parsedBase: URL;
  try {
    parsedBase = new URL(baseUrl);
  } catch {
    throw new StartupRefusal(`${ENV.baseUrl} is not a URL: ${baseUrl}`);
  }
  if (parsedBase.protocol !== 'https:' && parsedBase.hostname !== 'localhost' && parsedBase.hostname !== '127.0.0.1') {
    /*
      A signed action sent over plain http is a signed action an intermediary can read. It cannot be
      *replayed* — every write is single-use — but it names what this agent is doing and to whom,
      and that is enough. localhost is exempt because a developer running the stack locally has no
      certificate and no network hop to protect.
    */
    throw new StartupRefusal(
      `${ENV.baseUrl} must be https (or localhost). Refusing to send signed actions over ${parsedBase.protocol}//.`,
    );
  }

  const portText = env[ENV.httpPort]?.trim();
  const httpPort = portText === undefined || portText === '' ? 8402 : Number(portText);
  if (!Number.isInteger(httpPort) || httpPort < 1 || httpPort > 65535) {
    throw new StartupRefusal(`${ENV.httpPort} is not a port number: ${String(portText)}`);
  }

  /*
    Loopback by default. Binding 0.0.0.0 because it "worked on the box" is how a server intended for
    one host becomes reachable from the network it happens to sit on, and the operator has to say so
    deliberately rather than inherit it.
  */
  const httpHost = env[ENV.httpHost]?.trim() || '127.0.0.1';

  const allowedOrigins = splitList(env[ENV.allowedOrigins]);
  const configuredHosts = splitList(env[ENV.allowedHosts]);

  return {
    mode,
    baseUrl,
    secretKey: mode === 'stdio' && hasKey && rawKey !== undefined ? rawKey : null,
    policyPath: mode === 'stdio' && hasKey ? (env[ENV.policy]?.trim() || null) : null,
    httpHost,
    httpPort,
    allowedOrigins,
    allowedHosts: configuredHosts.length > 0 ? configuredHosts : defaultAllowedHosts(httpHost, httpPort),
    agentEnvironment: agentEnvironment(env),
  };
}

function splitList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * The `Host` values this endpoint answers to when the operator names none.
 *
 * The address it was told to bind, at the port it was told to bind — plus, on loopback, the two
 * other spellings of loopback, because `localhost:8402` and `127.0.0.1:8402` are the same endpoint
 * and an operator who typed one should not be refused for typing the other. `[::1]` is included for
 * the same reason on a dual-stack host.
 *
 * A default of "anything" would make {@link hostAllowed} decorative, which is the usual way this
 * control ends up shipped but disabled.
 */
export function defaultAllowedHosts(httpHost: string, httpPort: number): string[] {
  const loopback = httpHost === '127.0.0.1' || httpHost === 'localhost' || httpHost === '::1';
  const names = loopback ? ['127.0.0.1', 'localhost', '[::1]'] : [httpHost];
  return names.map((name) => `${name}:${httpPort}`);
}

/* ------------------------------------------------------------------------------------------------
 * Diagnostics
 * ---------------------------------------------------------------------------------------------- */

/**
 * Everything this process says, it says on **stderr**.
 *
 * Not a style preference. In stdio mode, stdout *is* the JSON-RPC frame stream: one stray
 * `console.log` anywhere in the process emits a line the client cannot parse, and the whole session
 * dies with a decoding error that names neither the line nor the module that wrote it. It is the
 * single most common way an MCP server breaks, and it breaks in a way that looks like the protocol
 * is at fault.
 *
 * The rule is therefore absolute rather than mode-dependent: nothing in this package writes to
 * stdout, in either transport, ever.
 */
export function log(...parts: unknown[]): void {
  process.stderr.write(`[weir-mcp] ${parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ')}\n`);
}

/* ------------------------------------------------------------------------------------------------
 * Binding — the one seam where sibling packages are loaded
 * ---------------------------------------------------------------------------------------------- */

const AGENT_PACKAGE = '@projectx-social/agent';
const SIGNER_PACKAGE = '@projectx-social/signer';
const POLICY_PACKAGE = '@projectx-social/policy';

/**
 * Load a sibling package, or say it is not there.
 *
 * Returns `null` rather than throwing, because **absence is a supported state in this package**.
 * Every sibling here is optional in the strict sense: without the signer and the policy there are
 * no spending tools, and a server with fewer tools is a correct server. Throwing would turn a
 * reduced capability set into a dead process.
 *
 * The specifier is held in a variable rather than written inline so that TypeScript does not
 * resolve it at compile time — which is what lets this package typecheck against siblings that are
 * still being written.
 */
async function loadOptional(specifier: string): Promise<Record<string, unknown> | null> {
  const held: string = specifier;
  try {
    return (await import(held)) as Record<string, unknown>;
  } catch (error) {
    log(`${specifier} is not available: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Is this value the {@link Signer} this package was handed a contract for?
 *
 * Checked rather than trusted, because the alternative is a `TypeError: signer.signTransaction is
 * not a function` inside a tool handler three layers down, reported to the model as a failed
 * purchase — and a model's reasonable next move after a failed purchase is to retry it.
 *
 * `signTransaction` is deliberately **not** required: its absence is what defines a read-only
 * signer, which is a supported and useful binding, not a malformed one.
 */
function assertSignerShape(value: unknown): Signer | null {
  if (value === null || typeof value !== 'object') return null;
  const candidate = value as Partial<Signer>;
  if (typeof candidate.address !== 'string' || candidate.address === '') return null;
  if (candidate.scheme !== 'ed25519' && candidate.scheme !== 'secp256r1' && candidate.scheme !== 'multisig') {
    return null;
  }
  if (typeof candidate.signPersonalMessage !== 'function') return null;
  if (typeof candidate.signTransaction !== 'function') return null;
  return candidate as Signer;
}

/**
 * The bytes the capability probe signs. Fixed prefix, random suffix.
 *
 * # Why these bytes and not any others
 *
 * They must be **impossible to reuse as a weir authorisation**. Every statement this network
 * verifies begins with the literal line `Weir` followed by `address: …` — see `statementFor` in
 * `@projectx-social/sdk` — and the server rebuilds the statement from the request rather than
 * taking it from the caller, so a signature over anything else verifies against nothing at all.
 * This string cannot be that prefix, so the probe signature authorises no action on weir, now or
 * later.
 *
 * The random suffix means two probes never produce the same signature, so one recovered from a log
 * or an audit chain says nothing about any subsequent run.
 *
 * The probe is recorded in `PolicySigner`'s audit chain like any other personal message, which is
 * correct rather than noisy: "this process checked at 03:14 whether it could sign" is a fact worth
 * having when working out how something happened.
 */
function probeBytes(): Uint8Array {
  const nonce = Array.from({ length: 16 }, () =>
    Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
  return new TextEncoder().encode(`weir-mcp capability probe; authorises nothing; nonce ${nonce}`);
}

/**
 * Can this signer actually sign?
 *
 * Returns `true` only for a result that is explicitly `{ ok: true }`, the `Reading` shape every
 * package in this workspace reports success in. Anything else — a refusal, a thrown error, a value
 * of a shape this package does not recognise — is `false`.
 *
 * **Failing closed is the whole point.** A wrong `true` arms a spending tool on a deployment that
 * cannot spend. A wrong `false` produces a deployment that offers fewer tools and says so at
 * startup. Those costs are not comparable, so an unrecognised answer is treated as "no" and the
 * reason is logged rather than guessed at.
 */
async function probeSigner(signer: Signer): Promise<boolean> {
  try {
    const result: unknown = await signer.signPersonalMessage(probeBytes());
    if (result !== null && typeof result === 'object' && (result as { ok?: unknown }).ok === true) {
      return true;
    }
    log('signer capability probe was refused: this deployment is read-only and will not be armed');
    return false;
  } catch (error) {
    log(`signer capability probe threw, treating as read-only: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Bind everything this deployment is allowed to have, and nothing it is not.
 *
 * # Why every import here is dynamic, and why that outlives the siblings landing
 *
 * Two reasons, and the second is the durable one.
 *
 *  1. The sibling packages are in flight. A static import would fail this package's typecheck on
 *     somebody else's progress rather than on its own correctness.
 *  2. **A hosted, keyless deployment has no business loading a signing library into its address
 *     space at all.** Deferring the import means the code that *can* sign is only ever resident in
 *     a process that was given something to sign with. That reason does not expire.
 *
 * When the siblings land, the `Signer` declaration in this file should become a real typed import
 * so drift is caught by the compiler rather than by {@link assertSignerShape} — but the *import
 * call* stays dynamic, for reason two.
 *
 * # What a missing piece produces
 *
 * Never a crash and never a tool that refuses. A missing piece produces a smaller capability set,
 * computed by {@link capabilitiesOf}, and a startup line that names exactly what is missing. An
 * operator reading that line can tell the difference between "this deployment cannot spend" and
 * "this deployment is broken", which is the distinction a warning buried in a log destroys.
 */
export async function openWeir(options: ServerOptions): Promise<WeirBinding> {
  const agentModule = await loadOptional(AGENT_PACKAGE);
  if (agentModule === null) {
    throw new StartupRefusal(
      `${AGENT_PACKAGE} could not be loaded, so this server has nothing to talk to weir with.`,
    );
  }

  const createAgent = agentModule['createAgent'];
  if (typeof createAgent !== 'function') {
    throw new StartupRefusal(`${AGENT_PACKAGE} does not export createAgent().`);
  }

  /*
    The keypair is built here and handed straight to the agent. It is never stored on `options`,
    never returned, never logged, and no other module in this package can reach it. In HTTP mode
    `options.secretKey` is null by construction (see `resolveOptions`), so `keypair` is null.

    The decode is wrapped because the library's failure message QUOTES THE KEY. `decodeSuiPrivateKey`
    reaches bech32, which throws `Invalid checksum in <the whole string>`; that error is not a
    `StartupRefusal`, so it reaches the top-level handler in `index.ts`, which prints
    `error.message` to stderr. A value one character off a real key, or a truncated one, is still
    key material, so the cause is dropped rather than wrapped — the same shape as
    `agent/src/keys.ts`, `daemon/src/adapters/signer.ts` and `signer/src/local.ts`.

    The prefix check in `resolveOptions` does NOT already cover this: it accepts anything beginning
    `suiprivkey1`, and a mistyped or truncated key clears that gate and fails here.
  */
  let keypair: Ed25519Keypair | null = null;
  if (options.secretKey !== null) {
    try {
      keypair = Ed25519Keypair.fromSecretKey(options.secretKey);
    } catch (error) {
      // Dropped on purpose: the message can quote the key. See the note above.
      void error;
      throw new StartupRefusal(
        `${ENV.key} is set but could not be decoded as a bech32 Ed25519 Sui private key ` +
          `(expected "${SUI_PRIVATE_KEY_PREFIX}…"). The value has not been logged.`,
      );
    }
  }

  /*
    The signer and the policy are bound BEFORE the agent, because the agent is handed the policy
    signer at construction. Until 2026-09-02 `policyAvailable` meant "the policy package could be
    imported" — a package that loads and is never consulted — and the ceiling on a live purchase
    was the number the model wrote in the tool arguments. Now it means a policy document was read,
    its address matched the signer, and a PolicySigner wrapping the key was handed to the agent, so
    every transaction the agent signs is simulated, evaluated and recorded under the operator's
    document first. The three are inseparable: a signer without a policy registers the read set.
  */
  const signer = await bindSigner(options);
  const policyBinding = await bindPolicy(options, signer);

  const created: unknown = await (createAgent as (input: unknown) => unknown)({
    keypair,
    baseUrl: options.baseUrl,
    // The projection, never `process.env`. See `AGENT_ENVIRONMENT`.
    config: options.agentEnvironment,
    ...(policyBinding === null ? {} : { transactionSigner: policyBinding.factory }),
  });

  if (created === null || typeof created !== 'object') {
    throw new StartupRefusal(`${AGENT_PACKAGE} createAgent() did not return an object.`);
  }

  const port = agentFromReading(created);

  /*
    The signer is a separate package from the agent on purpose, and this is where that separation
    pays. The agent knows how to build a transaction; the signer decides whether to sign one, under
    a policy this process never reads. Binding them separately means a deployment can hold the first
    without the second, which is exactly what a read-only hosted endpoint is.
  */
  const policyAvailable = policyBinding !== null;

  return { port, signer, policyAvailable };
}

/**
 * Find the signing authority for this deployment, and measure what it can do.
 *
 * # This package does not choose custody, and that is why it constructs so little
 *
 * `@projectx-social/signer` offers a local keypair, a multisig, a KMS adapter and a read-only
 * stand-in, and wraps any of them in a `PolicySigner` that needs a policy document, a spend ledger
 * and a simulation port. **Which of those an operator should hold is an operator's decision and an
 * agent-layer wiring job, not this package's.** A `PolicySigner` assembled here would mean this
 * file inventing a policy on somebody's behalf, which is the same class of mistake as enforcing a
 * ceiling here was.
 *
 * So this does the smallest honest thing. In stdio mode, where the operator has deliberately handed
 * this process a secret, it opens the local keypair signer that secret names. In hosted mode there
 * is no secret and therefore no signer at all — `readOnlySigner` needs an address to be read-only
 * *about*, and without a key there is not one. Then it probes, and reports.
 */
/**
 * Read the operator's policy document and validate the two things a wrong file would get past:
 * shape, and WHOSE policy it is. A document for another address bound to this key would either
 * refuse everything (harmless) or, worse, allow-list the wrong agent's own account and vault.
 */
export function loadPolicyDoc(text: string, signerAddress: string): { ok: true; policy: Record<string, unknown> } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'the policy file is not JSON' };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, reason: 'the policy file is not an object' };
  const doc = parsed as Record<string, unknown>;
  if (doc['version'] !== 1) return { ok: false, reason: `the policy file has version ${JSON.stringify(doc['version'])}; this server reads version 1` };
  const address = doc['agentAddress'];
  if (typeof address !== 'string' || address.toLowerCase() !== signerAddress.toLowerCase()) {
    return { ok: false, reason: 'the policy file names a different agentAddress than the bound signer; refusing to apply another agent\'s policy' };
  }
  for (const field of ['outflowCeilings', 'allowedTargets', 'allowedTypeArguments', 'allowedRecipients', 'allowedObjects']) {
    if (!Array.isArray(doc[field])) return { ok: false, reason: `the policy file lacks the ${field} list` };
  }
  return { ok: true, policy: doc };
}

interface PolicyBinding {
  factory: (client: unknown) => unknown;
}

/**
 * A `PolicySigner` factory for the agent, or null when no policy is configured. A CONFIGURED
 * policy that cannot be bound is a startup refusal, never a silent fallback to the bare key: an
 * operator who wrote a policy file did so to bound this process.
 */
async function bindPolicy(options: ServerOptions, signer: SignerBinding): Promise<PolicyBinding | null> {
  if (options.policyPath === null) return null;
  if (signer.kind !== 'signing') {
    throw new StartupRefusal(`${ENV.policy} is set but no signing key is bound; a policy needs a key to bound.`);
  }
  let text: string;
  try {
    text = readFileSync(options.policyPath, 'utf8');
  } catch (error) {
    throw new StartupRefusal(`${ENV.policy} names ${options.policyPath}, which could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  const loaded = loadPolicyDoc(text, signer.signer.address);
  if (!loaded.ok) throw new StartupRefusal(`${ENV.policy}: ${loaded.reason}`);

  const signerModule = await loadOptional(SIGNER_PACKAGE);
  const make = signerModule?.['policySigner'];
  if (typeof make !== 'function') {
    throw new StartupRefusal(`${ENV.policy} is set but ${SIGNER_PACKAGE} exports no policySigner(); nothing can apply it.`);
  }
  /*
    The ledger is the spend this process has seen, in memory, for the life of the process. A
    restarted server starts its rolling window empty — stated here because an operator sizing a
    ceiling should know the window is per process until a durable ledger (roadmap B21) lands.
  */
  const spend: Array<Record<string, unknown>> = [];
  const ledger = () => ({ nowMs: Date.now(), spend });
  const policy = loaded.policy;
  return {
    factory: (client: unknown) => (make as (o: unknown) => unknown)({ inner: signer.signer, policy, client, ledger }),
  };
}

async function bindSigner(options: ServerOptions): Promise<SignerBinding> {
  if (options.secretKey === null) return { kind: 'none' };

  const signerModule = await loadOptional(SIGNER_PACKAGE);
  if (signerModule === null) return { kind: 'none' };

  const open = signerModule['localKeypairSignerFromSecret'];
  if (typeof open !== 'function') {
    log(`${SIGNER_PACKAGE} exports no localKeypairSignerFromSecret; this deployment cannot sign`);
    return { kind: 'none' };
  }

  /*
    `localKeypairSignerFromSecret` returns a `Reading<Signer>` rather than throwing, so a malformed
    secret arrives here as a value. It is unwrapped before shape-checking, because a `Reading` is
    not a `Signer`: handing one to `assertSignerShape` would fail for the wrong reason and report
    the wrong thing to the operator.
  */
  const reading = (open as (secret: string) => unknown)(options.secretKey) as {
    ok?: unknown;
    value?: unknown;
    failure?: { detail?: string };
  };
  if (reading.ok !== true) {
    throw new StartupRefusal(
      `${SIGNER_PACKAGE} could not open the signing key: ${reading.failure?.detail ?? 'no detail given'} ` +
        '(the key itself has not been logged).',
    );
  }

  const shaped = assertSignerShape(reading.value);
  if (shaped === null) {
    throw new StartupRefusal(
      `${SIGNER_PACKAGE} returned something that is not a Signer. Expected { address, scheme, ` +
        'signPersonalMessage, signTransaction }. Refusing to start rather than arming a spending ' +
        'tool against an object this package cannot describe.',
    );
  }

  return (await probeSigner(shaped))
    ? { kind: 'signing', signer: shaped }
    : { kind: 'read-only', signer: shaped };
}

/* ------------------------------------------------------------------------------------------------
 * Transport 1 — stdio
 * ---------------------------------------------------------------------------------------------- */

/**
 * Run beside the agent, speaking JSON-RPC over the pipe the operator gave us.
 *
 * There is no listener, no port and no authentication, because there is no channel: the only party
 * that can speak to this process is the parent that spawned it. That is the whole reason a signing
 * key is admissible here and nowhere else — the key's audience is exactly one process, chosen by
 * the operator, on the operator's own machine.
 *
 * It is also why `idempotency.ts` may keep its ledger in memory: one pipe means one caller, so
 * there is no second client to be confused with.
 */
export async function serveStdio(server: McpServer): Promise<void> {
  await server.connect(new StdioServerTransport());
  log('listening on stdio');
}

/* ------------------------------------------------------------------------------------------------
 * Transport 2 — hosted HTTP
 * ---------------------------------------------------------------------------------------------- */

export const MCP_PATH = '/mcp';

/**
 * Whether a request's `Origin` may drive this endpoint.
 *
 * The default — an empty allowlist — refuses **every** request that carries an `Origin` header at
 * all, and accepts every request that carries none. That split is not arbitrary: browsers attach
 * `Origin` and MCP clients do not, so the default admits agent runtimes and excludes web pages.
 *
 * The attack this closes is the local one. An operator runs the hosted build on `127.0.0.1:8402`
 * for convenience, and then any page they visit can `fetch()` it, because loopback is not a
 * security boundary against the browser already running on that machine.
 *
 * The SDK's own `allowedHosts`/`enableDnsRebindingProtection` options are deprecated in 1.30.0 in
 * favour of exactly this — validation outside the transport — which is why it is written here.
 */
export function originAllowed(origin: string | undefined, allowed: readonly string[]): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}

/**
 * Whether a request's `Host` names this endpoint. **This is the DNS-rebinding control.**
 *
 * # The attack, precisely, because it is easy to mistake for the `Origin` one
 *
 * `Origin` stops a page at `https://evil.example` from calling `http://127.0.0.1:8402/mcp`,
 * because that request carries `Origin: https://evil.example` and the allowlist is empty.
 *
 * DNS rebinding routes around that entirely. The attacker's page is served from
 * `http://rebind.example`, whose DNS record they control. It first resolves to their own server;
 * then the record is re-pointed at `127.0.0.1` with a one-second TTL. The browser re-resolves,
 * connects to the operator's loopback, and — because the page's origin is still
 * `http://rebind.example` and the destination is *believed* to be the same origin — the request is
 * **same-origin**. `Origin` may not be sent at all, and if it is, it is the page's own.
 *
 * The one header that still tells the truth is `Host`, because the browser fills it from the name
 * in the URL: `Host: rebind.example`. This server was never `rebind.example`, so it refuses.
 *
 * # Why a missing `Host` is refused rather than allowed
 *
 * `Origin` is absent for a legitimate and common reason — non-browser clients do not send it — and
 * so absence there means "probably an agent runtime". `Host` is different: HTTP/1.1 makes it
 * mandatory and every HTTP/2 client sends `:authority`, which Node surfaces as `host`. An HTTP
 * request arriving here without one is malformed, and a malformed request is not the thing to
 * extend the benefit of the doubt to on the one check that stands between a loopback server and a
 * hostile web page.
 *
 * Comparison is exact and case-insensitive on the host, since DNS is case-insensitive and a
 * browser may send either. No suffix matching and no wildcards: `evil-127.0.0.1.example` ends with
 * nothing this server should accept, and a suffix rule is how that becomes a match.
 */
export function hostAllowed(host: string | undefined, allowed: readonly string[]): boolean {
  if (host === undefined || host.trim() === '') return false;
  const seen = host.trim().toLowerCase();
  return allowed.some((entry) => entry.trim().toLowerCase() === seen);
}

/**
 * Serve MCP over Streamable HTTP, statelessly.
 *
 * # A fresh server and transport for every request
 *
 * Not a performance oversight — the alternative is wrong. In stateless mode there is no session id
 * to attribute a response to, so a single shared transport serving concurrent callers can route one
 * caller's response onto another caller's stream, because the only key left is the JSON-RPC request
 * id and two clients pick those independently. Per-request instances make that structurally
 * impossible.
 *
 * It also *is* the second security property, expressed as code rather than as a promise: there is
 * no place to keep state between requests, so no state is kept. Nothing accumulates, nothing
 * identifies a caller across calls, and a restart loses nothing because there was nothing.
 *
 * `sessionIdGenerator` is omitted rather than passed as `undefined` — this repo compiles with
 * `exactOptionalPropertyTypes`, under which those are different things, and the SDK reads absence
 * as "session management disabled".
 */
export async function serveHttp(
  newServer: () => Promise<McpServer>,
  options: ServerOptions,
): Promise<HttpServer> {
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void handleHttpRequest(req, res, newServer, options);
  });

  await new Promise<void>((resolve) => {
    http.listen(options.httpPort, options.httpHost, resolve);
  });

  log(`listening on http://${options.httpHost}:${options.httpPort}${MCP_PATH} (stateless, keyless)`);
  log(`Host allowlist: ${options.allowedHosts.join(', ')} — anything else is refused (DNS rebinding)`);
  if (options.allowedOrigins.length === 0) {
    log(`no ${ENV.allowedOrigins} set: browser origins are refused, non-browser clients are served`);
  }
  return http;
}

async function handleHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  newServer: () => Promise<McpServer>,
  options: ServerOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname !== MCP_PATH) {
    respondJson(res, 404, { error: 'not_found', detail: `MCP is served at ${MCP_PATH}` });
    return;
  }

  /*
    Host before Origin, deliberately. A rebinding request may carry no Origin at all, so the Origin
    check would wave it through; checking Host first means the strongest control runs on every
    request rather than only on the ones that identify themselves as coming from a browser.
  */
  if (!hostAllowed(req.headers.host, options.allowedHosts)) {
    respondJson(res, 403, {
      error: 'host_refused',
      detail:
        `Host ${String(req.headers.host)} is not one this endpoint answers to. Set ` +
        `${ENV.allowedHosts} if this deployment is reached under another name.`,
    });
    return;
  }

  if (!originAllowed(req.headers.origin, options.allowedOrigins)) {
    respondJson(res, 403, {
      error: 'origin_refused',
      detail: `Origin ${String(req.headers.origin)} is not in ${ENV.allowedOrigins}.`,
    });
    return;
  }

  /*
    NO COOKIES, IN EITHER DIRECTION.

    This server never sets one — there is no `Set-Cookie` anywhere in this package and no session to
    put in one — and it refuses any request that carries one.

    Refusing rather than ignoring is the deliberate half. A cookie is *ambient* authority: the
    browser attaches it to a request the page did not have to think about, which is what makes it
    useful for a session and what makes it the wrong shape for anything here. Ignoring an inbound
    cookie would leave the server working perfectly for a caller who believes cookies matter to it,
    and that belief is how a credential ends up being sent to an endpoint that never asked for one
    and cannot protect it. A refusal tells them on the first request.

    It is also a second, independent brake on the browser path. A page that somehow satisfied both
    Host and Origin would still be sending the operator's cookie jar for this host, and would still
    be refused here.

    A non-browser MCP client has no reason to send one, so nothing legitimate is lost.
  */
  if (req.headers.cookie !== undefined) {
    respondJson(res, 400, {
      error: 'cookie_refused',
      detail:
        'this endpoint accepts no cookies and issues none. There is no session here to carry: ' +
        'every weir write is authorised by a fresh single-use signature, never by ambient ' +
        'credentials. Send the request without a Cookie header.',
    });
    return;
  }

  const server = await newServer();
  const transport = new StreamableHTTPServerTransport({
    // No SSE: this server sends nothing the client did not ask for, so holding a stream open would
    // be a connection kept alive to carry nothing.
    enableJsonResponse: true,
  });

  /*
    Both are closed when the response ends, including on an aborted connection. Without this, every
    request leaks a transport and a server for the lifetime of the process — which on a public
    endpoint is a memory exhaustion primitive available to anyone who can open a socket.
  */
  res.on('close', () => {
    void transport.close();
    void server.close();
  });

  try {
    await server.connect(asTransport(transport));
    await transport.handleRequest(req, res);
  } catch (error) {
    log('http request failed:', error instanceof Error ? error.message : String(error));
    if (!res.headersSent) {
      respondJson(res, 500, { error: 'internal', detail: 'the request could not be served' });
    }
  }
}

/**
 * The one cast in this package, and what it is standing in for.
 *
 * `@modelcontextprotocol/sdk` 1.30.0 is not `exactOptionalPropertyTypes`-clean, and the two
 * transports in that same release disagree with each other about it. `StdioServerTransport`
 * declares `onclose?: () => void`, a plain optional property, and satisfies `Transport` directly.
 * `StreamableHTTPServerTransport` declares `onclose` as a getter/setter pair typed
 * `(() => void) | undefined`, which under this repo's `exactOptionalPropertyTypes: true` is a
 * *different* type from an optional property — so `server.connect(transport)` fails to compile with
 * `TS2379`, on a class the SDK plainly intends to be passed to exactly that function.
 *
 * The tempting fix is to drop `exactOptionalPropertyTypes` from this package's `tsconfig.json`.
 * That is the wrong trade by a wide margin: it would relax the check across every file here,
 * including the option and ceiling handling where the difference between "absent" and "explicitly
 * undefined" is a price, to work around one accessor declaration in a dependency. The narrow cast
 * is confined to a single line, is named, and is only reachable through this function.
 *
 * It is sound at runtime — the object genuinely implements `Transport`; the incompatibility is
 * purely in how optionality is written. Delete this when the SDK ships accessors typed as optional
 * properties, and the compiler will tell you it is unnecessary rather than letting it rot.
 */
function asTransport(transport: StreamableHTTPServerTransport): Transport {
  return transport as unknown as Transport;
}

/**
 * Write a plain JSON refusal.
 *
 * No `Set-Cookie`, no `Access-Control-Allow-Origin`, and no other header that would grant a browser
 * anything. A refusal that helpfully told a page it was allowed to read the refusal would be a
 * strange way to end a function whose whole job is keeping pages out.
 */
function respondJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}
