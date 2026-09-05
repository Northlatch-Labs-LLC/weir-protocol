// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Reading a `CreatorVault<T>` — tiers, terms and balances.
 *
 * # Another positional mirror
 *
 * gRPC returns object contents as raw BCS, which carries no field names. The layout below must
 * match `creator::CreatorVault` exactly; insert one field in the Move struct and this decoder keeps
 * working while returning `min_tip` as the accepting flag. `test/creator-layout.test.ts` asserts it
 * against `creator.move` directly, and that guard is mutation-tested.
 *
 * `Table<K, V>` serialises as `{ id: UID, size: u64 }` — the entries live in dynamic fields, not
 * inline. `Balance<T>` is a bare `u64`.
 */

import { decodeObjectBytes } from './objectbytes.js';
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { classify, fail, ok, type Reading } from './reading.js';

const TierBcs = bcs.struct('Tier', {
  name: bcs.string(),
  price: bcs.u64(),
  periodMs: bcs.u64(),
  active: bcs.bool(),
});

const CreatorVaultBcs = bcs.struct('CreatorVault', {
  id: bcs.Address,
  version: bcs.u64(),
  platform: bcs.Address,
  owner: bcs.Address,
  account: bcs.Address,
  feeBpsSnapshot: bcs.u64(),
  referralShareBpsSnapshot: bcs.u64(),
  tiers: bcs.vector(TierBcs),
  contentPrices: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
  minTip: bcs.u64(),
  accepting: bcs.bool(),
  earnings: bcs.u64(),
  platformFees: bcs.u64(),
  grossVolume: bcs.u64(),
  subscriptionsSold: bcs.u64(),
  unlocksSold: bcs.u64(),
  tipsReceived: bcs.u64(),
});

/** Field order above, exported so the drift test can compare it with the Move source. */
export const CREATOR_VAULT_BCS_FIELDS = [
  'id',
  'version',
  'platform',
  'owner',
  'account',
  'fee_bps_snapshot',
  'referral_share_bps_snapshot',
  'tiers',
  'content_prices',
  'min_tip',
  'accepting',
  'earnings',
  'platform_fees',
  'gross_volume',
  'subscriptions_sold',
  'unlocks_sold',
  'tips_received',
] as const;

export interface Tier {
  index: number;
  name: string;
  /** Price per period, in `T`'s smallest units. */
  price: bigint;
  periodMs: bigint;
  /** Retired tiers stay in the list so existing subscribers keep a valid index. */
  active: boolean;
}

export interface CreatorVaultState {
  vaultId: string;
  /** The creator. Cannot pay their own vault — the contract refuses with `ESelfPayment`. */
  owner: string;
  /**
   * The `content_prices` table's own id, which is what a per-key lookup needs.
   *
   * The struct carries `{ id, size }` and no entries: a `Table` keeps its contents in dynamic
   * fields hanging off this id. Exposed because the size alone answers nothing useful — "this vault
   * prices four things" cannot tell a creator whether the key they just typed is one of them.
   */
  contentPricesTableId: string;
  feeBpsSnapshot: bigint;
  referralShareBpsSnapshot: bigint;
  tiers: Tier[];
  minTip: bigint;
  accepting: boolean;
  earnings: bigint;
  platformFees: bigint;
  grossVolume: bigint;
  subscriptionsSold: bigint;
}

/**
 * One decoder for every object read in this package — `decodeObjectBytes` in objectbytes.ts —
 * so a transport that answers base64, a byte array or an array-like object is read the same way
 * here as everywhere else. Until 2026-09-02 this file carried its own reader that accepted a
 * subset of those shapes, and a creator vault answered as the other shape was reported "malformed:
 * no decodable content" (the read fails CLOSED, never wrong, but a page said "not measured" for a
 * value the node had sent). A decode failure is `null` here, which every caller below already
 * reports as malformed with the source named.
 */
function toBytes(content: unknown): Uint8Array | null {
  const decoded = decodeObjectBytes(content, 'creator vault');
  return decoded.ok ? decoded.value : null;
}

/** Decode a raw BCS buffer. Exported so the layout test can drive it without a network. */
export function decodeCreatorVault(
  bytes: Uint8Array,
  expectedId: string,
): Reading<CreatorVaultState> {
  const source = `CreatorVault ${expectedId}`;
  try {
    const v = CreatorVaultBcs.parse(bytes);

    // Decoding a different struct that happens to parse would make every field after the id
    // meaningless rather than merely wrong.
    if (BigInt(v.id) !== BigInt(expectedId)) {
      return fail('malformed', source, `decoded id ${v.id} does not match the requested id`);
    }

    return ok({
      vaultId: expectedId,
      owner: v.owner,
      contentPricesTableId: v.contentPrices.id,
      feeBpsSnapshot: BigInt(v.feeBpsSnapshot),
      referralShareBpsSnapshot: BigInt(v.referralShareBpsSnapshot),
      tiers: v.tiers.map((tier, index) => ({
        index,
        name: tier.name,
        price: BigInt(tier.price),
        periodMs: BigInt(tier.periodMs),
        active: tier.active,
      })),
      minTip: BigInt(v.minTip),
      accepting: v.accepting,
      earnings: BigInt(v.earnings),
      platformFees: BigInt(v.platformFees),
      grossVolume: BigInt(v.grossVolume),
      subscriptionsSold: BigInt(v.subscriptionsSold),
    });
  } catch (error) {
    return fail('malformed', source, classify(error, source).detail);
  }
}

