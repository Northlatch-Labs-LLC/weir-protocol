// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The run journal and the single-instance lock, against a real Postgres.
 *
 * Mocking is not an option here. The property that matters — a session advisory lock the *server*
 * releases when the connection drops — is a database behaviour, not application logic. A fake that
 * returned `true` would satisfy every assertion in this file and let two daemons harvest the same
 * vaults, each paying gas, one of them for transactions that change nothing.
 *
 * The constraint tests matter for the same reason: they assert that the schema refuses a harvest
 * that names no transaction. That rule lives in Postgres precisely so a future code path cannot
 * forget it, and a test that only exercised the code path would not notice if it were dropped.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { openJournal, type Journal } from '../src/adapters/journal.js';
import type { TickResult, VaultOutcome } from '../src/engine.js';

const URL = process.env['PROJECTX_DAEMON_TEST_DATABASE_URL'];
if (URL === undefined || URL === '') {
  throw new Error(
    'PROJECTX_DAEMON_TEST_DATABASE_URL is not set. These tests need a real Postgres — see ' +
      'vitest.db.config.ts. There is deliberately no default: a default would eventually point ' +
      'at a database somebody cared about.',
  );
}
const url: string = URL;

const SIGNER = '0x9bb9b2d039074223f7ea6a68ea3ffc7cf6efc0b0f76a07cc3ef3918f8220ff84';
const VAULT = '0xee64d87381e0056ec944af98a7a8a77a0de25652f4bee5e174df4b8b4f10bb11';

function tickResult(over: Partial<TickResult & { discoveryTruncated: boolean }> = {}) {
  return {
    epoch: 1221n,
    harvested: [],
    skipped: [],
    failed: [],
    truncated: false,
    discoveryTruncated: false,
    ...over,
  } as TickResult & { discoveryTruncated: boolean };
}

const harvested = (vaultId: string, digest: string): VaultOutcome => ({
  vaultId,
  decision: { act: true, reason: 'matured-tranche' },
  digest,
});

const skipped = (vaultId: string): VaultOutcome => ({
  vaultId,
  decision: { act: false, reason: 'already-staked-this-epoch' },
});

const failed = (vaultId: string, error: string): VaultOutcome => ({
  vaultId,
  decision: { act: true, reason: 'idle-principal' },
  error,
});

let pool: Pool;
let open: Journal[] = [];

async function take(): Promise<Journal> {
  const reading = await openJournal(url);
  if (!reading.ok) throw new Error(reading.failure.detail);
  open.push(reading.value);
  return reading.value;
}

beforeEach(async () => {
  pool = new Pool({ connectionString: url, max: 2 });
  await pool.query('TRUNCATE daemon_audit_anchors, daemon_harvests, daemon_runs RESTART IDENTITY CASCADE');
});

afterEach(async () => {
  for (const journal of open) await journal.close();
  open = [];
  await pool.end();
});

describe('the single-instance lock', () => {
  it('refuses a second daemon while the first holds it', async () => {
    /*
      The money test. `harvest` is permissionless, so a second instance is not a correctness
      problem — the contract refuses a second rung in an epoch. It is a *cost* problem: the loser
      pays gas for a transaction that changes nothing, every tick, forever. And a supervisor makes
      this more likely, because restarting something that has not actually died is what supervisors
      do.
    */
    await take();
    const second = await openJournal(url);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.detail).toContain('already holds the run lock');
  });

  it('leaves no connection behind when it refuses', async () => {
    /*
      Found by mutation testing: removing the `pool.end()` on the refusal path passed every other
      test in this file. It is not cosmetic. An open pool is an open handle, so `--once` would
      compute exit code 2, reach the end of `main`, and then simply never exit — and a supervisor
      waiting for the process to finish sees a hang rather than the "I am redundant" signal the
      exit code was carefully chosen to give it.
    */
    await take();

    const backends = async () =>
      Number(
        (
          await pool.query<{ count: string }>(
            'SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()',
          )
        ).rows[0]!.count,
      );

    const before = await backends();
    for (let i = 0; i < 3; i += 1) {
      const refused = await openJournal(url);
      expect(refused.ok).toBe(false);
    }
    // Postgres closes a backend asynchronously after the client disconnects.
    await new Promise((r) => setTimeout(r, 500));
    expect(await backends()).toBeLessThanOrEqual(before);
  });

  it('releases it on close, so a restart is not locked out by its own predecessor', async () => {
    const first = await take();
    await first.close();
    open = open.filter((j) => j !== first);

    const second = await openJournal(url);
    expect(second.ok).toBe(true);
    if (second.ok) open.push(second.value);
  });

  it('explains the cost, not just the condition', async () => {
    await take();
    const second = await openJournal(url);
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.failure.detail).toMatch(/gas/);
    expect(second.failure.detail).toMatch(/change nothing|changes nothing/);
  });
});

