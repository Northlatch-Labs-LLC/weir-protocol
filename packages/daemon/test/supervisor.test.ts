// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The parts that decide whether the daemon survives a bad night.
 *
 * Each test here maps to a specific way an unattended process burns money or goes quiet: a backoff
 * that overflows into a delay measured in millennia, several daemons retrying in lockstep, a
 * SIGTERM ignored until a one-hour timer fires and the supervisor escalates to SIGKILL, or a
 * shutdown that cancels a transaction already in flight.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  createBackoff,
  EXIT,
  installShutdown,
  sleepUnlessShutdown,
  withDeadline,
} from '../src/supervisor.js';

describe('exit codes', () => {
  it('are distinct, because a supervisor branches on them', () => {
    // `misconfigured` and `alreadyRunning` must never be retried; `runFailed` should be. Collapsing
    // any two produces either a restart loop or a daemon that silently stays down.
    const codes = Object.values(EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('reserves 0 for success only', () => {
    expect(EXIT.ok).toBe(0);
    for (const [name, code] of Object.entries(EXIT)) {
      if (name !== 'ok') expect(code).not.toBe(0);
    }
  });
});

describe('createBackoff', () => {
  const base = 1_000;
  const max = 60_000;

  it('waits exactly the base interval while nothing is failing', () => {
    const b = createBackoff({ baseMs: base, maxMs: max, random: () => 0.5 });
    expect(b.delayMs()).toBe(base);
    expect(b.failures()).toBe(0);
  });

  it('grows with consecutive failures', () => {
    const b = createBackoff({ baseMs: base, maxMs: max, random: () => 1 });
    const seen: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      b.fail();
      seen.push(b.delayMs());
    }
    // Strictly increasing until the cap. `random: () => 1` takes the top of each window, so this
    // measures the window growing rather than the draw.
    for (let i = 1; i < seen.length; i += 1) expect(seen[i]!).toBeGreaterThan(seen[i - 1]!);
  });

  it('never exceeds the cap, even after an absurd number of failures', () => {
    /*
      The overflow this prevents is real: `baseMs * 2 ** 60` is a delay of millennia, which is
      indistinguishable from the daemon having stopped — and it would arrive precisely during the
      long outage where you most need it to keep trying.
    */
    const b = createBackoff({ baseMs: base, maxMs: max, random: () => 1 });
    for (let i = 0; i < 500; i += 1) b.fail();
    expect(b.delayMs()).toBeLessThanOrEqual(max);
    expect(Number.isFinite(b.delayMs())).toBe(true);
  });

  it('never returns less than the base interval', () => {
    // Backing off must not make the daemon busier. `random: () => 0` takes the bottom of the window.
    const b = createBackoff({ baseMs: base, maxMs: max, random: () => 0 });
    for (let i = 0; i < 10; i += 1) {
      b.fail();
      expect(b.delayMs()).toBeGreaterThanOrEqual(base);
    }
  });

  it('spreads retries instead of synchronising them', () => {
    /*
      Two daemons that failed together must not retry together. Without jitter both would compute
      the identical delay forever, turning a brief outage into a synchronised spike at every
      interval. Full jitter draws across the whole window, so the two diverge on the first retry.
    */
    const draws = [0.01, 0.99];
    const delays = draws.map((d) => {
      const b = createBackoff({ baseMs: base, maxMs: max, random: () => d });
      b.fail();
      b.fail();
      b.fail();
      return b.delayMs();
    });
    expect(delays[0]).not.toBe(delays[1]);
    expect(delays[1]! - delays[0]!).toBeGreaterThan(base);
  });

  it('returns to the base interval after a success', () => {
    // A daemon that recovers must not keep waiting as though it were still broken.
    const b = createBackoff({ baseMs: base, maxMs: max, random: () => 1 });
    for (let i = 0; i < 8; i += 1) b.fail();
    expect(b.delayMs()).toBeGreaterThan(base);
    b.succeed();
    expect(b.failures()).toBe(0);
    expect(b.delayMs()).toBe(base);
  });
});

/** A stand-in for `process` that records `exit` instead of ending the test run. */
function fakeProcess() {
  const emitter = new EventEmitter() as EventEmitter & { exit(code: number): never; exited: number[] };
  emitter.exited = [];
  emitter.exit = ((code: number) => {
    emitter.exited.push(code);
    return undefined as never;
  }) as never;
  return emitter;
}

describe('installShutdown', () => {
  it('records the request and resolves for anyone waiting', async () => {
    const p = fakeProcess();
    const shutdown = installShutdown(p, ['SIGTERM']);
    expect(shutdown.requested).toBe(false);

    p.emit('SIGTERM');
    await shutdown.promise;
    expect(shutdown.requested).toBe(true);
    expect(p.exited).toEqual([]);
    shutdown.dispose();
  });

  it('exits immediately on a second signal', () => {
    // Waiting politely through a second SIGTERM is how a process becomes the one you have to
    // `kill -9`, and a SIGKILL mid-harvest is exactly the case the graceful path exists to avoid.
    const p = fakeProcess();
    const shutdown = installShutdown(p, ['SIGTERM']);
    p.emit('SIGTERM');
    p.emit('SIGTERM');
    expect(p.exited).toEqual([EXIT.ok]);
    shutdown.dispose();
  });

  it('removes its handlers on dispose', () => {
    // Without this, every test — and every reload in a long-lived process — leaks a listener, and
    // Node eventually warns about it in production logs for no reason anyone can trace.
    const p = fakeProcess();
    const shutdown = installShutdown(p, ['SIGTERM', 'SIGINT']);
    expect(p.listenerCount('SIGTERM')).toBe(1);
    shutdown.dispose();
    expect(p.listenerCount('SIGTERM')).toBe(0);
    expect(p.listenerCount('SIGINT')).toBe(0);
  });
});

describe('sleepUnlessShutdown', () => {
  it('returns at once when shutdown was already requested', async () => {
    const p = fakeProcess();
    const shutdown = installShutdown(p, ['SIGTERM']);
    p.emit('SIGTERM');

    const started = Date.now();
    await sleepUnlessShutdown(60_000, shutdown);
    expect(Date.now() - started).toBeLessThan(200);
    shutdown.dispose();
  });

  it('wakes early when the signal arrives mid-sleep', async () => {
    /*
      The case that matters operationally. A daemon on a one-hour tick that sleeps through SIGTERM
      takes up to an hour to stop; supervisors do not wait that long, so the graceful path never
      runs and every shutdown becomes a kill.
    */
    const p = fakeProcess();
    const shutdown = installShutdown(p, ['SIGTERM']);
    const started = Date.now();
    const sleeping = sleepUnlessShutdown(60_000, shutdown);
    setTimeout(() => p.emit('SIGTERM'), 20);
    await sleeping;
    expect(Date.now() - started).toBeLessThan(1_000);
    shutdown.dispose();
  });

  it('sleeps the full time when no signal arrives', async () => {
    const p = fakeProcess();
    const shutdown = installShutdown(p, ['SIGTERM']);
    const started = Date.now();
    await sleepUnlessShutdown(60, shutdown);
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    shutdown.dispose();
  });
});

describe('withDeadline', () => {
  it('reports the value when the work finishes in time', async () => {
    const result = await withDeadline(Promise.resolve('done'), 1_000);
    expect(result).toEqual({ finished: true, value: 'done' });
  });

  it('reports unfinished when the deadline wins', async () => {
    const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 5_000));
    const result = await withDeadline(slow, 30);
    expect(result.finished).toBe(false);
  });

  it('does not cancel the work it stopped waiting for', async () => {
    /*
      The single most important property in this file. Nothing here can safely interrupt a
      transaction that may already be in flight — the deadline bounds how long SHUTDOWN waits, not
      what the tick is allowed to finish. Cancelling mid-harvest is how you end up not knowing
      whether you paid.
    */
    const finished = vi.fn();
    const slow = new Promise<void>((resolve) =>
      setTimeout(() => {
        finished();
        resolve();
      }, 60),
    );
    const result = await withDeadline(slow, 20);
    expect(result.finished).toBe(false);
    expect(finished).not.toHaveBeenCalled();

    await slow;
    expect(finished).toHaveBeenCalledOnce();
  });

  it('clears its timer so a fast tick does not hold the event loop open', async () => {
    // A leaked 30-second timer per tick keeps `--once` alive long after its work is done, and a
    // supervisor that waits for the process to exit sees a hang.
    const before = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    await withDeadline(Promise.resolve(1), 30_000);
    const after = process.getActiveResourcesInfo?.().filter((r) => r === 'Timeout').length ?? 0;
    expect(after).toBeLessThanOrEqual(before);
  });
});
