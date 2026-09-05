// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Reading the handle registry — is this handle free, and does this address already have an account.
 *
 * # Both questions are asked before anyone signs anything
 *
 * `account::open` aborts on `EHandleTaken` and on `EAlreadyRegistered`, and a user who discovers
 * either after signing has paid gas to be told no. Worse, they have paid it to be told no in the
 * form of an abort code. So the registry is read first and the answer is shown while they type.
 *
 * The read is authoritative, not advisory: it is the same table the contract checks. It can still
 * lose a race — someone may take the handle between the check and the transaction — and that is
 * exactly why the contract check remains the one that decides. This read exists to stop the
 * ordinary case from costing money, not to replace the guard.
 *
 * # A fourth positional mirror
 *
 * The layout below must match `account::Registry`. `test/accounts-layout.test.ts` asserts it
 * against `account.move` directly.
 *
 * Both tables' entries are dynamic fields hanging off the **table's** id, not the registry's — so
 * a lookup reads the registry object first, exactly as the key registry does. The two tables have
 * different key types (`String` one way, `address` the other) and therefore different derivations.
 */

import { decodeObjectBytes } from './objectbytes.js';
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { classify, fail, ok, type Reading } from './reading.js';
import type { ProjectXSocialConfig } from './config.js';

const RegistryBcs = bcs.struct('Registry', {
  id: bcs.Address,
  byHandle: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
  byAddress: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
});

/** `Field<String, address>` — the `by_handle` entry. */
const HandleFieldBcs = bcs.struct('Field', {
  id: bcs.Address,
  name: bcs.string(),
  value: bcs.Address,
});

/** `Field<address, String>` — the `by_address` entry. */
const AddressFieldBcs = bcs.struct('Field', {
  id: bcs.Address,
  name: bcs.Address,
  value: bcs.string(),
});

/** Field order above, exported so the drift test can compare it with the Move source. */
export const REGISTRY_BCS_FIELDS = ['id', 'by_handle', 'by_address'] as const;

/*
  Handle rules, mirrored from `account.move`. Asserted against the source by the drift test.

  Duplicated here so a client can reject a bad handle without a round trip, and can say which rule
  was broken. The contract still enforces them — this is a better error message, not a gate.
*/
export const MIN_HANDLE_LEN = 3;
export const MAX_HANDLE_LEN = 30;

export type HandleProblem =
  | { kind: 'too-short'; min: number }
  | { kind: 'too-long'; max: number }
  | { kind: 'bad-character'; character: string };

/**
 * Why this handle would be rejected, or `null` if it would not.
 *
 * Byte-wise, like the contract. Every permitted byte is ASCII, so any multi-byte character
 * necessarily fails — deliberately, because a handle that renders identically to another in some
 * fonts is an impersonation vector on a social network.
 *
 * Uppercase is **rejected, not folded**. A registry that lower-cases what you typed hands you a
 * different handle from the one you asked for and reports success.
 */
export function handleProblem(handle: string): HandleProblem | null {
  const bytes = new TextEncoder().encode(handle);
  if (bytes.length < MIN_HANDLE_LEN) return { kind: 'too-short', min: MIN_HANDLE_LEN };
  if (bytes.length > MAX_HANDLE_LEN) return { kind: 'too-long', max: MAX_HANDLE_LEN };

  for (const character of handle) {
    const ok =
      /^[a-z0-9_]$/.test(character) && new TextEncoder().encode(character).length === 1;
    if (!ok) return { kind: 'bad-character', character };
  }
  return null;
}

/**
 * One decoder for every object read in this package — `decodeObjectBytes` in objectbytes.ts —
 * so a transport that answers base64, a byte array or an array-like object is read the same way
 * here as everywhere else. Until 2026-09-02 this file carried its own reader that accepted a
 * subset of those shapes, and a registry answered as the other shape was reported "malformed:
 * no decodable content" (the read fails CLOSED, never wrong, but a page said "not measured" for a
 * value the node had sent). A decode failure is `null` here, which every caller below already
 * reports as malformed with the source named.
 */
function toBytes(content: unknown): Uint8Array | null {
  const decoded = decodeObjectBytes(content, 'registry');
  return decoded.ok ? decoded.value : null;
}

export interface RegistryTables {
  byHandle: string;
  byAddress: string;
  /** How many handles are registered. A real number, read from the table's own counter. */
  accounts: bigint;
}

