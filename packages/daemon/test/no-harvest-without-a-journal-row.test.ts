// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * A tick that cannot open a journal row does not harvest.
 *
 * # The defect this pins
 *
 * `index.ts:204` states the invariant in its own words — the journal is opened "before the first
 * tick so nothing is ever harvested unrecorded" — and live mode exits `misconfigured` if it cannot
 * be opened at all. That was enforced ONCE, at startup, and never again.
 *
 * Per tick, `journal.begin()` failing logged its detail, set `run` to `null`, and fell through to
 * `runOnce`, which discovers vaults, harvests and SIGNS. Both `journal.finish` and
 * `journal.abandon` below it are guarded on `run !== null`, so the work completed and left no
 * record of having happened.
 *
 * Unrecorded is the one outcome this daemon may not produce. A tick that does not run is visible in
 * the next tick and costs a cycle; a tick that ran without a row is invisible and costs a
 * reconciliation nobody knows to perform.
 *
 * # Why discovery is the seam
 *
 * `runOnce` calls `discoverVaults` before it calls `tick`, so discovery not being called is proof
 * the harvest never began — earlier and stronger evidence than asserting on the signer, which the
 * old code would only have reached later.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const begin = vi.fn();
const abandon = vi.fn();
const finish = vi.fn();
const anchorAudit = vi.fn();
const discoverVaults = vi.fn();
const tick = vi.fn();

vi.mock('../src/adapters/discovery.js', () => ({
  discoverVaults: (...a: unknown[]) => discoverVaults(...a),
}));
vi.mock('../src/engine.js', () => ({ tick: (...a: unknown[]) => tick(...a) }));

vi.mock('../src/adapters/journal.js', () => ({
  openJournal: async () => ({
    ok: true,
    value: {
      begin: (...a: unknown[]) => begin(...a),
      finish: (...a: unknown[]) => finish(...a),
      abandon: (...a: unknown[]) => abandon(...a),
      anchorAudit: (...a: unknown[]) => anchorAudit(...a),
      // Reported at startup, before the loop. Empty because stuck runs are not what this file is
      // about, and a non-empty list would put noise in front of the assertions that are.
      stuckRuns: async () => ({ ok: true, value: [] }),
      close: async () => undefined,
    },
  }),
}));

vi.mock('@mysten/sui/grpc', () => ({
  // Funded, so the signer preflight passes and the loop is actually reached. A balance of zero
  // would exit `misconfigured` before the first tick and every assertion below would be vacuous.
  SuiGrpcClient: class {
    async getBalance() {
      return { balance: { balance: '1000000000000' } };
    }
  },
}));

const SIGNER = `0x${'ab'.repeat(32)}`;

vi.mock('../src/adapters/signer.js', () => ({
  createSigner: () => ({ ok: true, value: { address: SIGNER, auditHead: () => ({ headHash: '0'.repeat(64), entries: 0, intact: true }) } }),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    loadDaemonConfig: () => ({
      ok: true,
      value: {
        grpcUrl: 'https://example.invalid',
        packageId: `0x${'11'.repeat(32)}`,
        maxDiscoveryPages: 1,
        gasBudgetMist: 1000n,
        latestPackageId: `0x${'11'.repeat(32)}`,
        journalUrl: 'postgres://x/y',
        intervalMs: 1,
        tickIntervalSeconds: 1,
      },
    }),
    assertJournalConfigured: () => ({ ok: true, value: 'postgres://x/y' }),
    assertSignerConfigured: () => ({ ok: true, value: 'secret' }),
    // Synchronous, as the real one is. An async stub here returns a Promise, whose `.ok` is
    // undefined, which main reads as 'not funded' — a mock manufacturing the failure it was
    // written to rule out.
    assertSignerFunded: () => ({ ok: true, value: true }),
  };
});

const { main } = await import('../src/index.js');

beforeEach(() => {
  // Defaults for the records this file is not about, so a test that forgets one fails on its own
  // subject rather than on an unstubbed fold. Each case overrides what it is actually asserting.
  finish.mockResolvedValue({ ok: true, value: undefined });
  abandon.mockResolvedValue({ ok: true, value: true });
  anchorAudit.mockResolvedValue({ ok: true, value: true });
});

