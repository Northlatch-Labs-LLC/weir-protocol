// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Everything that makes the daemon survivable when nobody is watching.
 *
 * The tick engine decides correctly and the adapters read and sign correctly. None of that helps if
 * the process dies at 3am and nothing notices, or if two copies run and both pay gas, or if a
 * failing node gets hammered every sixty seconds forever. This file is about those.
 *
 * # Exit codes mean something
 *
 * A supervisor decides whether to restart from the exit code, so the codes have to distinguish
 * "fix the configuration" from "the network was down". Restarting on the first is an infinite loop
 * that looks like activity.
 *
 *   0  work completed (or a clean shutdown on a signal)
 *   1  misconfigured — do NOT restart, a human has to change something
 *   2  another instance holds the lock — do NOT restart, this one is redundant
 *   3  the run failed for a reason that may pass — restarting is reasonable
 *
 * # Backoff exists so a bad node does not become a bad bill
 *
 * A tick that fails on transport is retried later, not immediately, and the delay grows. Without it
 * an unreachable fullnode produces one failed tick per interval forever, each one a full discovery
 * walk. With `--once` under a supervisor the same job is done by the supervisor's own restart
 * delay, which is why backoff only applies to the in-process loop.
 *
 * # Shutdown is graceful because a harvest is money
 *
 * On SIGTERM the current tick is allowed to finish. Killing the process between signing and
 * executing leaves a transaction whose fate is unknown, and the journal would record a failure for
 * something that may well have landed. The deadline is bounded: a tick that will not finish is
 * eventually abandoned, and the journal keeps its `running` row, which is exactly the signal that
 * something went wrong.
 */

export const EXIT = {
  ok: 0,
  misconfigured: 1,
  alreadyRunning: 2,
  runFailed: 3,
} as const;

/** How long a graceful shutdown waits for an in-flight tick before giving up. */
export const SHUTDOWN_GRACE_MS = 30_000;

export interface Backoff {
  /** How long to wait before the next attempt, given the failures recorded so far. */
  delayMs(): number;
  /** Record a failed attempt. The next delay grows. */
  fail(): void;
  /** Record a success. The next delay returns to the base interval. */
  succeed(): void;
  /** Consecutive failures. Logged, so a reader sees a trend rather than a single bad line. */
  failures(): number;
}

/**
 * Exponential backoff with full jitter, capped.
 *
 * Jitter is not decoration. Several daemons that started together and back off identically retry
 * together forever, turning a brief outage into a synchronised spike at every interval — the
 * thundering herd. Full jitter (a uniform draw across the whole window, rather than the window's
 * edge) is the variant that spreads retries best, and it costs one call to `Math.random`.
 *
 * The exponent is capped before the multiply. That guard is **defence in depth, not load-bearing**,
 * and a mutation test removing it leaves every test here passing — correctly, because `Math.min`
 * against `maxMs` already absorbs the result, and `Math.min(Infinity, maxMs)` is `maxMs`. It is
 * kept because it makes the arithmetic obviously bounded to a reader instead of relying on a later
 * line, and it is labelled rather than left to look like a guarantee something checks.
 */
export function createBackoff(options: {
  baseMs: number;
  maxMs: number;
  random?: () => number;
}): Backoff {
  const random = options.random ?? Math.random;
  let failures = 0;

  return {
    failures: () => failures,
    fail: () => {
      failures += 1;
    },
    succeed: () => {
      failures = 0;
    },
    delayMs: () => {
      if (failures === 0) return options.baseMs;
      const exponent = Math.min(failures, 20);
      const ceiling = Math.min(options.baseMs * 2 ** exponent, options.maxMs);
      // Never shorter than the base interval: backing off should not make the daemon busier.
      return Math.floor(random() * (ceiling - options.baseMs)) + options.baseMs;
    },
  };
}

/**
 * A shutdown signal that can be awaited and asked about.
 */
export interface Shutdown {
  readonly requested: boolean;
  /** Resolves when a signal arrives, or never if none does. */
  readonly promise: Promise<void>;
  /** Removes the handlers. Required in tests, or listeners accumulate across cases. */
  dispose(): void;
}

export function installShutdown(
  process_: NodeJS.EventEmitter & { exit(code: number): never },
  signals: readonly NodeJS.Signals[] = ['SIGTERM', 'SIGINT'],
): Shutdown {
  let requested = false;
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });

  const onSignal = (signal: NodeJS.Signals) => {
    if (requested) {
      console.error(JSON.stringify({ shutdown: 'forced', signal }));
      process_.exit(EXIT.ok);
    }
    requested = true;
    console.log(JSON.stringify({ shutdown: 'requested', signal, graceMs: SHUTDOWN_GRACE_MS }));
    resolve();
  };

  const handlers = signals.map((signal) => {
    const handler = () => onSignal(signal);
    process_.on(signal, handler);
    return { signal, handler };
  });

  return {
    get requested() {
      return requested;
    },
    promise,
    dispose() {
      for (const { signal, handler } of handlers) process_.off(signal, handler);
    },
  };
}

/**
 * Sleep, but wake early if shutdown is requested.
 *
 * A daemon on a one-hour tick that ignores SIGTERM until the timer fires takes up to an hour to
 * stop. Supervisors do not wait that long; they escalate to SIGKILL, and the graceful path never
 * runs at all.
 *
 * The early return below is a **fast path, not a guard**, and a mutation test removing it passes —
 * again correctly: `shutdown.promise` is already resolved by then, so the handler fires on the next
 * microtask and the sleep ends anyway. It avoids allocating a timer only to cancel it. The
 * behaviour that actually matters is the `.then`, and removing *that* fails.
 */
export async function sleepUnlessShutdown(ms: number, shutdown: Shutdown): Promise<void> {
  if (shutdown.requested) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    void shutdown.promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * Run `work`, but stop waiting after `graceMs`.
 *
 * Returns whether it finished. The work is **not** cancelled — nothing here can safely interrupt a
 * transaction that may already be in flight. The timeout bounds how long shutdown waits, not what
 * the tick is allowed to do, and the difference matters: cancelling mid-harvest is how you end up
 * not knowing whether you paid.
 */
export async function withDeadline<T>(
  work: Promise<T>,
  graceMs: number,
): Promise<{ finished: true; value: T } | { finished: false }> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<{ finished: false }>((resolve) => {
    timer = setTimeout(() => resolve({ finished: false }), graceMs);
  });
  try {
    return await Promise.race([work.then((value) => ({ finished: true as const, value })), expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