describe('recording a run', () => {
  it('leaves the row running until it finishes', async () => {
    /*
      The gap between the two writes is the useful part. A crash, an OOM kill or a power cut leaves
      a `running` row, and that is the only evidence afterwards that the daemon died mid-tick.
      Without it, "crashed" and "never started" look identical, and they need different responses.
    */
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    expect(run.ok).toBe(true);
    if (!run.ok) return;

    const { rows } = await pool.query<{ outcome: string; ended_at_ms: string | null }>(
      'SELECT outcome, ended_at_ms FROM daemon_runs WHERE id = $1',
      [run.value.id],
    );
    expect(rows[0]?.outcome).toBe('running');
    expect(rows[0]?.ended_at_ms).toBeNull();
  });

  it('records counts and every per-vault outcome on finish', async () => {
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) return;

    const finished = await journal.finish(
      run.value,
      tickResult({
        harvested: [harvested(VAULT, 'DIGEST1')],
        skipped: [skipped('0xaaa')],
        failed: [failed('0xbbb', 'transport')],
      }),
    );
    expect(finished.ok).toBe(true);

    const run_ = await pool.query<{ outcome: string; harvested: number; skipped: number; failed: number; vaults_seen: number; epoch: string }>(
      'SELECT * FROM daemon_runs WHERE id = $1',
      [run.value.id],
    );
    expect(run_.rows[0]).toMatchObject({ outcome: 'ok', harvested: 1, skipped: 1, failed: 1, vaults_seen: 3 });
    expect(run_.rows[0]?.epoch).toBe('1221');

    const per = await pool.query<{ vault_id: string; outcome: string; digest: string | null }>(
      'SELECT vault_id, outcome, digest FROM daemon_harvests WHERE run_id = $1 ORDER BY vault_id',
      [run.value.id],
    );
    expect(per.rows).toHaveLength(3);
    expect(per.rows.find((r) => r.vault_id === VAULT)).toMatchObject({
      outcome: 'harvested',
      digest: 'DIGEST1',
    });
  });

  it('keeps skipped and failed apart', async () => {
    // A vault that could not be read is NOT a vault with nothing to do. Merging them is how a
    // permanently broken vault hides inside a healthy-looking skip count.
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) return;
    await journal.finish(
      run.value,
      tickResult({
        skipped: [skipped('0xaaa')],
        failed: [failed('0xbbb', 'timeout')],
      }),
    );
    const { rows } = await pool.query<{ outcome: string; error: string | null }>(
      'SELECT outcome, error FROM daemon_harvests WHERE run_id = $1 ORDER BY vault_id',
      [run.value.id],
    );
    expect(rows.map((r) => r.outcome)).toEqual(['skipped', 'failed']);
    expect(rows[1]?.error).toBe('timeout');
  });

  it('records both truncation flags', async () => {
    // A partial list treated as complete is how the newest vaults stop being harvested with
    // nothing going red.
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) return;
    await journal.finish(run.value, tickResult({ truncated: true, discoveryTruncated: true }));
    const { rows } = await pool.query<{ discovery_truncated: boolean; tick_truncated: boolean }>(
      'SELECT discovery_truncated, tick_truncated FROM daemon_runs WHERE id = $1',
      [run.value.id],
    );
    expect(rows[0]).toEqual({ discovery_truncated: true, tick_truncated: true });
  });

  it('marks an abandoned run failed, with the reason', async () => {
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) return;
    await journal.abandon(run.value, { kind: 'transport', detail: 'node unreachable' });
    const { rows } = await pool.query<{ outcome: string; failure_kind: string; failure_detail: string }>(
      'SELECT outcome, failure_kind, failure_detail FROM daemon_runs WHERE id = $1',
      [run.value.id],
    );
    expect(rows[0]).toMatchObject({
      outcome: 'failed',
      failure_kind: 'transport',
      failure_detail: 'node unreachable',
    });
  });
});