/**
 * The two table ids inside the registry.
 *
 * Read rather than configured, and cacheable for the process lifetime — they are fixed when the
 * registry is created and nothing changes them.
 */
export async function readRegistryTables(
  client: SuiGrpcClient,
  config: ProjectXSocialConfig,
): Promise<Reading<RegistryTables>> {
  const source = `account::Registry ${config.registryId}`;
  try {
    const response = await client.getObject({
      objectId: config.registryId,
      include: { content: true },
    });
    const object = (response as { object?: { content?: unknown } }).object;
    if (object === undefined || object === null) {
      return fail('not-found', source, 'no object exists at that id on this network');
    }

    const bytes = toBytes(object.content);
    if (bytes === null) {
      return fail('malformed', source, 'the object carried no decodable content');
    }
    // id + two tables of (id + size).
    if (bytes.length < 32 + (32 + 8) * 2) {
      return fail(
        'malformed',
        source,
        `content is ${bytes.length} bytes, expected at least 112 — the id probably names ` +
          `something that is not a Registry`,
      );
    }

    const decoded = RegistryBcs.parse(bytes);
    if (BigInt(decoded.id) !== BigInt(config.registryId)) {
      return fail(
        'malformed',
        source,
        `decoded id ${decoded.id} does not match the requested id — not a Registry`,
      );
    }

    return ok({
      byHandle: decoded.byHandle.id,
      byAddress: decoded.byAddress.id,
      accounts: BigInt(decoded.byHandle.size),
    });
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

/**
 * The address a handle belongs to, or `null` when it is free.
 *
 * `null` inside an `ok` is "we looked and it is free". A failure is "we could not look", and the
 * two must not be merged: telling someone a handle is available because the node was unreachable
 * sends them to sign a transaction that aborts.
 */
export async function resolveHandle(
  client: SuiGrpcClient,
  byHandleTableId: string,
  handle: string,
): Promise<Reading<string | null>> {
  const source = `handle ${handle}`;
  try {
    // `Table<String, address>` — the name is a `0x1::string::String`, which BCS-encodes as a
    // ULEB length followed by the bytes. Not the same encoding as a raw byte vector, and not the
    // same derivation as the address-keyed table below.
    const fieldId = deriveDynamicFieldID(
      byHandleTableId,
      '0x0000000000000000000000000000000000000000000000000000000000000001::string::String',
      bcs.string().serialize(handle).toBytes(),
    );

    const response = await client.getObject({ objectId: fieldId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;
    if (object === undefined || object === null) return ok(null);

    const bytes = toBytes(object.content);
    if (bytes === null) return fail('malformed', source, 'the registry entry had no content');

    const decoded = HandleFieldBcs.parse(bytes);
    if (decoded.name !== handle) {
      return fail(
        'malformed',
        source,
        `the entry at the derived id is for "${decoded.name}", not "${handle}"`,
      );
    }
    return ok(decoded.value);
  } catch (error) {
    const failure = classify(error, source);
    if (failure.kind === 'not-found') return ok(null);
    return fail(failure.kind, source, failure.detail);
  }
}

/**
 * The handle this address already holds, or `null` when it holds none.
 *
 * One account per address is enforced by the contract, so a non-null answer means `open` will
 * abort — and it also means the client already knows the user's handle without a second lookup.
 */
export async function handleOf(
  client: SuiGrpcClient,
  byAddressTableId: string,
  address: string,
): Promise<Reading<string | null>> {
  const source = `account of ${address}`;
  try {
    const fieldId = deriveDynamicFieldID(
      byAddressTableId,
      'address',
      bcs.Address.serialize(address).toBytes(),
    );

    const response = await client.getObject({ objectId: fieldId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;
    if (object === undefined || object === null) return ok(null);

    const bytes = toBytes(object.content);
    if (bytes === null) return fail('malformed', source, 'the registry entry had no content');

    const decoded = AddressFieldBcs.parse(bytes);
    if (BigInt(decoded.name) !== BigInt(address)) {
      return fail(
        'malformed',
        source,
        `the entry at the derived id belongs to ${decoded.name}, not ${address}`,
      );
    }
    return ok(decoded.value);
  } catch (error) {
    const failure = classify(error, source);
    if (failure.kind === 'not-found') return ok(null);
    return fail(failure.kind, source, failure.detail);
  }
}
