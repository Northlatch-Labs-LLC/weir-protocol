#!/usr/bin/env node
// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Read the run journal. `pnpm journal`
 */

import { fold } from '@projectx-social/sdk';
import { assertJournalConfigured, loadDaemonConfig } from './config.js';
import { openJournal } from './adapters/journal.js';

const config = fold(
  loadDaemonConfig(process.env),
  (value) => value,
  (failure) => {
    console.error(failure.detail);
    return null;
  },
);
if (config === null) process.exit(1);

const url = assertJournalConfigured(config);
if (!url.ok) {
  console.error(url.failure.detail);
  process.exit(1);
}

/*
  Opening the journal takes the single-instance lock, so this refuses to run while the daemon does.
  That is the correct behaviour rather than an inconvenience: a reader that quietly took the lock
  would make the daemon's next restart fail, and one that bypassed it would need a second code path
  into the same database. Read the journal with psql if you need it while the daemon is live.
*/
const opened = await openJournal(url.value);
if (!opened.ok) {
  console.error(opened.failure.detail);
  process.exit(opened.failure.detail.includes('already holds the run lock') ? 2 : 1);
}
const journal = opened.value;

const stuck = await journal.stuckRuns(config.tickIntervalSeconds * 1000 * 3);
fold(
  stuck,
  (runs) => {
    if (runs.length === 0) console.log('no stuck runs');
    for (const run of runs) {
      console.log(`STUCK run ${run.id} started ${new Date(run.startedAtMs).toISOString()} — never finished`);
    }
    return null;
  },
  (failure) => {
    console.error(`stuck runs not measured — ${failure.detail}`);
    return null;
  },
);

console.log('');
fold(
  await journal.recentRuns(20),
  (runs) => {
    if (runs.length === 0) {
      // A measured emptiness, said as such. An empty journal and an unreadable one look identical
      // in any output that just prints nothing.
      console.log('the journal was read and holds no runs — the daemon has never completed a tick');
      return null;
    }
    console.log('when                      mode      epoch   seen  harv  skip  fail  outcome  audit');
    for (const r of runs) {
      const when = new Date(r.startedAtMs).toISOString().replace('T', ' ').slice(0, 19);
      const epoch = r.epoch === null ? '—' : r.epoch.toString();
      console.log(
        `${when}  ${r.mode.padEnd(8)}  ${epoch.padStart(5)}  ${String(r.vaultsSeen).padStart(4)}  ` +
          `${String(r.harvested).padStart(4)}  ${String(r.skipped).padStart(4)}  ` +
          `${String(r.failed).padStart(4)}  ${r.outcome}${r.truncated ? ' (TRUNCATED)' : ''}` +
          // The anchored chain head, so a reader can match a log to the run that produced it. A
          // run with no anchor is older than db/002 or its anchor write failed; either is worth seeing.
          `  ${r.auditHead === null ? 'unanchored' : `${r.auditHead.headHash.slice(0, 12)}… ×${r.auditHead.entries}${r.auditHead.intact ? '' : ' BROKEN'}`}` +
          `${r.failureDetail === null ? '' : ` — ${r.failureDetail}`}`,
      );
    }
    return null;
  },
  (failure) => {
    console.error(`runs not measured — ${failure.detail}`);
    return null;
  },
);

await journal.close();
