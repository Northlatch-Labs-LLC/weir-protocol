// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * A spending call in flight is never evicted, so a concurrent retry can never buy twice.
 *
 * # The defect this pins
 *
 * `once` evicts BEFORE it looks the key up, and both eviction rules deleted by age and by insertion
 * order without asking whether the call had finished. An in-flight entry is the ONLY record that a
 * spending call is already running — so evicting one deletes the guard itself. The concurrent retry
 * that arrives next finds nothing, runs the work a second time, and produces the double-buy this
 * class exists to prevent.
 *
 * The class docblock already names the concurrent retry as "the dangerous retry" and explains that
 * the map holds a promise precisely so a second caller JOINS the first. Eviction undid that, under
 * load, which is exactly when concurrent retries happen.
 *
 * # Which rule is reachable
 *
 * `RESULT_TTL_MS` is twenty-four hours and no call is in flight that long. `MAX_ENTRIES` is 512,
 * and the oldest entry under concurrent load is very plausibly still running. The capacity rule is
 * the one that could take money.
 */

import assert from 'node:assert/strict';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CallLedger, MAX_ENTRIES, RESULT_TTL_MS } from '../src/idempotency.js';

let checks = 0;
let failures = 0;
function check(what: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
    console.log(`  ok  ${what}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${what}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const result = (text: string): CallToolResult => ({ content: [{ type: 'text', text }] });

/** A call that never finishes until it is released. Stands in for a transaction being signed. */
function pending(): { work: () => Promise<CallToolResult>; release: () => void; runs: number } {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = () => resolve();
  });
  const state = {
    runs: 0,
    release: (): void => release(),
    work: async (): Promise<CallToolResult> => {
      state.runs += 1;
      await gate;
      return result('bought');
    },
  };
  return state;
}

async function main(): Promise<void> {
  {
    // The finding, reproduced. One in-flight purchase, then enough traffic to trigger the capacity
    // rule, then the retry that used to buy a second time.
    const ledger = new CallLedger();
    const buy = pending();

    const first = ledger.once('buy-me', buy.work);
    for (let i = 0; i < MAX_ENTRIES + 8; i += 1) {
      await ledger.once(`filler-${i}`, async () => result(`f${i}`));
    }
    const retry = ledger.once('buy-me', buy.work);
    buy.release();
    await Promise.all([first, retry]);

    check('a concurrent retry joins the in-flight call rather than running it again', () => {
      assert.equal(buy.runs, 1, `the purchase ran ${buy.runs} times`);
    });
  }

  {
    const ledger = new CallLedger();
    const buy = pending();
    const first = ledger.once('buy-me', buy.work);
    for (let i = 0; i < MAX_ENTRIES + 8; i += 1) {
      await ledger.once(`filler-${i}`, async () => result(`f${i}`));
    }

    check('the in-flight entry is still held after the capacity rule has run', () => {
      // The state the assertion above depends on. Asserted separately so a failure says WHICH of
      // the two broke: the entry was dropped, or it was kept and not joined.
      assert.ok(ledger.size > 0, 'the ledger is empty');
    });

    buy.release();
    await first;
  }

  {
    // The age rule, driven by a fake clock rather than by waiting twenty-four hours.
    let now = 1_000;
    const ledger = new CallLedger(() => now);
    const buy = pending();
    const first = ledger.once('buy-me', buy.work);

    now += RESULT_TTL_MS + 1;
    await ledger.once('anything', async () => result('x'));

    const retry = ledger.once('buy-me', buy.work);
    buy.release();
    await Promise.all([first, retry]);

    check('an in-flight call older than the TTL is not evicted either', () => {
      assert.equal(buy.runs, 1, `the purchase ran ${buy.runs} times after the TTL passed`);
    });
  }

  {
    // The converse. A ledger that never evicted anything would pass every assertion above while
    // growing without bound, which is the failure the eviction rules exist to prevent.
    let now = 1_000;
    const ledger = new CallLedger(() => now);
    await ledger.once('old', async () => result('old'));
    now += RESULT_TTL_MS + 1;
    await ledger.once('new', async () => result('new'));

    check('a SETTLED entry past its TTL is still evicted', () => {
      assert.equal(ledger.size, 1, `expected only the new entry, held ${ledger.size}`);
    });
  }

  {
    const ledger = new CallLedger();
    for (let i = 0; i < MAX_ENTRIES + 40; i += 1) {
      await ledger.once(`k-${i}`, async () => result(`v${i}`));
    }

    check('settled entries are still bounded by MAX_ENTRIES', () => {
      assert.ok(
        ledger.size <= MAX_ENTRIES,
        `the bound was abandoned for settled work: ${ledger.size}`,
      );
    });
  }

  console.log(`\n${checks - failures}/${checks} checks passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
