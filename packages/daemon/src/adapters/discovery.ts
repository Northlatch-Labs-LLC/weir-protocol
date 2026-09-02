// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Vault discovery: every `StakeVault` the package has ever opened, from its events.
 *
 * # Why events rather than a registry
 *
 * `Platform` counts vaults but does not list them — deliberately, because a growing `Table` on a
 * shared object makes every creation contend on one write. The event log is the list, and it is
 * append-only, so discovery is a replay rather than a query against mutable state.
 *
 * # Every loop here is bounded
 *
 * `while (hasNextPage)` is how a sibling scanner in this estate issued 99,616 RPC calls against a
 * budget of 12. The ceiling is a config value that the caller cannot raise per-call, and when it
 * stops us the result is returned **flagged as partial**.
 *
 * That flag is load-bearing. "That is every vault" and "that is every vault I had budget to find"
 * imply opposite things: the first means a vault absent from the list does not exist, the second
 * means it might simply be beyond the horizon. A daemon that treated a truncated list as complete
 * would silently stop harvesting the newest vaults — the ones most likely to need it.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { classify, fail, ok, type Reading } from '@projectx-social/sdk';

export interface DiscoveredVault {
  vaultId: string;
  creator: string;
  validator: string;
  feeBpsSnapshot: bigint;
  /** Transaction that opened it — the audit trail back to a real event. */
  digest: string;
}

export interface Discovery {
  vaults: DiscoveredVault[];
  /** True when the page ceiling stopped the walk before the log was exhausted. */
  truncated: boolean;
  /** Pages actually walked, so a truncation can be told from a short log. */
  pagesRead: number;
}

/**
 * The `StakeVaultOpened` event, as the node renders it.
 *
 * Read from the decoded `json` field rather than the raw BCS. Unlike an object's contents, an
 * event's JSON is keyed by field name, so it is not positional and cannot silently shift when a
 * field is inserted — a missing key becomes an explicit failure below instead of a wrong value.
 */
interface StakeVaultOpenedJson {
  vault?: unknown;
  creator?: unknown;
  validator?: unknown;
  fee_bps_snapshot?: unknown;
}

/**
 * Walk the event log and return every vault, oldest first.
 *
 * `maxPages` is a hard ceiling. It is a parameter only so the caller can pass its configured
 * value; there is no code path that raises it mid-walk.
 */
export async function discoverVaults(
  client: SuiGrpcClient,
  packageId: string,
  maxPages: number,
): Promise<Reading<Discovery>> {
  const eventType = `${packageId}::stake_vault::StakeVaultOpened`;
  const source = `StakeVaultOpened events for ${packageId}`;

  if (maxPages < 1) {
    return fail('unconfigured', source, `maxPages must be at least 1, got ${maxPages}`);
  }

  const vaults: DiscoveredVault[] = [];
  let cursor: string | null = null;
  let pagesRead = 0;

  try {
    while (pagesRead < maxPages) {
      const page: {
        events?: Array<{ json?: unknown; transactionDigest?: unknown }>;
        hasNextPage?: boolean;
        endCursor?: string | null;
      } = await client.listEvents({
        filter: { eventType },
        limit: 50,
        ...(cursor === null ? {} : { cursor }),
      });
      pagesRead += 1;

      for (const event of page.events ?? []) {
        const parsed = parseOpenedEvent(event.json, String(event.transactionDigest ?? ''));
        // A malformed event fails the whole discovery rather than being skipped. Skipping would
        // silently drop a vault from the harvest set, and a vault nobody harvests earns nothing —
        // which looks exactly like a vault with no deposits.
        if (parsed === null) {
          return fail(
            'malformed',
            source,
            `an event did not carry the expected fields: ${JSON.stringify(event.json)}`,
          );
        }
        vaults.push(parsed);
      }

      if (page.hasNextPage !== true) {
        return ok({ vaults, truncated: false, pagesRead });
      }
      cursor = page.endCursor ?? null;
      if (cursor === null) {
        // The node claims more pages but gave no cursor to reach them. Report what we have as
        // partial rather than looping forever on the same page.
        return ok({ vaults, truncated: true, pagesRead });
      }
    }

    // Ceiling reached with the log still going.
    return ok({ vaults, truncated: true, pagesRead });
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

function parseOpenedEvent(json: unknown, digest: string): DiscoveredVault | null {
  if (typeof json !== 'object' || json === null) return null;
  const e = json as StakeVaultOpenedJson;

  if (
    typeof e.vault !== 'string' ||
    typeof e.creator !== 'string' ||
    typeof e.validator !== 'string' ||
    e.fee_bps_snapshot === undefined
  ) {
    return null;
  }

  return {
    vaultId: e.vault,
    creator: e.creator,
    validator: e.validator,
    feeBpsSnapshot: BigInt(String(e.fee_bps_snapshot)),
    digest,
  };
}
