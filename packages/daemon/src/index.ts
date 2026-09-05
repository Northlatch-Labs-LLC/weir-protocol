// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The daemon entrypoint: discover vaults, tick, sleep, repeat.
 *
 * # Two modes, and the safe one is the default posture
 *
 * `--once` runs a single tick and exits — useful from cron, and the mode to reach for first.
 * `--dry-run` discovers and decides but **never signs**, so the whole path can be exercised
 * against mainnet with no key and no gas. A daemon you cannot run harmlessly is one nobody
 * verifies before pointing it at real money.
 *
 * # What a tick does not do
 *
 * It does not retry. A failed harvest is reported and left for the next tick, which will re-read
 * state and decide again from scratch. Retrying inside a tick would mean acting on a snapshot
 * already known to be stale, and `harvest` is permissionless — the thing that "failed" may have
 * been someone else succeeding first.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { fold } from '@projectx-social/sdk';
import {
  assertJournalConfigured,
  assertSignerConfigured,
  assertSignerFunded,
  loadDaemonConfig,
  redactedConfig,
  type DaemonConfig,
} from './config.js';
import { openJournal, type Journal, type RunHandle } from './adapters/journal.js';
import {
  createBackoff,
  EXIT,
  installShutdown,
  SHUTDOWN_GRACE_MS,
  sleepUnlessShutdown,
  withDeadline,
} from './supervisor.js';
import { discoverVaults } from './adapters/discovery.js';
import { readCurrentEpoch, readStakeVault } from './adapters/vault.js';
import { createSigner, EMPTY_AUDIT_HEAD, type HarvestSigner } from './adapters/signer.js';
import { tick, type EnginePorts, type TickResult } from './engine.js';
import { classify, fail, ok, type Reading } from '@projectx-social/sdk';

export interface RunOptions {
  once: boolean;
  dryRun: boolean;
}