afterEach(() => vi.clearAllMocks());

describe('when the journal will not open a run', () => {
  it('does not harvest', async () => {
    begin.mockResolvedValue({ ok: false, failure: { kind: 'transport', detail: 'db is down' } });

    await main(['--once'], {} as NodeJS.ProcessEnv);

    // The whole finding in one assertion. Before the fix this was called, the vaults were
    // discovered, and the tick harvested and signed with nothing recording that it had.
    expect(begin).toHaveBeenCalled();
    expect(discoverVaults).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it('exits non-zero, so a supervisor is not told the run succeeded', async () => {
    begin.mockResolvedValue({ ok: false, failure: { kind: 'transport', detail: 'db is down' } });

    const code = await main(['--once'], {} as NodeJS.ProcessEnv);

    // A skipped tick that exits 0 reports "nothing to do" to whatever is watching, which is the
    // same signal as a healthy idle cycle and the opposite of the truth.
    expect(code).not.toBe(0);
  });
});

describe('when the journal opens a run', () => {
  it('harvests, which is what proves the guard is not simply refusing everything', async () => {
    begin.mockResolvedValue({ ok: true, value: { id: 'run-1' } });
    discoverVaults.mockResolvedValue({ ok: true, value: { vaults: [], truncated: false } });
    tick.mockResolvedValue({
      ok: true,
      value: { epoch: 1n, harvested: [], skipped: [], failed: [], truncated: false },
      observedAtMs: 1,
    });

    await main(['--once'], {} as NodeJS.ProcessEnv);

    expect(discoverVaults).toHaveBeenCalledTimes(1);
    // The run's audit head is anchored after the run is recorded, and only then: a chain with
    // no decisions ends at genesis, and that is what an idle tick writes.
    expect(anchorAudit).toHaveBeenCalledTimes(1);
    expect(anchorAudit).toHaveBeenCalledWith(
      { id: 'run-1' },
      expect.objectContaining({ signer: SIGNER, headHash: '0'.repeat(64), entries: 0, intact: true }),
    );
    expect(anchorAudit.mock.invocationCallOrder[0]!).toBeGreaterThan(finish.mock.invocationCallOrder[0]!);
  });
});

describe('when the journal will not record that a run was abandoned', () => {
  /*
    `abandon` returns a Reading and its result was discarded, while `finish` beside it was folded
    and logged. So an abandon that FAILED left the run row `running` — and `stuckRuns` describes
    exactly that row as "runs left `running` by a process that died. The only way to see a crash
    after the fact."

    The process did not die. The tick failed and the write recording that failure was the thing
    that did not land, so the daemon manufactured a crash report about itself — corrupting the one
    signal that exists to reveal a real crash.
  */
  it('says so, rather than leaving a row that reads as a crash', async () => {
    begin.mockResolvedValue({ ok: true, value: { id: 'run-1' } });
    discoverVaults.mockResolvedValue({
      ok: false,
      failure: { kind: 'transport', detail: 'node unreachable' },
    });
    abandon.mockResolvedValue({
      ok: false,
      failure: { kind: 'transport', detail: 'journal write failed' },
    });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });

    await main(['--once'], {} as NodeJS.ProcessEnv);
    spy.mockRestore();

    expect(abandon).toHaveBeenCalledTimes(1);
    expect(errors.some((l) => l.includes('journalAbandon'))).toBe(true);
  });

  it('is silent about the abandon when it succeeds', async () => {
    // The converse. A line printed every time would train whoever reads these to skip it, which
    // is the same as not printing it on the run that mattered.
    begin.mockResolvedValue({ ok: true, value: { id: 'run-1' } });
    discoverVaults.mockResolvedValue({
      ok: false,
      failure: { kind: 'transport', detail: 'node unreachable' },
    });
    abandon.mockResolvedValue({ ok: true, value: true });
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      errors.push(String(line));
    });

    await main(['--once'], {} as NodeJS.ProcessEnv);
    spy.mockRestore();

    expect(abandon).toHaveBeenCalledTimes(1);
    expect(errors.some((l) => l.includes('journalAbandon'))).toBe(false);
  });
});