describe('the schema refuses states the code must never write', () => {
  it('rejects a harvest that names no transaction', async () => {
    // "It harvested" with no digest is a claim nobody can check. The rule lives in Postgres so a
    // future code path cannot forget it.
    await expect(
      pool.query(
        `INSERT INTO daemon_runs (started_at_ms, mode, signer, outcome, ended_at_ms)
         VALUES (1, 'live', $1, 'ok', 2) RETURNING id`,
        [SIGNER],
      ).then((r) =>
        pool.query(
          `INSERT INTO daemon_harvests (run_id, vault_id, epoch, outcome, reason, at_ms)
           VALUES ($1, $2, 1, 'harvested', 'x', 1)`,
          [r.rows[0].id, VAULT],
        ),
      ),
    ).rejects.toThrow(/harvests_name_their_transaction/);
  });

  it('rejects a failure that says nothing about why', async () => {
    const run = await pool.query(
      `INSERT INTO daemon_runs (started_at_ms, mode, signer, outcome, ended_at_ms)
       VALUES (1, 'live', $1, 'ok', 2) RETURNING id`,
      [SIGNER],
    );
    await expect(
      pool.query(
        `INSERT INTO daemon_harvests (run_id, vault_id, epoch, outcome, reason, at_ms)
         VALUES ($1, $2, 1, 'failed', 'x', 1)`,
        [run.rows[0].id, VAULT],
      ),
    ).rejects.toThrow(/failures_say_why/);
  });

  it('rejects a finished run with no end time', async () => {
    await expect(
      pool.query(
        `INSERT INTO daemon_runs (started_at_ms, mode, signer, outcome)
         VALUES (1, 'live', $1, 'ok')`,
        [SIGNER],
      ),
    ).rejects.toThrow(/finished_runs_are_complete/);
  });

  it('rejects an unknown mode', async () => {
    await expect(
      pool.query(
        `INSERT INTO daemon_runs (started_at_ms, mode, signer, outcome)
         VALUES (1, 'whatever', $1, 'running')`,
        [SIGNER],
      ),
    ).rejects.toThrow();
  });
});

describe('reading the journal', () => {
  it('finds a run left running by a dead process', async () => {
    const journal = await take();
    await pool.query(
      `INSERT INTO daemon_runs (started_at_ms, mode, signer, outcome)
       VALUES ($1, 'live', $2, 'running')`,
      [Date.now() - 60_000, SIGNER],
    );
    const stuck = await journal.stuckRuns(10_000);
    expect(stuck.ok).toBe(true);
    if (!stuck.ok) return;
    expect(stuck.value).toHaveLength(1);
  });

  it('does not call a run in progress stuck', async () => {
    const journal = await take();
    await journal.begin({ mode: 'live', signer: SIGNER });
    const stuck = await journal.stuckRuns(10_000);
    expect(stuck.ok && stuck.value).toHaveLength(0);
  });

  it('reports a vault that has never harvested as a measured absence', async () => {
    // `null` inside an ok is a real answer for a new vault — not the same as the query failing,
    // which lands in the failure branch and must not be rendered as "never harvested".
    const journal = await take();
    const last = await journal.lastHarvestOf(VAULT);
    expect(last.ok).toBe(true);
    expect(last.ok && last.value).toBeNull();
  });

  it('returns the most recent harvest for a vault', async () => {
    const journal = await take();
    for (const [digest, at] of [['OLD', 1_000], ['NEW', 2_000]] as const) {
      const run = await journal.begin({ mode: 'live', signer: SIGNER });
      if (!run.ok) return;
      await journal.finish(run.value, tickResult({ harvested: [harvested(VAULT, digest)] }));
      await pool.query('UPDATE daemon_harvests SET at_ms = $1 WHERE run_id = $2', [at, run.value.id]);
    }
    const last = await journal.lastHarvestOf(VAULT);
    expect(last.ok && last.value?.digest).toBe('NEW');
  });

  it('reports an empty journal as empty rather than failing', async () => {
    const journal = await take();
    const runs = await journal.recentRuns(10);
    expect(runs.ok).toBe(true);
    expect(runs.ok && runs.value).toEqual([]);
  });
});