/**
 * `Field<vector<u8>, u64>` — one entry of `content_prices`.
 *
 * The key is the content key itself, not a hash of it, so the entry names what it prices and can be
 * checked against what was asked for.
 */
const ContentPriceFieldBcs = bcs.struct('Field', {
  id: bcs.Address,
  name: bcs.vector(bcs.u8()),
  value: bcs.u64(),
});

/**
 * What a vault charges for one content key, or `null` if it charges nothing.
 *
 * # Why `null` is not a failure
 *
 * An unpriced key is the ordinary state of every key that has not been sold yet, which is most of
 * them. It is measured, not missing, and the distinction matters: a creator about to publish under
 * a key needs "this key has no price" and "we could not reach the chain" to look different. The
 * first means they must price it; the second means they must not conclude anything.
 *
 * # Derived, not searched
 *
 * The child id of a `Table<K, V>` entry is a pure function of the table id and the BCS-encoded key,
 * so one read answers the question — no listing, no pagination, and no ceiling to hit on a vault
 * that prices hundreds of things.
 */
export async function readContentPrice(
  client: SuiGrpcClient,
  contentPricesTableId: string,
  contentKey: string,
): Promise<Reading<bigint | null>> {
  const source = `price of "${contentKey}"`;

  // The contract refuses an empty key with `EEmptyName`, so it can never have a price. Answered
  // here rather than spent as a round trip.
  const key = new TextEncoder().encode(contentKey);
  if (key.length === 0) return ok(null);

  let fieldId: string;
  try {
    fieldId = deriveDynamicFieldID(
      contentPricesTableId,
      'vector<u8>',
      bcs.vector(bcs.u8()).serialize(key).toBytes(),
    );
  } catch (error) {
    return fail(
      'malformed',
      source,
      `could not derive the price entry id: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const response = await client.getObject({ objectId: fieldId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;
    if (object === undefined || object === null) return ok(null);

    const bytes = toBytes(object.content);
    if (bytes === null) {
      return fail('malformed', source, 'the price entry carried no decodable content');
    }

    const decoded = ContentPriceFieldBcs.parse(bytes);

    // The entry names its own key. A mismatch means the derivation or the table is not what we
    // think it is, and the price below belongs to somebody else's content.
    const found = new TextDecoder().decode(Uint8Array.from(decoded.name));
    if (found !== contentKey) {
      return fail('malformed', source, `the entry at the derived id prices "${found}" instead`);
    }

    return ok(BigInt(decoded.value));
  } catch (error) {
    const failure = classify(error, source);

    /*
      A missing entry IS the answer: this key has no price.

      gRPC reports an absent object by throwing, not by returning an empty response, so the
      `object === null` branch above never fires for a key that was never priced — every one of them
      landed here and was reported as a failed read. Measured against mainnet, not reasoned about:
      a real priced key returned 100000, and an invented one returned `not-found` where it should
      have returned `null`.

      That inversion is the worst possible one for this call. Unpriced is the ordinary state of
      almost every key, so the composer would have shown "could not be read" to nearly every
      creator naming a new one — and "could not be read" is exactly the state in which it must not
      let them publish.
    */
    if (failure.kind === 'not-found') return ok(null);

    return fail(failure.kind, source, failure.detail);
  }
}

export async function readCreatorVault(
  client: SuiGrpcClient,
  vaultId: string,
): Promise<Reading<CreatorVaultState>> {
  const source = `CreatorVault ${vaultId}`;
  try {
    const response = await client.getObject({ objectId: vaultId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;
    if (object === undefined || object === null) {
      return fail('not-found', source, 'no object exists at that id on this network');
    }

    const bytes = toBytes(object.content);
    if (bytes === null) {
      return fail('malformed', source, 'the object carried no decodable content');
    }
    return decodeCreatorVault(bytes, vaultId);
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

/**
 * The coin a vault is denominated in, read from the object's type on chain: `CreatorVault<T>`.
 *
 * Needed since v5 because `creator::seal_approve_subscription<T>` must name `T`. Read rather than
 * configured or guessed: a vault takes payment in the coin it was opened in, and a client that
 * assumed USDC would build an approval the key servers refuse for a SUI vault in a way that reads
 * exactly like having no subscription.
 */
export async function readVaultCoinType(client: SuiGrpcClient, vaultId: string): Promise<Reading<string>> {
  const source = `CreatorVault ${vaultId}`;
  try {
    // `type` rides along with the content on this transport (measured 2026-09-02 against a live
    // vault); it is the full type tag, generic argument included.
    const response = await client.getObject({ objectId: vaultId, include: { content: true } });
    const object = (response as { object?: { type?: unknown } | null }).object;
    if (object === undefined || object === null) return fail('not-found', source, 'no object exists at that id on this network');
    const type = typeof object.type === 'string' ? object.type : null;
    if (type === null) return fail('malformed', source, 'the node did not report the object type');
    const m = /::creator::CreatorVault<(.+)>$/.exec(type);
    if (m === null || m[1] === undefined || m[1] === '') return fail('malformed', source, `${type} is not a CreatorVault`);
    return ok(m[1]);
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}
