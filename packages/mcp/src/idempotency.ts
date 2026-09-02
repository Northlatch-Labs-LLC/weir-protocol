// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * A retried tool call must not buy the thing twice.
 *
 * # The defect this closes, in the order it actually happens
 *
 * An MCP client calls `weir_buy`. The transaction is submitted and settles on chain. The response
 * is lost — the socket drops, the runtime times out, the model's turn is cancelled, the process is
 * restarted by a supervisor mid-flight. From the client's side, all of those look identical to
 * "the call failed", and the correct behaviour for a client that believes a call failed is to
 * **retry it**. The retry buys a second Unlock for the same post, with a second debit, and both
 * transactions are valid: nothing on chain and nothing in this package refuses a genuine second
 * purchase, because a genuine second purchase is a thing a person might mean.
 *
 * The agent layer does not close this either. `packages/agent` sends no `Idempotency-Key` on any
 * call — the header the weir API already understands (`packages/web/lib/idempotency.ts`, table
 * `agent_requests`) is simply never set by it. And for `unlock` and `subscribe` there would be
 * nothing to set it on anyway: those are Sui transactions, not HTTP writes, so the API's ledger is
 * not in the path at all.
 *
 * # The key comes from the MCP request id, and that is the whole trick
 *
 * A retry is defined by re-sending the *same request*. JSON-RPC gives that request an id, and a
 * client retrying its own call re-sends the id it used — that is what makes a retry a retry rather
 * than a new call. So the request id is the one value in the protocol that is stable across a retry
 * and different across a genuine second purchase, which is exactly the discrimination this needs.
 *
 * The key is a digest of four things, and each is in there to stop a specific confusion:
 *
 *  - **the request id** — the retry marker itself;
 *  - **the tool name** — so id 7 on `weir_buy` and id 7 on `weir_subscribe` are different
 *    operations, which they are;
 *  - **the arguments** — so a client that reuses an id (they are only required to be unique within
 *    a session, and some clients count from 1 per connection) for genuinely different arguments
 *    gets a genuinely different key, and is not handed the wrong post's receipt;
 *  - **the principal's address** — so two agents that happen to be at request id 1 can never read
 *    each other's results. Belt and braces given the scoping rule below, and cheap.
 *
 * # Scope: this ledger is per-process and that is sound, not a shortcut
 *
 * It lives in memory in one process and is not shared, replicated or persisted. That is safe here
 * for a structural reason rather than a hopeful one: **the spending tools only exist in a
 * deployment with exactly one client.** `resolveOptions` refuses to hold a key under HTTP, and
 * `registerTools` registers a spending tool only where a signer exists, so a spending tool is only
 * ever reachable over stdio — one pipe, one parent process, one caller. There is no second caller
 * to be confused with, and no other process holding a competing view of the same wallet's
 * purchases.
 *
 * What it therefore does **not** survive is a restart of this process, and that limit is stated in
 * the README rather than papered over. Durable cross-restart idempotency needs the key to reach the
 * weir API or the chain, and today neither the agent port nor the transaction builder accepts one.
 *
 * # Why the arguments are canonicalised rather than hashed as received
 *
 * `packages/web/lib/idempotency.ts` is emphatic that a body must be hashed **as raw bytes**, never
 * reserialised, because `JSON.stringify` emits keys in insertion order and a byte-identical retry
 * from a client that rebuilt its payload would hash differently and be refused.
 *
 * That rule cannot be followed here and the difference is worth being precise about. By the time a
 * tool handler runs, the MCP SDK has already parsed the JSON-RPC frame and validated the arguments
 * against a Zod schema; the raw bytes are gone and there is no hook that hands them back. So the
 * arguments are canonicalised instead — keys sorted, no insignificant whitespace, recursively — and
 * canonicalisation buys back exactly the property the raw-bytes rule was protecting: two encodings
 * of the same arguments produce the same digest. It is in fact slightly stronger, since a client
 * that reorders its keys between attempts is still recognised as retrying. The cost is that this
 * digest is not comparable with the API's, and nothing tries to compare them.
 */

import { createHash } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** JSON-RPC ids are strings or numbers. Kept local so this module imports no SDK value. */
export type RequestId = string | number;

/**
 * How long a completed result is remembered.
 *
 * Twenty-four hours, matching `IDEMPOTENCY_TTL_MS` in `packages/web/lib/idempotency.ts`, and for
 * the reason that file gives: a machine's backoff is measured in minutes, and a ten-minute memory
 * expires underneath a retry that is still legitimately in progress — returning the caller to the
 * ambiguity this exists to remove, at the one moment it is hardest to notice.
 */
export const RESULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The most results held at once.
 *
 * A bound rather than a tuning knob. This ledger is keyed by values a caller chooses, so an
 * unbounded map is an unbounded allocation driven by the caller — which in a long-lived stdio
 * process is a slow memory leak with an agent's name on it. Five hundred and twelve spending calls
 * inside one TTL is far beyond any real session, and eviction is oldest-first so the entries lost
 * are the ones least likely to still be retried.
 */
export const MAX_ENTRIES = 512;

/** Everything the key is derived from. Every field participates; see the note above for each. */
export interface KeyInput {
  requestId: RequestId;
  tool: string;
  args: unknown;
  /** The signer's address. `null` in a deployment that cannot spend — where nothing calls this. */
  principal: string | null;
}

/**
 * Deterministic ordering for any JSON-shaped value.
 *
 * Objects have their keys sorted; arrays keep their order, because order is meaning in an array and
 * sorting one would make two different requests hash the same. `undefined` is dropped inside
 * objects exactly as `JSON.stringify` drops it, so an explicitly-`undefined` optional and an absent
 * one are the same request — which they are, on this wire.
 */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
    return `{${entries.join(',')}}`;
  }
  if (typeof value === 'bigint') return `"${value.toString()}"`;
  return JSON.stringify(value) ?? 'null';
}