describe('anchoring the audit chain', () => {
  /*
    The chain is tamper-evident on its own only against partial edits; this row is the memory
    outside the process that makes a rewritten chain detectable. See db/002_audit_anchor.sql.
  */
  const HEAD = 'a'.repeat(64);
  const GENESIS = '0'.repeat(64);

  it('writes one row per run, readable back through recentRuns', async () => {
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) throw new Error(run.failure.detail);
    await journal.finish(run.value, tickResult({ harvested: [harvested(VAULT, 'digest-1')] }));
    const anchored = await journal.anchorAudit(run.value, { signer: SIGNER, headHash: HEAD, entries: 1, intact: true });
    expect(anchored.ok, JSON.stringify(anchored)).toBe(true);

    const recent = await journal.recentRuns(5);
    if (!recent.ok) throw new Error(recent.failure.detail);
    expect(recent.value[0]!.auditHead).toEqual({ headHash: HEAD, entries: 1, intact: true });
  });

  it('a run without an anchor reads as null, never as an empty chain', async () => {
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) throw new Error(run.failure.detail);
    await journal.finish(run.value, tickResult());
    const recent = await journal.recentRuns(5);
    if (!recent.ok) throw new Error(recent.failure.detail);
    expect(recent.value[0]!.auditHead).toBeNull();
  });

  it('refuses a second anchor for the same run rather than overwriting the first', async () => {
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) throw new Error(run.failure.detail);
    await journal.finish(run.value, tickResult());
    expect((await journal.anchorAudit(run.value, { signer: SIGNER, headHash: GENESIS, entries: 0, intact: true })).ok).toBe(true);
    const again = await journal.anchorAudit(run.value, { signer: SIGNER, headHash: HEAD, entries: 1, intact: true });
    expect(again.ok).toBe(false);
    const recent = await journal.recentRuns(5);
    if (!recent.ok) throw new Error(recent.failure.detail);
    expect(recent.value[0]!.auditHead?.headHash).toBe(GENESIS);
  });

  it('refuses a head that is not a head: wrong shape, or a non-empty chain ending at genesis', async () => {
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) throw new Error(run.failure.detail);
    await journal.finish(run.value, tickResult());
    expect((await journal.anchorAudit(run.value, { signer: SIGNER, headHash: 'not-a-hash', entries: 1, intact: true })).ok).toBe(false);
    expect((await journal.anchorAudit(run.value, { signer: SIGNER, headHash: GENESIS, entries: 3, intact: true })).ok).toBe(false);
    expect((await journal.anchorAudit(run.value, { signer: SIGNER, headHash: HEAD, entries: 0, intact: true })).ok).toBe(false);
  });

  it('an abandoned run can be anchored too — the refusals it recorded are still evidence', async () => {
    const journal = await take();
    const run = await journal.begin({ mode: 'live', signer: SIGNER });
    if (!run.ok) throw new Error(run.failure.detail);
    await journal.abandon(run.value, { kind: 'transport', detail: 'the node went away' });
    expect((await journal.anchorAudit(run.value, { signer: SIGNER, headHash: HEAD, entries: 2, intact: true })).ok).toBe(true);
  });
});