/** The signer's SUI balance, for the startup preflight. */
async function readSignerBalance(
  client: SuiGrpcClient,
  address: string,
): Promise<Reading<bigint>> {
  const source = `SUI balance of ${address}`;
  try {
    const response = await client.getBalance({ owner: address });
    const value = (response as { balance?: { balance?: unknown } }).balance?.balance;
    return ok(BigInt(String(value ?? '0')));
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

export function parseArgs(argv: readonly string[]): RunOptions {
  return { once: argv.includes('--once'), dryRun: argv.includes('--dry-run') };
}

/**
 * A signer that decides but never signs. Used by `--dry-run`.
 *
 * Returns a failure rather than a fake digest, so a dry run can never be mistaken for a real one
 * in a log — the outcome lands in `failed` with an explicit reason, not in `harvested`.
 */
export function dryRunSigner(): HarvestSigner {
  return {
    address: '(dry-run: no signer)',
    async simulateAndHarvest(vaultId: string) {
      return fail('unconfigured', `harvest ${vaultId}`, 'dry run: would harvest, did not sign');
    },
    auditHead: () => EMPTY_AUDIT_HEAD,
  };
}

export function buildPorts(client: SuiGrpcClient, signer: HarvestSigner): EnginePorts {
  return {
    readEpoch: () => readCurrentEpoch(client),
    readVault: (vaultId) => readStakeVault(client, vaultId),
    simulateAndHarvest: (vaultId) => signer.simulateAndHarvest(vaultId),
  };
}

/** Discover, then tick once. Exposed so a test or a cron wrapper can drive a single pass. */
/**
 * Anchor the audit chain head for a run that has just been finished or abandoned.
 *
 * After the journal write, never before: the anchor names the chain as it stood when the run's
 * outcome was recorded, and a failed anchor is reported the same way a failed finish is — loudly,
 * without undoing work that already happened on chain.
 */
async function anchor(journal: Journal, run: RunHandle, signer: HarvestSigner): Promise<void> {
  const head = signer.auditHead();
  fold(
    await journal.anchorAudit(run, { signer: signer.address, ...head }),
    () => null,
    (failure) => {
      console.error(JSON.stringify({ journalAnchor: failure.detail, headHash: head.headHash, entries: head.entries }));
      return null;
    },
  );
}

export async function runOnce(
  client: SuiGrpcClient,
  config: DaemonConfig,
  signer: HarvestSigner,
): Promise<Reading<TickResult & { discoveryTruncated: boolean }>> {
  const discovery = await discoverVaults(client, config.packageId, config.maxDiscoveryPages);
  if (!discovery.ok) return discovery;

  const result = await tick(
    buildPorts(client, signer),
    discovery.value.vaults.map((v) => v.vaultId),
  );
  if (!result.ok) return result;

  return ok(
    { ...result.value, discoveryTruncated: discovery.value.truncated },
    result.observedAtMs,
  );
}

function report(result: TickResult & { discoveryTruncated: boolean }): void {
  const line = {
    epoch: result.epoch.toString(),
    harvested: result.harvested.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
    // Both truncation flags are reported, always. A partial list silently treated as complete is
    // how the newest vaults stop being harvested with nothing going red.
    discoveryTruncated: result.discoveryTruncated,
    tickTruncated: result.truncated,
  };
  console.log(JSON.stringify(line));

  for (const outcome of result.harvested) {
    console.log(
      JSON.stringify({ vault: outcome.vaultId, reason: outcome.decision.reason, digest: outcome.digest }),
    );
  }
  for (const outcome of result.failed) {
    console.error(
      JSON.stringify({ vault: outcome.vaultId, reason: outcome.decision.reason, error: outcome.error }),
    );
  }
  // Skips are counted but not enumerated: in steady state every vault skips, and a log that
  // prints a line per vault per tick is a log nobody reads.
}

/**
 * Run the daemon.
 *
 * # The shape, and why it is this shape
 *
 * `--once` does one tick and exits, and it is the mode to run under a supervisor: launchd, systemd
 * or a container restart policy. The supervisor is better at restarting than this process is at not
 * dying, and a crash under `--once` costs one tick rather than every future one.
 */
export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const options = parseArgs(argv);

  const configReading = loadDaemonConfig(env);
  const config = fold(
    configReading,
    (value) => value,
    (failure) => {
      console.error(JSON.stringify({ configuration: failure.detail }));
      return null;
    },
  );
  if (config === null) return EXIT.misconfigured;

  const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: config.grpcUrl });

  // --- Signer ---
  let signer: HarvestSigner;
  if (options.dryRun) {
    signer = dryRunSigner();
  } else {
    const secret = assertSignerConfigured(config);
    if (!secret.ok) {
      console.error(JSON.stringify({ signer: secret.failure.detail }));
      return EXIT.misconfigured;
    }

    const built = fold(
      createSigner(client, secret.value, config.gasBudgetMist, config.latestPackageId),
      (value) => value,
      (failure) => {
        console.error(JSON.stringify({ signer: failure.detail }));
        return null;
      },
    );
    if (built === null) return EXIT.misconfigured;
    signer = built;

    // Preflight. A budget above the balance means nothing executes at all, so it is checked before
    // the first tick rather than inferred later from a vault that never accrues.
    const funded = fold(
      await readSignerBalance(client, signer.address),
      (mist) => assertSignerFunded(mist, config.gasBudgetMist),
      (failure) => fail<true>(failure.kind, failure.source, failure.detail),
    );
    if (!funded.ok) {
      console.error(JSON.stringify({ signer: funded.failure.detail }));
      return EXIT.misconfigured;
    }
  }

  // --- Journal and the single-instance lock ---
  //
  // Opened after the signer preflight so a misconfigured key fails without taking a lock that a
  // working instance might want, and before the first tick so nothing is ever harvested unrecorded.
  let journal: Journal | null = null;
  if (!options.dryRun) {
    const url = assertJournalConfigured(config);
    if (!url.ok) {
      console.error(JSON.stringify({ journal: url.failure.detail }));
      return EXIT.misconfigured;
    }
    const opened = await openJournal(url.value);
    if (!opened.ok) {
      console.error(JSON.stringify({ journal: opened.failure.detail }));
      // A held lock is not a misconfiguration and not a transient failure: this instance is simply
      // redundant. A supervisor must not restart it into a loop against its own sibling.
      return opened.failure.detail.includes('already holds the run lock')
        ? EXIT.alreadyRunning
        : EXIT.misconfigured;
    }
    journal = opened.value;

    // A run left `running` by a dead process is the only evidence a crash leaves. Surfaced at
    // startup because that is when somebody is looking.
    fold(
      await journal.stuckRuns(config.tickIntervalSeconds * 1000 * 3),
      (stuck) => {
        for (const run of stuck) {
          console.error(
            JSON.stringify({
              stuckRun: run.id,
              startedAtMs: run.startedAtMs,
              note: 'a previous tick never finished — the daemon died mid-run',
            }),
          );
        }
        return null;
      },
      (failure) => {
        console.error(JSON.stringify({ stuckRunCheck: failure.detail }));
        return null;
      },
    );
  }

  const shutdown = installShutdown(process);
  const backoff = createBackoff({
    baseMs: config.tickIntervalSeconds * 1000,
    // Ten times the interval. Long enough to stop hammering a dead node, short enough that a
    // recovered one is picked up within an epoch rather than a day.
    maxMs: config.tickIntervalSeconds * 1000 * 10,
  });

  console.log(
    JSON.stringify({
      starting: true,
      ...redactedConfig(config),
      signer: signer.address,
      mode: options.dryRun ? 'dry-run' : 'live',
      once: options.once,
      pid: process.pid,
    }),
  );

  let exitCode: number = EXIT.ok;
  try {
    for (;;) {
      const run: RunHandle | null =
        journal === null
          ? null
          : fold(
              await journal.begin({
                mode: options.dryRun ? 'dry-run' : 'live',
                signer: signer.address,
              }),
              (handle) => handle,
              (failure) => {
                console.error(JSON.stringify({ journalBegin: failure.detail }));
                return null;
              },
            );

      /*
        No journal row, no harvest.

        A journal is mandatory in live mode — the startup above exits `misconfigured` if it cannot
        be opened — and the comment there states why: "before the first tick so nothing is ever
        harvested unrecorded". That invariant was enforced once, at startup, and then not again. A
        `journal.begin` that failed logged its detail, set `run` to null, and FELL THROUGH to
        `runOnce`, which harvests and signs. The `finish` and `abandon` calls below are both guarded
        on `run !== null`, so the work completed and left no trace of having happened.

        Unrecorded is the one outcome this daemon may not produce. A tick that does not run is
        visible in the next tick and costs a cycle; a tick that ran without a row is invisible and
        costs a reconciliation nobody knows to perform.

        Counted as a failure so the backoff applies. A journal that will not open a run is usually a
        database that is unwell, and retrying it at full rate is how one outage becomes two.
      */
      if (journal !== null && run === null) {
        console.error(
          JSON.stringify({
            tick: 'skipped',
            reason: 'the journal would not open a run, and an unrecorded harvest is not permitted',
          }),
        );
        backoff.fail();
        exitCode = EXIT.runFailed;
        if (options.once) break;
        if (shutdown.requested) {
          exitCode = EXIT.ok;
          break;
        }
        const wait = backoff.delayMs();
        console.error(
          JSON.stringify({ backingOff: wait, consecutiveFailures: backoff.failures() }),
        );
        await sleepUnlessShutdown(wait, shutdown);
        if (shutdown.requested) {
          exitCode = EXIT.ok;
          break;
        }
        continue;
      }

      /*
        The tick is raced against the shutdown deadline, but it is NOT cancelled. Nothing here can
        safely interrupt a transaction that may already be in flight — the deadline bounds how long
        shutdown waits, not what the tick is allowed to finish doing. A tick that outlives the grace
        period leaves its `running` row behind, which is exactly the signal it should leave.
      */
      const work = runOnce(client, config, signer);
      const raced = shutdown.requested
        ? await withDeadline(work, SHUTDOWN_GRACE_MS)
        : { finished: true as const, value: await work };

      if (!raced.finished) {
        console.error(JSON.stringify({ shutdown: 'deadline', note: 'tick did not finish in time' }));
        exitCode = EXIT.ok;
        break;
      }

      const result = raced.value;
      if (result.ok) {
        backoff.succeed();
        report(result.value);
        if (run !== null && journal !== null) {
          fold(
            await journal.finish(run, result.value),
            () => null,
            (failure) => {
              // The work happened; only the record failed. Reported loudly, because a harvest
              // nobody can point at later is a harvest that will be doubted.
              console.error(JSON.stringify({ journalFinish: failure.detail }));
              return null;
            },
          );
          await anchor(journal, run, signer);
        }
      } else {
        backoff.fail();
        console.error(
          JSON.stringify({
            tickFailed: result.failure.kind,
            detail: result.failure.detail,
            consecutiveFailures: backoff.failures(),
          }),
        );
        if (run !== null && journal !== null) {
          /*
            `abandon` returns a Reading and it was discarded.

            `finish` immediately above is folded and logs `journalFinish` when the record fails.
            This one was awaited and dropped, so an abandon that failed left the run row `running` —
            and `stuckRuns` describes exactly that row as "runs left `running` by a process that
            died. The only way to see a crash after the fact."

            The process did not die. It ran, the tick failed, and the write recording that failure
            was the thing that did not land. So the daemon manufactured a crash report about
            itself, and the one signal that exists to reveal a real crash was the signal it
            corrupted.
          */
          fold(
            await journal.abandon(run, {
              kind: result.failure.kind,
              detail: result.failure.detail,
            }),
            () => null,
            (failure) => {
              // Reported, not escalated. The tick had already failed and its exit code already
              // says so; this line is the difference between a stuck run that means a crash and
              // one that means a write did not land.
              console.error(JSON.stringify({ journalAbandon: failure.detail }));
              return null;
            },
          );
          await anchor(journal, run, signer);
        }
        exitCode = EXIT.runFailed;
      }

      if (options.once) break;
      if (shutdown.requested) {
        exitCode = EXIT.ok;
        break;
      }

      const delay = backoff.delayMs();
      if (backoff.failures() > 0) {
        console.error(JSON.stringify({ backingOff: delay, consecutiveFailures: backoff.failures() }));
      }
      await sleepUnlessShutdown(delay, shutdown);
      if (shutdown.requested) {
        exitCode = EXIT.ok;
        break;
      }
      // A successful loop resets the exit code: the process is healthy again, and a supervisor
      // reading the final code should not be told about a failure three hours ago.
      exitCode = EXIT.ok;
    }
  } finally {
    shutdown.dispose();
    if (journal !== null) await journal.close();
    console.log(JSON.stringify({ stopped: true, exitCode }));
  }

  return exitCode;
}

export {
  loadDaemonConfig,
  redactedConfig,
  assertSignerFunded,
  assertJournalConfigured,
  assertSignerConfigured,
} from './config.js';
export { openJournal, type Journal, type RunSummary } from './adapters/journal.js';
export * from './supervisor.js';
export { discoverVaults } from './adapters/discovery.js';
export { readCurrentEpoch, readStakeVault, decodeStakeVault } from './adapters/vault.js';
export { createSigner } from './adapters/signer.js';
export { tick, type EnginePorts, type TickResult } from './engine.js';
export { status } from './status.js';
export * from './domain/harvest.js';