/**
 * The idempotency key for one tool call.
 *
 * Returned as hex rather than as the raw parts so that it is a fixed width, is safe to log, and
 * carries none of the arguments — a key printed in a diagnostic should not reveal which post an
 * agent was buying.
 *
 * The parts are joined with a NUL byte. `JSON.stringify` always escapes NUL as the six characters
 * \u0000, so it can never appear inside the canonicalised arguments, which makes the
 * concatenation unambiguous: no combination of tool name and arguments can be re-cut into a
 * different combination that hashes the same. Joining with a space, a colon or a slash would
 * leave exactly that ambiguity, because all three occur freely in the parts.
 */
export function idempotencyKeyFor(input: KeyInput): string {
  const material = [
    'weir-mcp/1',
    input.principal ?? '',
    input.tool,
    typeof input.requestId === 'number' ? `n:${input.requestId}` : `s:${input.requestId}`,
    canonical(input.args),
  ].join('\u0000');
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

interface Entry {
  /** Resolves to the result the first attempt produced. Shared by every retry that joins it. */
  work: Promise<CallToolResult>;
  startedAtMs: number;
  /**
   * Whether `work` has finished, either way.
   *
   * Eviction reads this and nothing else. An entry that has not settled is the ONLY record that a
   * call is in flight, so dropping it is dropping the guard — see {@link CallLedger.evict}.
   */
  settled: boolean;
}

/**
 * Run a spending call at most once per key.
 *
 * # Why the map holds a promise and not a finished result
 *
 * The dangerous retry is the *concurrent* one. A client whose call is still in flight when its
 * timeout fires sends the second attempt while the first transaction is still being simulated and
 * signed — so a ledger that only recorded finished calls would find nothing, let the second one
 * through, and produce the double-buy it exists to prevent. Recording the in-flight promise makes
 * the second caller **join** the first rather than race it, and both receive the one result.
 *
 * This is the same reasoning `claimIdempotencyKey` gives for claiming with an insert rather than a
 * lookup-then-insert: the window between checking and acting is not a smaller version of the
 * problem, it is the same problem rewritten as a race.
 *
 * # A failure is not remembered
 *
 * If the work rejects, the entry is dropped, so the next attempt runs for real. A retry after a
 * genuine failure is the behaviour the caller wants and the one thing this must not block — and a
 * rejection here means the agent layer refused before signing, or the transaction did not execute,
 * both of which are states a retry can legitimately improve.
 *
 * A *refusal* is different from a rejection and is deliberately remembered: a handler that returns
 * an `isError` result has completed, and returning the same refusal to a retry is correct.
 */
export class CallLedger {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly nowMs: () => number = Date.now) {}

  /** Entries currently held. For diagnostics and for the harness; not part of the tool surface. */
  get size(): number {
    return this.entries.size;
  }

  async once(key: string, work: () => Promise<CallToolResult>): Promise<CallToolResult> {
    this.evict();

    const existing = this.entries.get(key);
    if (existing !== undefined) return existing.work;

    const started = this.nowMs();
    const promise = work();
    const entry: Entry = { work: promise, startedAtMs: started, settled: false };
    /*
      Marked from the promise itself rather than from the `await` below, so it is true no matter who
      observes the result. A second caller joining this entry returns `existing.work` without ever
      reaching that `await`, and if the flag were set there, an entry awaited only by a joiner would
      stay "in flight" for ever and never be evictable.

      Both branches are handled, which also means this promise's rejection is never unobserved.
    */
    void promise.then(
      () => {
        entry.settled = true;
      },
      () => {
        entry.settled = true;
      },
    );
    this.entries.set(key, entry);

    try {
      return await promise;
    } catch (error) {
      // See the note above: a rejection is not a completed operation, so it is not remembered.
      this.entries.delete(key);
      throw error;
    }
  }

  /**
   * Drop what has aged out, then what is oldest if the map is still over its bound.
   *
   * # Work in flight is never evicted, by either rule
   *
   * `once` evicts BEFORE it looks the key up, and both rules used to delete by age and by
   * insertion order without asking whether the call had finished. An in-flight entry is the only
   * record that a spending call is already running — so evicting one deletes the guard itself, and
   * the concurrent retry that arrives next finds nothing, runs the work a second time, and
   * produces the double-buy this class exists to prevent. The ledger removed its own protection at
   * the exact moment it was under load.
   *
   * The capacity rule is the reachable one. `RESULT_TTL_MS` is twenty-four hours and no call is in
   * flight that long, but `MAX_ENTRIES` is 512 and the oldest entry under concurrent load is very
   * plausibly still running.
   *
   * # The bound yields to correctness, deliberately
   *
   * If every entry held is in flight, the loop stops and the map is allowed over its bound. That
   * bound exists to stop unbounded memory growth in a long-lived process; it does not exist to be
   * enforced against the one invariant this class has. Growth past it is self-limiting — the
   * entries settle and become evictable on the next call — while a double-buy is not.
   */
  private evict(): void {
    const now = this.nowMs();
    for (const [key, entry] of this.entries) {
      if (entry.settled && now - entry.startedAtMs > RESULT_TTL_MS) this.entries.delete(key);
    }
    while (this.entries.size >= MAX_ENTRIES) {
      // Map iteration is insertion-ordered, so the first SETTLED key is the oldest droppable one.
      let dropped = false;
      for (const [key, entry] of this.entries) {
        if (entry.settled) {
          this.entries.delete(key);
          dropped = true;
          break;
        }
      }
      if (!dropped) break;
    }
  }
}
