// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * `Reading<T>` — the result of looking at something that might not have answered.
 *
 * # Why this type exists
 *
 * A reader that failed and a reader that measured nothing must not produce the same output. When
 * they do, an outage is indistinguishable from an observation, and people believe the observation.
 * A dashboard showing a creator "0 USDC earned" because the node timed out looks exactly like a
 * creator who has earned nothing, and only one of those is worth acting on.
 *
 * So every chain read in this SDK returns a `Reading<T>`. There is deliberately **no**
 * `unwrapOr(fallback)` and no `.valueOr(0)`. A default value is the precise mechanism that turns a
 * failure into a plausible zero, and providing one would mean every call site can opt out of the
 * distinction this module exists to preserve.
 *
 * To get at a value you must supply both branches — see {@link fold}.
 */

/** Why a read did not produce a value. */
export type FailureKind =
  /** The request never completed: connection refused, DNS, TLS, socket reset. */
  | 'transport'
  /** The request exceeded its deadline. Distinct from `transport` because a timeout may succeed on retry. */
  | 'timeout'
  /** A response arrived but did not have the expected shape. Usually a version skew, not an outage. */
  | 'malformed'
  /** Nothing was configured to read from. A deliberate, calm absence — not a fault. */
  | 'unconfigured'
  /** We looked, and the thing genuinely does not exist. A 404, not a 503. */
  | 'not-found'
  /** A bound was hit before the answer was complete. See `truncated` on paged reads. */
  | 'budget-exhausted'
  /**
   * We asked, we were understood, and the answer was "not yet". Something the caller can read
   * has to change first — a paused platform, a closed vault, an unfunded wallet, a moved price, an
   * expired session. Not `transport` (retrying blindly is exactly wrong), not `not-found` (the thing
   * exists), not `malformed` (nothing about the request was wrong). `detail` names the condition.
   */
  | 'precondition'
  /**
   * We asked, we were understood, and the answer was "no". The thing exists and is readable by the
   * people entitled to it; the caller is not one of them. A paywall, a 403, a key server refusing a
   * key. Reporting this as `not-found` is how "you have not bought this" becomes "this is gone".
   */
  | 'denied';

/**
 * Every member of {@link FailureKind}, as a value.
 *
 * The `satisfies` clause is the completeness proof: add a kind to the union without adding it here
 * and this file stops compiling. Tests iterate this list so a switch that forgets a kind fails at
 * both compile time (the `never` checks below) and run time (the test that walks every member).
 */
export const FAILURE_KINDS = [
  'transport',
  'timeout',
  'malformed',
  'unconfigured',
  'not-found',
  'budget-exhausted',
  'precondition',
  'denied',
] as const satisfies readonly FailureKind[];

/**
 * What a caller may usefully do next, per kind.
 *
 * - `retry`: an identical attempt may succeed with nothing changed. Back off, then try again.
 * - `wait`: an identical attempt fails until something readable changes. Re-check the condition
 *   named in `detail`; do not hammer.
 * - `stop`: an identical attempt will fail for ever. Change the request, the configuration or the
 *   entitlement, or report and stop.
 *
 * An exhaustive `switch` on purpose. Removing a case makes `_exhaustive` a non-`never` and the
 * build goes red — that is the guarantee a new kind cannot arrive here unclassified.
 */
export type RetryAdvice = 'retry' | 'wait' | 'stop';

