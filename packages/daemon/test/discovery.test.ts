// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Discovery, against a fake event log.
 *
 * The cases that matter are about the ceiling. A truncated list reported as complete means the
 * daemon silently stops harvesting the newest vaults — the ones most likely to need it — and
 * nothing anywhere goes red.
 */

import { describe, expect, it } from 'vitest';
import { discoverVaults } from '../src/adapters/discovery.js';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

const PKG = '0xc5c833991ed1123d70b1001c0bcdb01ec5728b09f25dfc42a0edaf16005d404d';

function event(n: number) {
  return {
    json: {
      vault: `0x${String(n).padStart(64, '0')}`,
      creator: `0x${'c'.repeat(64)}`,
      validator: `0x${'v'.repeat(63)}1`,
      fee_bps_snapshot: '290',
    },
    transactionDigest: `digest-${n}`,
  };
}

/** A fake client serving `pages` pages of events, counting how many were actually requested. */
function fakeClient(pages: Array<{ events: unknown[]; hasNextPage: boolean; endCursor?: string | null }>) {
  let calls = 0;
  const client = {
    listEvents: async () => {
      const page = pages[calls] ?? { events: [], hasNextPage: false };
      calls += 1;
      return page;
    },
    get callCount() {
      return calls;
    },
  };
  return client as unknown as SuiGrpcClient & { callCount: number };
}

describe('discoverVaults', () => {
  it('returns every vault when the log fits in one page', async () => {
    const client = fakeClient([{ events: [event(1), event(2)], hasNextPage: false }]);
    const reading = await discoverVaults(client, PKG, 20);

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.vaults).toHaveLength(2);
    expect(reading.value.truncated).toBe(false);
    expect(reading.value.pagesRead).toBe(1);
    expect(reading.value.vaults[0]!.feeBpsSnapshot).toBe(290n);
  });

  it('follows the cursor across pages', async () => {
    const client = fakeClient([
      { events: [event(1)], hasNextPage: true, endCursor: 'c1' },
      { events: [event(2)], hasNextPage: true, endCursor: 'c2' },
      { events: [event(3)], hasNextPage: false },
    ]);
    const reading = await discoverVaults(client, PKG, 20);

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.vaults).toHaveLength(3);
    expect(reading.value.truncated).toBe(false);
  });

  it('stops at the ceiling and flags the result as partial', async () => {
    // The bound that stops a 99,616-call walk. Flagged, because "that is all of them" and
    // "that is all I had budget for" imply opposite next actions.
    const pages = Array.from({ length: 10 }, (_, i) => ({
      events: [event(i)],
      hasNextPage: true,
      endCursor: `c${i}`,
    }));
    const client = fakeClient(pages);
    const reading = await discoverVaults(client, PKG, 3);

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.truncated).toBe(true);
    expect(reading.value.pagesRead).toBe(3);
    expect(reading.value.vaults).toHaveLength(3);
    expect(client.callCount).toBe(3);
  });

  it('does not loop forever when the node claims more pages but gives no cursor', async () => {
    // A node that says hasNextPage without an endCursor would otherwise re-request page one for
    // ever. Reported as partial rather than spun on.
    const client = fakeClient([{ events: [event(1)], hasNextPage: true, endCursor: null }]);
    const reading = await discoverVaults(client, PKG, 20);

    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.truncated).toBe(true);
    expect(client.callCount).toBe(1);
  });

  it('fails on a malformed event rather than skipping it', async () => {
    // Skipping would silently drop a vault from the harvest set. A vault nobody harvests earns
    // nothing, which looks exactly like a vault with no deposits.
    const client = fakeClient([
      { events: [event(1), { json: { vault: '0xabc' }, transactionDigest: 'd' }], hasNextPage: false },
    ]);
    const reading = await discoverVaults(client, PKG, 20);

    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.failure.kind).toBe('malformed');
  });

  it('refuses a ceiling below one instead of walking unbounded', async () => {
    const client = fakeClient([{ events: [], hasNextPage: false }]);
    const reading = await discoverVaults(client, PKG, 0);

    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.failure.kind).toBe('unconfigured');
    expect(client.callCount).toBe(0);
  });

  it('returns an empty list, not a failure, when no vault has ever been opened', async () => {
    // "We looked and there are none" is a real answer and must not read as a fault.
    const client = fakeClient([{ events: [], hasNextPage: false }]);
    const reading = await discoverVaults(client, PKG, 20);

    expect(reading.ok).toBe(true);
    if (reading.ok) expect(reading.value.vaults).toEqual([]);
  });
});
