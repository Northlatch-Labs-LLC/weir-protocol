// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The run journal, and the single-instance lock.
 *
 * # Two jobs, one connection, on purpose
 *
 * A daemon that signs mainnet transactions unattended needs two things this file provides, and
 * they belong together because both are only meaningful while the process is alive.
 *
 * **The journal** makes the daemon checkable. Without it, "is it running" is answered by looking at
 * a terminal and "did vault X harvest last epoch" cannot be answered at all after the logs rotate.
 *
 * **The lock** stops two copies running. `harvest` is permissionless, so a second instance is not a
 * correctness problem — the contract refuses a second rung in an epoch — but it is a *money*
 * problem: the loser pays gas for a transaction that changes nothing, every tick, forever. That is
 * exactly the failure a supervisor makes more likely, because restarting something that has not
 * actually died is what supervisors do.
 *
 * # Why Postgres and not a pid file
 *
 * A pid file survives the process that wrote it. A machine that loses power leaves a lock nobody
 * holds, and the next start either refuses forever or ignores the file and defeats the point.
 * A Postgres session advisory lock is released by the database when the connection drops — a
 * crashed daemon releases it, and a *hung* one does not. That is the correct behaviour for both.
 *
 * # The journal is not optional for a live run
 *
 * `run` requires it. A daemon spending real gas with no record of what it did is one you can only
 * trust, and this system is built so that nothing has to be trusted. `--dry-run` does not require
 * it, because a dry run spends nothing and records nothing worth auditing.
 */

import { Pool, type PoolClient } from 'pg';
import { classify, fail, ok, type Reading } from '@projectx-social/sdk';
import type { TickResult } from '../engine.js';

/**
 * The advisory lock key.
 *
 * A fixed 64-bit constant rather than a hash of the package id, because two deployments sharing one
 * database *should* contend — they would be harvesting the same vaults with different keys, and
 * both paying. Derived keys would let that happen silently.
 */
const LOCK_KEY = 0x70783a68617276n; // "px:harv"

export interface RunHandle {
  id: number;
}

export interface Journal {
  /** Records a tick starting. The row is left `running` until {@link finish} is called. */
  begin(input: { mode: 'live' | 'dry-run'; signer: string }): Promise<Reading<RunHandle>>;
  finish(run: RunHandle, result: TickResult & { discoveryTruncated: boolean }): Promise<Reading<true>>;
  abandon(run: RunHandle, failure: { kind: string; detail: string }): Promise<Reading<true>>;
  /**
   * Anchors the signer's audit chain head for a finished or abandoned run. One row per run; a second
   * anchor for the same run is refused by the primary key rather than overwritten, because an anchor
   * that can be replaced is not an anchor. See `db/002_audit_anchor.sql`.
   */
  anchorAudit(
    run: RunHandle,
    head: { signer: string; headHash: string; entries: number; intact: boolean },
  ): Promise<Reading<true>>;
  /** Runs left `running` by a process that died. The only way to see a crash after the fact. */
  stuckRuns(olderThanMs: number): Promise<Reading<Array<{ id: number; startedAtMs: number }>>>;
  recentRuns(limit: number): Promise<Reading<RunSummary[]>>;
  lastHarvestOf(vaultId: string): Promise<Reading<{ atMs: number; digest: string } | null>>;
  close(): Promise<void>;
}

export interface RunSummary {
  id: number;
  startedAtMs: number;
  endedAtMs: number | null;
  mode: string;
  epoch: bigint | null;
  vaultsSeen: number;
  harvested: number;
  skipped: number;
  failed: number;
  outcome: string;
  failureDetail: string | null;
  truncated: boolean;
  /** The anchored audit head, or `null` when the run wrote none (a daemon older than 002). */
  auditHead: { headHash: string; entries: number; intact: boolean } | null;
}

/**
 * Open the journal and take the single-instance lock.
 *
 * Fails rather than proceeding when the lock is held. Two daemons both harvesting is not a state to
 * warn about and continue from — the second one silently spends gas on transactions that do
 * nothing, and nothing anywhere goes red.
 */