export function retryAdvice(kind: FailureKind): RetryAdvice {
  switch (kind) {
    case 'transport':
    case 'timeout':
      return 'retry';
    case 'precondition':
      return 'wait';
    case 'malformed':
    case 'unconfigured':
    case 'not-found':
    case 'budget-exhausted':
    case 'denied':
      return 'stop';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

/** One sentence per kind, for a log or a screen a human reads. Exhaustive, like {@link retryAdvice}. */
export function describeFailureKind(kind: FailureKind): string {
  switch (kind) {
    case 'transport':
      return 'the request never completed';
    case 'timeout':
      return 'the request exceeded its deadline';
    case 'malformed':
      return 'a response arrived but did not have the expected shape';
    case 'unconfigured':
      return 'nothing was configured to read from';
    case 'not-found':
      return 'we looked, and the thing does not exist';
    case 'budget-exhausted':
      return 'a bound was hit before the answer was complete';
    case 'precondition':
      return 'the answer was "not yet": something has to change first';
    case 'denied':
      return 'the answer was "no": this is not available to this caller';
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export interface Failure {
  kind: FailureKind;
  /** What was being read, for a message a human can act on. */
  source: string;
  /** The underlying error text, unmodified. Never a guess at what it meant. */
  detail: string;
}

export type Reading<T> =
  | { readonly ok: true; readonly value: T; readonly observedAtMs: number }
  | { readonly ok: false; readonly failure: Failure };

export function ok<T>(value: T, observedAtMs: number = Date.now()): Reading<T> {
  return { ok: true, value, observedAtMs };
}

export function fail<T>(kind: FailureKind, source: string, detail: string): Reading<T> {
  return { ok: false, failure: { kind, source, detail } };
}

/**
 * Consume a reading. Both branches are required — that is the entire point.
 *
 * There is no single-branch variant. A caller who genuinely does not care about failure should
 * say so explicitly in `onFailure`, where the next reader can see the decision.
 */
export function fold<T, R>(
  reading: Reading<T>,
  onOk: (value: T, observedAtMs: number) => R,
  onFailure: (failure: Failure) => R,
): R {
  return reading.ok ? onOk(reading.value, reading.observedAtMs) : onFailure(reading.failure);
}

/** Map a successful reading, preserving the failure and the observation time. */
export function map<T, R>(reading: Reading<T>, f: (value: T) => R): Reading<R> {
  return reading.ok ? ok(f(reading.value), reading.observedAtMs) : reading;
}

/**
 * Turn a failure into a thrown error.
 *
 * Provided for call sites where continuing is genuinely impossible — building a transaction that
 * needs a real object id, for instance. Deliberately named to sound like a decision rather than a
 * convenience, because it is one: it discards the distinction the type exists to carry.
 */
export function orThrow<T>(reading: Reading<T>): T {
  if (reading.ok) return reading.value;
  const { kind, source, detail } = reading.failure;
  throw new Error(`could not read ${source} (${kind}): ${detail}`);
}

/**
 * Health of a reader over time.
 *
 * `never-succeeded` is its own state and the loudest one. A reader called ten thousand times that
 * has never once returned data is not "healthy with no results" — it is broken, and only a
 * distinct status can say so.
 */
export type ReaderHealth = 'idle' | 'never-succeeded' | 'failing' | 'degraded' | 'healthy';

export interface ReaderStats {
  attempts: number;
  successes: number;
  consecutiveFailures: number;
  lastSuccessAtMs: number | null;
}

export function readerHealth(stats: ReaderStats): ReaderHealth {
  if (stats.attempts === 0) return 'idle';
  if (stats.successes === 0) return 'never-succeeded';
  if (stats.consecutiveFailures >= 3) return 'failing';
  if (stats.consecutiveFailures > 0) return 'degraded';
  return 'healthy';
}

/**
 * Classify a thrown error into a `FailureKind`.
 *
 * Conservative on purpose. Anything not confidently recognised is `transport` with the original
 * text preserved, because a wrong explanation is worse than an opaque one — an opaque one can be
 * searched for.
 */
export function classify(error: unknown, source: string): Failure {
  const detail = error instanceof Error ? error.message : String(error);
  const lower = detail.toLowerCase();

  let kind: FailureKind = 'transport';
  if (lower.includes('deadline') || lower.includes('timeout') || lower.includes('aborted')) {
    kind = 'timeout';
  } else if (
    // A refusal that arrived as words. HTTP's 403 vocabulary, gRPC's PERMISSION_DENIED, and the
    // sentence Seal's key servers use. Checked before not-found because "user does not have access
    // to one or more of the requested keys" must never be read as "no such key".
    lower.includes('forbidden') ||
    lower.includes('permission denied') ||
    lower.includes('permission_denied') ||
    lower.includes('does not have access') ||
    lower.includes('unauthorized') ||
    lower.includes('unauthorised')
  ) {
    kind = 'denied';
  } else if (
    lower.includes('not found') ||
    lower.includes('notfound') ||
    // gRPC's canonical status name, and the form a Sui node actually returns. Missing it meant
    // every "no such object" was classified as `transport` — so the readers that fold a not-found
    // into a measured absence ("this address has no key", "this handle is free") reported a
    // connection problem instead, and a caller that trusted the classification would tell the user
    // the network was down when the answer was simply "there is none".
    lower.includes('not_found')
  ) {
    kind = 'not-found';
  }

  return { kind, source, detail };
}
