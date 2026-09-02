// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Reading the on-chain encryption key registry.
 *
 * # Why this read exists at all
 *
 * Reading the chain removes it. There is one registry, and a client that does this read cannot be
 * lied to about what is in it by anything short of a compromised fullnode.
 *
 * # A third positional mirror
 *
 * gRPC returns object contents as raw BCS, which carries no field names. The layouts below must
 * match `key_registry.move` exactly. `test/keyregistry-layout.test.ts` asserts them against the
 * Move source directly, and that guard is mutation-tested.
 *
 * `Table<K, V>` serialises as `{ id: UID, size: u64 }` — the entries are dynamic fields hanging off
 * the **table's** id, not the registry's. That is why a lookup reads the registry first.
 */

import { decodeObjectBytes } from './objectbytes.js';
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { classify, fail, ok, type Reading } from './reading.js';

const PublishedKeyBcs = bcs.struct('PublishedKey', {
  x25519Public: bcs.vector(bcs.u8()),
  version: bcs.u64(),
  updatedAtMs: bcs.u64(),
});

const KeyRegistryBcs = bcs.struct('KeyRegistry', {
  id: bcs.Address,
  keys: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
});

/**
 * A `Table` entry is stored as `Field<Name, Value>`, a framework struct with its own id and the
 * name repeated inside it. The repeated name is what lets a reader confirm it fetched the entry it
 * asked for rather than one that happened to decode.
 */
const FieldBcs = bcs.struct('Field', {
  id: bcs.Address,
  name: bcs.Address,
  value: PublishedKeyBcs,
});

/** Field order above, exported so the drift test can compare it with the Move source. */
export const PUBLISHED_KEY_BCS_FIELDS = ['x25519_public', 'version', 'updated_at_ms'] as const;

/** Likewise for the registry itself. */
export const KEY_REGISTRY_BCS_FIELDS = ['id', 'keys'] as const;

export interface PublishedKey {
  /** 32 raw bytes. Base64 is a transport concern and is not applied here. */
  x25519Public: Uint8Array;
  /** 1 for a first key, incremented on each change. A republish of the same bytes does not move it. */
  version: bigint;
  updatedAtMs: bigint;
}

/** An X25519 public key is exactly this long. Mirrored from `key_registry::KEY_BYTES`. */
export const KEY_BYTES = 32;

/**
 * One decoder for every object read in this package — `decodeObjectBytes` in objectbytes.ts —
 * so a transport that answers base64, a byte array or an array-like object is read the same way
 * here as everywhere else. Until 2026-09-02 this file carried its own reader that accepted a
 * subset of those shapes, and a key registry answered as the other shape was reported "malformed:
 * no decodable content" (the read fails CLOSED, never wrong, but a page said "not measured" for a
 * value the node had sent). A decode failure is `null` here, which every caller below already
 * reports as malformed with the source named.
 */
function toBytes(content: unknown): Uint8Array | null {
  const decoded = decodeObjectBytes(content, 'key registry');
  return decoded.ok ? decoded.value : null;
}

/**
 * The id of the table inside the registry.
 *
 * Read rather than configured. It is derivable only from the registry object, and a configured
 * copy is a second source of truth that would resolve to nothing the day the registry is
 * redeployed — surfacing as "nobody has published a key", which is the exact wrong answer.
 *
 * Immutable once the registry exists, so a caller may cache it for the process lifetime.
 */
export async function readKeyRegistryTableId(
  client: SuiGrpcClient,
  registryId: string,
): Promise<Reading<string>> {
  const source = `KeyRegistry ${registryId}`;
  try {
    const response = await client.getObject({ objectId: registryId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;
    if (object === undefined || object === null) {
      return fail('not-found', source, 'no object exists at that id on this network');
    }

    const bytes = toBytes(object.content);
    if (bytes === null) {
      return fail(
        'malformed',
        source,
        'the object carried no decodable content — request it with include: { content: true }',
      );
    }
    // id + table id + table size. A shorter buffer is a different struct that would otherwise
    // decode into a plausible-looking table id pointing at nothing.
    if (bytes.length < 32 + 32 + 8) {
      return fail(
        'malformed',
        source,
        `content is ${bytes.length} bytes, expected at least 72 — the id probably names ` +
          `something that is not a KeyRegistry`,
      );
    }

    const decoded = KeyRegistryBcs.parse(bytes);
    if (BigInt(decoded.id) !== BigInt(registryId)) {
      return fail(
        'malformed',
        source,
        `decoded id ${decoded.id} does not match the requested id — not a KeyRegistry`,
      );
    }
    return ok(decoded.keys.id);
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

/**
 * The key published by `address`, or `null` when it has published none.
 *
 * The `null` sits **inside** an `ok`, and that placement is the whole point. "We looked and there
 * is no key" and "we could not look" lead to opposite behaviour in a sender — plaintext with a
 * visible label, versus refusing to send — and collapsing them is how an outage becomes a silent
 * downgrade. A caller that folds this reading cannot accidentally treat the second as the first.
 */
export async function readPublishedKey(
  client: SuiGrpcClient,
  tableId: string,
  address: string,
): Promise<Reading<PublishedKey | null>> {
  const source = `key of ${address}`;

  // Derived rather than searched. The child id of a `Table<address, V>` entry is a pure function of
  // the table id and the BCS-encoded key, so one read answers the question — no listing, no
  // pagination, and no ceiling to hit.
  let fieldId: string;
  try {
    fieldId = deriveDynamicFieldID(tableId, 'address', bcs.Address.serialize(address).toBytes());
  } catch (error) {
    return fail(
      'malformed',
      source,
      `could not derive the registry entry id: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  try {
    const response = await client.getObject({ objectId: fieldId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;

    // No entry. A measured absence, not a failure — this is the ordinary state of every address
    // that has never published, which is most of them.
    if (object === undefined || object === null) return ok(null);

    const bytes = toBytes(object.content);
    if (bytes === null) {
      return fail('malformed', source, 'the registry entry carried no decodable content');
    }

    const decoded = FieldBcs.parse(bytes);

    // The entry names its own key. If it disagrees with what we asked for, the derivation or the
    // table is not what we think it is, and the bytes below are somebody else's key.
    if (BigInt(decoded.name) !== BigInt(address)) {
      return fail(
        'malformed',
        source,
        `the entry at the derived id belongs to ${decoded.name}, not ${address}`,
      );
    }

    const key = Uint8Array.from(decoded.value.x25519Public);
    if (key.length !== KEY_BYTES) {
      // The contract refuses any other length, so this can only mean the layout has drifted.
      return fail(
        'malformed',
        source,
        `the published key is ${key.length} bytes, expected ${KEY_BYTES} — the decoder and the ` +
          `contract disagree about the layout`,
      );
    }

    return ok({
      x25519Public: key,
      version: BigInt(decoded.value.version),
      updatedAtMs: BigInt(decoded.value.updatedAtMs),
    });
  } catch (error) {
    const failure = classify(error, source);
    // A missing object arrives as an error on some transports and as an empty response on others.
    // Only a genuine not-found is folded into a measured absence; everything else stays a failure.
    if (failure.kind === 'not-found') return ok(null);
    return fail(failure.kind, source, failure.detail);
  }
}