export async function openJournal(databaseUrl: string): Promise<Reading<Journal>> {
  const source = 'daemon journal';
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  let lockConnection: PoolClient;
  try {
    lockConnection = await pool.connect();
  } catch (error) {
    await pool.end().catch(() => undefined);
    const failure = classify(error, source);
    return fail(failure.kind, source, `could not reach the journal database: ${failure.detail}`);
  }

  try {
    /*
      A *session* lock, not a transaction lock. It is held for as long as this connection lives and
      released by the server the moment it drops — so a crashed daemon frees it automatically and a
      hung one does not, which is what you want in both cases.
    */
    const { rows } = await lockConnection.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1::bigint) AS locked',
      [LOCK_KEY.toString()],
    );
    if (rows[0]?.locked !== true) {
      lockConnection.release();
      await pool.end().catch(() => undefined);
      return fail(
        'unconfigured',
        source,
        'another harvest daemon already holds the run lock on this database. ' +
          'Two instances would both pay gas for the same work — the second one for transactions ' +
          'that change nothing, because the contract refuses a second rung in an epoch.',
      );
    }
  } catch (error) {
    lockConnection.release();
    await pool.end().catch(() => undefined);
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }

  const guard = async <T>(what: string, run: () => Promise<T>): Promise<Reading<T>> => {
    try {
      return ok(await run());
    } catch (error) {
      const failure = classify(error, `${source}: ${what}`);
      return fail(failure.kind, failure.source, failure.detail);
    }
  };

  const journal: Journal = {
    begin: (input) =>
      guard('begin', async () => {
        const { rows } = await pool.query<{ id: string }>(
          `INSERT INTO daemon_runs (started_at_ms, mode, signer, outcome)
           VALUES ($1, $2, $3, 'running')
           RETURNING id`,
          [Date.now(), input.mode, input.signer],
        );
        return { id: Number(rows[0]!.id) };
      }),

    finish: (run, result) =>
      guard('finish', async () => {
        const connection = await pool.connect();
        try {
          await connection.query('BEGIN');
          await connection.query(
            `UPDATE daemon_runs
                SET ended_at_ms = $2, epoch = $3, vaults_seen = $4, harvested = $5,
                    skipped = $6, failed = $7, discovery_truncated = $8, tick_truncated = $9,
                    outcome = 'ok'
              WHERE id = $1`,
            [
              run.id,
              Date.now(),
              result.epoch.toString(),
              result.harvested.length + result.skipped.length + result.failed.length,
              result.harvested.length,
              result.skipped.length,
              result.failed.length,
              result.discoveryTruncated,
              result.truncated,
            ],
          );

          const at = Date.now();
          const write = async (
            outcome: 'harvested' | 'skipped' | 'failed',
            outcomes: TickResult['harvested'],
          ) => {
            for (const o of outcomes) {
              await connection.query(
                `INSERT INTO daemon_harvests (run_id, vault_id, epoch, outcome, reason, digest, error, at_ms)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                 ON CONFLICT (run_id, vault_id) DO NOTHING`,
                [
                  run.id,
                  o.vaultId,
                  result.epoch.toString(),
                  outcome,
                  o.decision.reason,
                  o.digest ?? null,
                  o.error ?? null,
                  at,
                ],
              );
            }
          };
          await write('harvested', result.harvested);
          await write('skipped', result.skipped);
          await write('failed', result.failed);
          await connection.query('COMMIT');
        } catch (error) {
          await connection.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          connection.release();
        }
        return true as const;
      }),

    abandon: (run, failure) =>
      guard('abandon', async () => {
        await pool.query(
          `UPDATE daemon_runs
              SET ended_at_ms = $2, outcome = 'failed', failure_kind = $3, failure_detail = $4
            WHERE id = $1`,
          [run.id, Date.now(), failure.kind, failure.detail],
        );
        return true as const;
      }),

    anchorAudit: (run, head) =>
      guard('anchorAudit', async () => {
        await pool.query(
          `INSERT INTO daemon_audit_anchors (run_id, signer, head_hash, entries, intact, recorded_at_ms)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [run.id, head.signer, head.headHash, head.entries, head.intact, Date.now()],
        );
        return true as const;
      }),
    stuckRuns: (olderThanMs) =>
      guard('stuckRuns', async () => {
        const { rows } = await pool.query<{ id: string; started_at_ms: string }>(
          `SELECT id, started_at_ms FROM daemon_runs
            WHERE outcome = 'running' AND started_at_ms < $1
            ORDER BY started_at_ms DESC LIMIT 50`,
          [Date.now() - olderThanMs],
        );
        return rows.map((r) => ({ id: Number(r.id), startedAtMs: Number(r.started_at_ms) }));
      }),

    recentRuns: (limit) =>
      guard('recentRuns', async () => {
        const { rows } = await pool.query<{
          id: string; started_at_ms: string; ended_at_ms: string | null; mode: string;
          epoch: string | null; vaults_seen: number; harvested: number; skipped: number;
          failed: number; outcome: string; failure_detail: string | null;
          discovery_truncated: boolean; tick_truncated: boolean;
          head_hash: string | null; entries: number | null; intact: boolean | null;
        }>(
          `SELECT r.*, a.head_hash, a.entries, a.intact
             FROM daemon_runs r LEFT JOIN daemon_audit_anchors a ON a.run_id = r.id
            ORDER BY r.started_at_ms DESC LIMIT $1`,
          [Math.min(limit, 200)],
        );
        return rows.map((r) => ({
          id: Number(r.id),
          startedAtMs: Number(r.started_at_ms),
          endedAtMs: r.ended_at_ms === null ? null : Number(r.ended_at_ms),
          mode: r.mode,
          epoch: r.epoch === null ? null : BigInt(r.epoch),
          vaultsSeen: r.vaults_seen,
          harvested: r.harvested,
          skipped: r.skipped,
          failed: r.failed,
          outcome: r.outcome,
          failureDetail: r.failure_detail,
          truncated: r.discovery_truncated || r.tick_truncated,
          auditHead:
            r.head_hash === null || r.entries === null || r.intact === null
              ? null
              : { headHash: r.head_hash, entries: r.entries, intact: r.intact },
        }));
      }),

    lastHarvestOf: (vaultId) =>
      guard('lastHarvestOf', async () => {
        const { rows } = await pool.query<{ at_ms: string; digest: string }>(
          `SELECT at_ms, digest FROM daemon_harvests
            WHERE vault_id = $1 AND outcome = 'harvested'
            ORDER BY at_ms DESC LIMIT 1`,
          [vaultId],
        );
        const row = rows[0];
        // `null` is "we looked and it has never harvested" — a real answer for a new vault, and
        // not the same as the query failing, which lands in the failure branch above.
        return row === undefined ? null : { atMs: Number(row.at_ms), digest: row.digest };
      }),

    close: async () => {
      // Releasing the connection returns it to the pool, which does NOT drop the session — so the
      // advisory lock would survive. Ending the pool closes it, and the server frees the lock.
      lockConnection.release();
      await pool.end().catch(() => undefined);
    },
  };

  return ok(journal);
}
