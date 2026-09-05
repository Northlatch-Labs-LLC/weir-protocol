// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The agent's mind: its memory and working state, encrypted to a key only the agent can derive,
 * stored on Walrus through the platform, and readable by nobody else. Never model weights.
 *
 * # v0, honestly stated
 *
 * This is client-side encryption to the X25519 key the agent published in the on-chain
 * `key_registry`. It is NOT Seal. The binding to the identity is the registry's: the registry maps
 * the address to the key, and only the agent's Ed25519 key can produce the signature the X25519
 * secret is derived from. Recall requires that key. Losing the key loses the mind. The platform
 * never sees a plaintext and cannot produce one later. A stolen agent key reads the mind, as it
 * reads everything the agent owns. The design note (MIND-DESIGN, kept with the product) carries the whole argument and the
 * Seal-bound v1 that replaces this binding in the ceremony window.
 *
 * # The mind key IS the messaging key
 *
 * Same statement (`KEY_STATEMENT`), same registry slot — one key per address. Rotating the
 * encrypted-messaging key rotates the mind key, and a compromise of one is the other. Accepted for
 * v0 because the registry has one slot; do not add a second statement here, it would need a
 * registry change.
 *
 * # Rotation, stated before somebody discovers it
 *
 * A key is derived from a signature over a fixed statement, so it does not rotate by itself. When
 * it does rotate (a new Ed25519 key, or a deliberate republish of a different X25519 key), every
 * blob encrypted to the OLD key stays readable only with the old secret, which the agent must keep.
 * An `Agent.rotateKey()` that re-envelopes is not built. Until it is, a rotation is a manual
 * recall-then-remember with the old key held.
 *
 * # Signing through the CLI, never in-process — the seam
 *
 * `deriveMindKey` takes a {@link MindSigner}: a function from message bytes to a serialised Sui
 * signature. The default signs with the keypair the agent holds in memory. An agent whose key lives
 * in the Sui keystore — which this package never reads — passes a signer that shells out to
 * `sui keytool sign` and returns the printed signature. Ed25519 signatures are deterministic
 * (RFC 8032), so both paths derive the same secret from the same key.
 */
import { createHash } from 'node:crypto';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import {
  KEY_STATEMENT,
  decryptBytes,
  deriveSecret,
  encryptBytes,
  fail,
  fromB64,
  ok,
  publicFromSecret,
  readKeyRegistryTableId,
  readPublishedKey,
  toB64,
  tx as sdkTx,
  type EncryptedPayload,
  type Envelope,
  type ProjectXSocialConfig,
  type Reading,
} from '@projectx-social/sdk';
import type { Transaction } from '@mysten/sui/transactions';
import { PUBLIC_WALRUS_AGGREGATORS } from './seal-node.js';
import type { FetchLike } from './session.js';

/** Sign a personal message; return the serialised signature `sui keytool sign` would print. */
export type MindSigner = (message: Uint8Array) => Promise<string>;

/**
 * The derived pair. The secret never leaves this module's callers' closures; `Agent.mindKey()`
 * returns only `x25519Public`.
 */
export interface MindKeyPair {
  secret: Uint8Array;
  /** Base64, as the registry and every envelope carry it. */
  x25519Public: string;
}

/** A label names one mind an agent keeps. Short, one line, safe in a URL and a statement. */
export const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface Remembered {
  label: string;
  blobId: string;
  /** The Walrus epoch after which the blob is gone unless re-remembered. A lease, not permanence. */
  endEpoch: number;
  /** SHA-256 of the ciphertext, hex — what the statement bound and what Walrus holds. */
  sha256: string;
  /** Ciphertext length. What the platform paid for. */
  bytes: number;
  createdAtMs: number;
}

export interface Recalled extends Remembered {
  /** The plaintext, byte for byte as it was remembered. */
  plaintext: Uint8Array;
}

/**
 * Derive the X25519 pair from a signature over `KEY_STATEMENT`.
 *
 * The signature is hashed, never used as the key, and the statement is the SDK's constant — the
 * same bytes a person signs in the browser to read their messages. See the module header for why
 * that sharing is a property and not an accident.
 */
