// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The adapter between `@projectx-social/agent` and this server's {@link WeirPort}.
 *
 * # Why this file exists
 *
 * Until 2026-09-02 `agentFromReading` returned the agent object *as* the port — one cast. The two
 * shapes disagree on every write:
 *
 * - the port's `unlock` carries `ceiling: { maxPrice, currency }`; the agent's takes `maxPrice`
 *   and `priceMinorUnits` as bare fields, so under the cast an armed `weir_buy` reached the agent
 *   with `maxPrice === undefined` and was refused every time ("maxPrice is required");
 * - the agent answers every call with a `Reading<T>` — `{ ok, value }` or `{ ok, failure }` —
 *   while the port promises bare receipts, so `weir_post` read `created.postId` off an envelope
 *   and reported success with `postId: undefined` on a REFUSED publish; `weir_price` reported no
 *   digest; `weir_quote` spread an envelope holding a `bigint`, which `JSON.stringify` cannot
 *   serialise.
 *
 * Every one of those is a seam between two tested modules that no test crossed. This file is the
 * seam made explicit, and `test/agent-port.ts` crosses it.
 *
 * # The two rules
 *
 * 1. **A failed `Reading` is a refusal, never a throw of convenience and never a success.** It
 *    surfaces as a {@link PortRefusal} carrying the agent's own failure kind and source, which
 *    `tools.ts` turns into the tool's refusal shape. A tool result that says `ok: true` therefore
 *    means the agent said `ok: true`.
 * 2. **Nothing here applies a ceiling.** The ceiling is carried to the agent, whose `guardPrice`
 *    compares it against the live price it reads itself. This file only translates the shape.
 *
 * # What a receipt can and cannot carry
 *
 * The agent's `Executed` is `{ digest, simulation }` — no created object ids (the executor reads
 * no effects, by its own documented decision). So `unlockObjectId` and `subscriptionObjectId` are
 * `null` here, and the type says so; the object is on chain under the digest. `pricePaid` on an
 * unlock is the live price the adapter read immediately before the buy — the same number the
 * agent funds and guards, unless the creator repriced in the milliseconds between the two reads,
 * in which case the agent's own guard still bounds the spend. A subscription's tier price is not
 * exposed by the agent's read surface, so its `pricePaid` is `null`: not read, never guessed.
 */
import type { WeirPort, Currency } from './transport.js';

/** The agent library's `Reading`, structurally — this file must not depend on the package at type level. */
type Reading<T> =
  | { ok: true; value: T }
  | { ok: false; failure: { kind: string; source?: string; detail: string } };

/**
 * A refusal that crossed the seam. `kind` and `source` are the agent library's own words
 * (`transport`, `timeout`, `malformed`, `not-found`, `precondition`, `denied`, `unconfigured`, …) so a
 * caller can decide whether to retry, and so a log line reads the same on both sides.
 */
export class PortRefusal extends Error {
  constructor(
    readonly kind: string,
    readonly source: string,
    detail: string,
  ) {
    super(detail);
    this.name = 'PortRefusal';
  }
}

function unwrap<T>(reading: Reading<T>, source: string): T {
  if (reading.ok) return reading.value;
  const f = reading.failure;
  throw new PortRefusal(f.kind, f.source ?? source, f.detail);
}

/**
 * The denomination of a coin type, for the port's `currency` field. Only the two the tools accept
 * are named; anything else is a refusal, because printing a price without saying what it is
 * denominated in is how "100000000" is read as a dollar amount.
 */
export function currencyOf(coinType: string): Currency {
  if (/::sui::SUI$/.test(coinType)) return 'SUI';
  if (/::usdc::USDC$/i.test(coinType)) return 'USDC';
  throw new PortRefusal(
    'unconfigured',
    'currency',
    `the vault's coin type ${coinType} is neither SUI nor USDC, and this server names prices only in those two.`,
  );
}

/** The agent surface this adapter reads, structurally. Optional everywhere: absence is a capability answer. */
interface AgentLike {
  address?: string;
  manifest?: { coinType?: string };
  quote?: (post: { vaultId: string; contentKey: string }) => Promise<
    Reading<{ vaultId: string; contentKey: string; coinType: string; priceMinorUnits: bigint; owner: string; accepting: boolean; observedAtMs: number }>
  >;
  balance?: (coinType?: string) => Promise<Reading<bigint>>;
  feed?: WeirPort['feed'];
  readPreview?: (input: { postId: string }) => Promise<Reading<{ postId: string; handle: string; title: string; body: string; entitledVia: 'public' } | null>>;
  unlock?: (input: { vaultId: string; contentKey: string; priceMinorUnits: bigint; maxPrice: bigint }) => Promise<Reading<{ digest: string }>>;
  subscribe?: (input: { vaultId: string; tierIndex: number; maxPrice: bigint }) => Promise<Reading<{ digest: string }>>;
  post?: (input: {
    handle: string;
    title: string;
    preview: string;
    text: string;
    access: 'public' | 'paid' | 'subscribers';
    tier?: number;
    contentKey?: string;
    price?: string;
    idempotencyKey?: string;
  }) => Promise<Reading<{ postId: string }>>;
  send?: (input: { to: string; text: string; preview: string; idempotencyKey?: string }) => Promise<Reading<{ sent: true }>>;
  priceContent?: (input: { vaultId: string; contentKey: string; edition?: 'human' | 'machine'; price: bigint }) => Promise<Reading<{ digest: string }>>;
  machineBody?: WeirPort['machineBody'];
}