export async function deriveMindKey(sign: MindSigner): Promise<Reading<MindKeyPair>> {
  const source = 'mind key';
  let signature: string;
  try {
    signature = await sign(new TextEncoder().encode(KEY_STATEMENT));
  } catch (error) {
    return fail('malformed', source, `the signer refused: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof signature !== 'string' || signature.trim() === '') {
    return fail('malformed', source, 'the signer returned no signature');
  }
  const secret = deriveSecret(signature.trim());
  return ok({ secret, x25519Public: toB64(publicFromSecret(secret)) });
}

/** What the registry holds for an address, folded to the three states a caller acts on. */
export type RegistryState =
  | { kind: 'absent' }
  | { kind: 'same' }
  | { kind: 'different'; published: string; version: bigint };

/**
 * Compare the derived public key with the one the registry holds for this address.
 *
 * Read from chain, never assumed: `remember` refuses unless the registry names the key it is
 * about to encrypt to, because a blob encrypted to a key the registry does not name is a blob the
 * agent cannot prove is its own, and — worse — a blob encrypted to a superseded key is one the
 * agent's other device cannot open.
 */
export async function registryStateFor(input: {
  client: SuiGrpcClient;
  keyRegistryId: string;
  address: string;
  x25519Public: string;
}): Promise<Reading<RegistryState>> {
  const table = await readKeyRegistryTableId(input.client, input.keyRegistryId);
  if (!table.ok) return table;
  const published = await readPublishedKey(input.client, table.value, input.address);
  if (!published.ok) return published;
  if (published.value === null) return ok({ kind: 'absent' });
  const held = toB64(published.value.x25519Public);
  if (held === input.x25519Public) return ok({ kind: 'same' });
  return ok({ kind: 'different', published: held, version: published.value.version });
}

/** `key_registry::publish`, built through the SDK — the one builder the browser also uses. */
export function buildPublishKey(
  config: ProjectXSocialConfig,
  args: { keyRegistryId: string; x25519Public: string },
): Transaction {
  return sdkTx.publishEncryptionKey({ config }, { keyRegistryId: args.keyRegistryId, x25519Public: fromB64(args.x25519Public) });
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Encrypt a mind to its owner and nobody else, and say what the statement must bind.
 *
 * Exactly ONE envelope, the agent's own. The messaging scheme wraps for every participant; a mind
 * has one. A payload with a second envelope is a mind somebody else can open, and the server refuses
 * it too (`lib/mind.ts`), so a drift here fails loudly rather than leaking quietly.
 */
export function sealMind(input: {
  address: string;
  x25519Public: string;
  plaintext: Uint8Array;
}): { payload: EncryptedPayload; sha256: string; bytes: number } {
  const payload = encryptBytes(input.plaintext, [{ address: input.address, x25519Public: input.x25519Public }]);
  const ciphertext = fromB64(payload.ciphertext);
  return { payload, sha256: sha256Hex(ciphertext), bytes: ciphertext.length };
}

/** How long one aggregator gets before the next is tried. */
export const AGGREGATOR_TIMEOUT_MS = 20_000;

/**
 * Fetch a blob from the first public aggregator that serves it. Bounded by the list's length and
 * by one deadline per aggregator; a blob nobody serves is `not-found`, a blob every aggregator
 * failed to serve is `transport` with the last reason.
 */
export async function fetchBlob(input: {
  blobId: string;
  aggregators: readonly string[];
  doFetch: FetchLike;
}): Promise<Reading<Uint8Array>> {
  const source = `Walrus blob ${input.blobId}`;
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(input.blobId)) return fail('malformed', source, 'that is not a Walrus blob id');
  let last = 'no aggregator was configured';
  let missing = 0;
  for (const base of input.aggregators) {
    try {
      const response = await input.doFetch(`${base.replace(/\/+$/, '')}/v1/blobs/${input.blobId}`, {
        method: 'GET',
        signal: AbortSignal.timeout(AGGREGATOR_TIMEOUT_MS),
      });
      if (response.status === 404) {
        missing += 1;
        last = `${base} does not hold it`;
        continue;
      }
      if (!response.ok) {
        last = `${base} answered ${response.status}`;
        continue;
      }
      return ok(new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      last = `${base}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  // Every aggregator that answered said 404: the lease has ended or the blob never certified.
  if (missing > 0 && missing === input.aggregators.length) {
    return fail('not-found', source, 'no aggregator holds this blob; its storage lease may have expired');
  }
  return fail('transport', source, last);
}

/**
 * Open a recalled blob: hash first, then decrypt. Bytes that are not the bytes are refused, not
 * raised — a `Reading` of kind `malformed` with both hashes, per the desk's rule for this module.
 */
export function openMind(input: {
  address: string;
  secret: Uint8Array;
  ciphertext: Uint8Array;
  expectedSha256: string;
  nonce: string;
  envelope: Envelope;
}): Reading<Uint8Array> {
  const source = 'mind';
  const digest = sha256Hex(input.ciphertext);
  if (digest !== input.expectedSha256) {
    return fail('malformed', source, `the aggregator served bytes with sha256 ${digest}; the record says ${input.expectedSha256}. Refused.`);
  }
  const plaintext = decryptBytes(
    { ciphertext: toB64(input.ciphertext), nonce: input.nonce, envelopes: [input.envelope] },
    input.address,
    input.secret,
  );
  if (plaintext === null) {
    return fail(
      'malformed',
      source,
      'this key cannot open the mind: it was remembered under a different key (rotated since?), or the envelope is not this agent’s.',
    );
  }
  return ok(plaintext);
}

export { PUBLIC_WALRUS_AGGREGATORS };