const has = <K extends keyof AgentLike>(
  agent: AgentLike,
  name: K,
): agent is AgentLike & { [P in K]-?: NonNullable<AgentLike[P]> } => typeof agent[name] === 'function';

/**
 * Bind an agent to the port, method by method. A method is present on the port only when the
 * agent has it, so {@link capabilitiesOf} keeps reading the truth: a keyless `ReadOnlyAgent`
 * yields a port with `quote` and `feed` and nothing that spends.
 */
export function portFromAgent(candidate: unknown): WeirPort {
  const agent = (candidate ?? {}) as AgentLike;
  const port: WeirPort = {};

  if (has(agent, 'feed')) port.feed = (input) => agent.feed(input);
  if (has(agent, 'readPreview')) {
    // `null` means "exists, not entitled" on both sides; a failed Reading is a refusal, as everywhere.
    port.readPreview = async (input) => unwrap(await agent.readPreview(input), 'readPreview');
  }
  if (has(agent, 'machineBody')) port.machineBody = (input) => agent.machineBody(input);

  if (has(agent, 'quote')) {
    port.quote = async (input) => {
      const q = unwrap(await agent.quote(input), 'quote');
      return {
        vaultId: q.vaultId,
        contentKey: q.contentKey,
        price: q.priceMinorUnits.toString(),
        currency: currencyOf(q.coinType),
        coinType: q.coinType,
        owner: q.owner,
        accepting: q.accepting,
        observedAtMs: q.observedAtMs,
      };
    };
  }

  if (has(agent, 'balance') && typeof agent.address === 'string' && typeof agent.manifest?.coinType === 'string') {
    const address = agent.address;
    const coinType = agent.manifest.coinType;
    port.balance = async () => {
      const spendable = unwrap(await agent.balance(), 'balance');
      return { address, spendable: spendable.toString(), currency: currencyOf(coinType) };
    };
  }

  if (has(agent, 'unlock') && has(agent, 'quote')) {
    port.unlock = async ({ vaultId, contentKey, ceiling }) => {
      const q = unwrap(await agent.quote({ vaultId, contentKey }), 'unlock');
      const currency = currencyOf(q.coinType);
      if (currency !== ceiling.currency) {
        throw new PortRefusal(
          'precondition',
          'unlock',
          `the ceiling is in ${ceiling.currency} but vault ${vaultId} prices in ${currency}; nothing was signed.`,
        );
      }
      const done = unwrap(
        await agent.unlock({ vaultId, contentKey, priceMinorUnits: q.priceMinorUnits, maxPrice: ceiling.maxPrice }),
        'unlock',
      );
      return { txDigest: done.digest, unlockObjectId: null, pricePaid: q.priceMinorUnits.toString(), currency };
    };
  }

  if (has(agent, 'subscribe') && typeof agent.manifest?.coinType === 'string') {
    const coinType = agent.manifest.coinType;
    port.subscribe = async ({ vaultId, tierIndex, ceiling }) => {
      const currency = currencyOf(coinType);
      if (currency !== ceiling.currency) {
        throw new PortRefusal(
          'precondition',
          'subscribe',
          `the ceiling is in ${ceiling.currency} but this agent pays in ${currency}; nothing was signed.`,
        );
      }
      const done = unwrap(await agent.subscribe({ vaultId, tierIndex, maxPrice: ceiling.maxPrice }), 'subscribe');
      return { txDigest: done.digest, subscriptionObjectId: null, pricePaid: null, currency };
    };
  }

  if (has(agent, 'post')) {
    // The tool's key travels to the route as `Idempotency-Key`, so a retried tool call is answered
    // with the first publish rather than a second post (B3; `lib/idempotent-route.ts` on the web).
    port.post = async (article) => {
      const created = unwrap(await agent.post(article), 'post');
      return { postId: created.postId };
    };
  }

  if (has(agent, 'send')) {
    port.send = async ({ to, text, preview, idempotencyKey }) => {
      unwrap(await agent.send({ to, text, preview, idempotencyKey }), 'send');
      return { sent: true as const };
    };
  }

  if (has(agent, 'priceContent')) {
    port.priceContent = async ({ vaultId, contentKey, edition, price }) => {
      let amount: bigint;
      try {
        amount = BigInt(price);
      } catch {
        throw new PortRefusal('malformed', 'priceContent', `price ${JSON.stringify(price)} is not a whole number.`);
      }
      const done = unwrap(
        await agent.priceContent({ vaultId, contentKey, ...(edition === undefined ? {} : { edition }), price: amount }),
        'priceContent',
      );
      return { txDigest: done.digest };
    };
  }

  return port;
}
