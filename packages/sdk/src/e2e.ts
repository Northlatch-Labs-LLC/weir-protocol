// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * End-to-end encryption for direct messages — and, since B16, for an agent's mind.
 *
 * Pure functions, no `server-only` — the whole point is that this runs in the browser, in a
 * headless agent and never on the server: the server never sees a plaintext or a private key.
 *
 * # Hoisted from `packages/web/lib/e2e.ts` on 2026-09-02
 *
 * Moved here whole, as `statements.ts` was, rather than copied: an agent that encrypts its memory
 * with a copy of this scheme is one drift away from a memory nobody can open. `packages/web/lib/e2e.ts`
 * re-exports these symbols and formats nothing of its own. The tests moved with it
 * (`packages/sdk/test/e2e.test.ts`) and are unchanged.
 *
 * # Where the key comes from
 *
 * A Sui address is a hash of a public key, so you cannot encrypt to an address. And an Ed25519
 * signing key is not an encryption key. So each participant derives a separate X25519 keypair from
 * a signature over one fixed statement:
 *
 *   secret = sha512("projectx-e2e-v1" ‖ signature)[0..32]
 *
 * Ed25519 signatures are deterministic (RFC 8032) — the same key over the same message always
 * produces the same bytes — so the user can reproduce this key on any device by signing the same
 * statement again. Nothing is stored, and there is no key to back up or lose, only a wallet.
 *
 * ## The limitation this carries, stated rather than discovered
 *
 * **zkLogin signatures are not deterministic.** They wrap an ephemeral key that changes each
 * session, so a zkLogin user derives a different X25519 key every time and cannot read their own
 * history. This scheme therefore works for keypair wallets and not for zkLogin, and the UI must
 * say so rather than silently producing an account whose messages become unreadable tomorrow.
 * Fixing it properly means a key wrapped under something stable — out of scope here, and named
 * so it is not mistaken for solved.
 *
 * # The scheme
 *
 * Hybrid, per message:
 *
 *   1. A random 32-byte message key encrypts the payload with XChaCha20-Poly1305.
 *   2. That key is wrapped once per participant — the recipient **and the sender** — using an
 *      ephemeral X25519 key and ECDH against their published public key.
 *
 * Wrapping for the sender too is what lets them read what they wrote. Encrypting only to the
 * recipient produces a thread where half the messages are unreadable to the person who sent them.
 *
 * # What is still visible to the server
 *
 * Content is not. **Metadata is**: who is talking to whom, when, and how much. Encrypting the
 * bodies does not hide the social graph, and claiming otherwise would be the same overstatement
 * this replaces.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';

/**
 * The statement a user signs to derive their encryption key. Changing it rotates every key.
 *
 * # It still says "ProjectX Social" after the Weir rebrand, and it must
 *
 * This is not copy. It is the HKDF input, so the text *is* the key: rewrite the brand here and
 * every user derives a different x25519 pair on their next sign-in. Their existing messages become
 * permanently unreadable — the plaintext is gone, not hidden — and every entry already published to
 * the on-chain `key_registry` names a public key nobody can produce the private half for any more.
 *
 * A rebrand sweep looking for the old name will find this line. Leave it. If the name here must
 * ever change it is a migration with a version bump and a re-publish, not a find-and-replace —
 * which is what `version: 1` below exists for.
 */
export const KEY_STATEMENT =
  'ProjectX Social — derive my message encryption key\n' +
  'version: 1\n' +
  'This signature never leaves your device and authorises nothing.';

const DOMAIN = 'projectx-e2e-v1';
const NONCE_BYTES = 24;

export interface Envelope {
  /** Whose key this is wrapped for. Lower-cased, zero-padded Sui address. */
  recipient: string;
  /** Ephemeral X25519 public key for this wrap, base64. */
  ephemeralPublic: string;
  nonce: string;
  wrappedKey: string;
}

export interface EncryptedPayload {
  ciphertext: string;
  nonce: string;
  envelopes: Envelope[];
}

// --- base64 without Buffer, so this works unchanged in the browser ---

export function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i += 1) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * SHA-256 of a base64 ciphertext, lower-case hex.
 *
 * What a send signature binds to. Defined here, once, so the client and the server cannot drift
 * into hashing different things — a mismatch would reject every encrypted message, and a *matching*
 * mismatch (both sides changed) would silently stop binding anything.
 */
export function ciphertextDigest(ciphertext: string): string {
  return Array.from(sha256(new TextEncoder().encode(ciphertext)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Derive the X25519 secret from a wallet signature over {@link KEY_STATEMENT}.
 *
 * The signature is hashed with a domain separator rather than used directly, so the stored key
 * cannot be confused with, or substituted for, the signature itself.
 */
export function deriveSecret(signature: string): Uint8Array {
  const material = new TextEncoder().encode(`${DOMAIN}:${signature}`);
  return sha512(material).slice(0, 32);
}

export function publicFromSecret(secret: Uint8Array): Uint8Array {
  return x25519.getPublicKey(secret);
}

/**
 * A key-encryption key from an ECDH shared secret.
 *
 * HKDF rather than the raw shared point: a raw X25519 output is not uniformly distributed and
 * should never be used directly as a symmetric key. That part is load-bearing.
 *
 * The `info` binding — the ephemeral public key and the recipient's — is **not**. A mutation test
 * that removes it leaves every test in `test/e2e.test.ts` passing, and that is a correct result
 * rather than a gap in the tests: each envelope already uses a fresh random ephemeral key, so the
 * shared secret is unique per envelope without any help. The binding is kept because it costs
 * nothing and it is what stops the KEK repeating if a future change ever reuses an ephemeral key
 * across envelopes — a failure that would otherwise be invisible. It is defence in depth, and it is
 * labelled as such rather than left to look like a guarantee something checks.
 */
function kek(shared: Uint8Array, ephemeralPublic: Uint8Array, recipient: Uint8Array): Uint8Array {
  const info = new Uint8Array(ephemeralPublic.length + recipient.length);
  info.set(ephemeralPublic, 0);
  info.set(recipient, ephemeralPublic.length);
  return hkdf(sha256, shared, new TextEncoder().encode(DOMAIN), info, 32);
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/**
 * Encrypt a message to a set of participants.
 *
 * `participants` must include the sender. It is not added implicitly, because a silent addition is
 * exactly the kind of thing that later gets refactored away — and the failure is invisible until
 * someone reopens their own thread and finds it blank.
 */
export function encrypt(
  plaintext: string,
  participants: ReadonlyArray<{ address: string; x25519Public: string }>,
): EncryptedPayload {
  return encryptBytes(new TextEncoder().encode(plaintext), participants);
}

/**
 * The same scheme over raw bytes. A message is text; an agent's mind is whatever the agent keeps —
 * a tarball, a JSON dump, a database file — and it must not be forced through a text decoder on
 * the way in or out. `encrypt`/`decrypt` are the string views over these two.
 */
export function encryptBytes(
  plaintext: Uint8Array,
  participants: ReadonlyArray<{ address: string; x25519Public: string }>,
): EncryptedPayload {
  if (participants.length === 0) throw new Error('no participants to encrypt to');

  const messageKey = randomBytes(32);
  const nonce = randomBytes(NONCE_BYTES);
  const ciphertext = xchacha20poly1305(messageKey, nonce).encrypt(plaintext);

  const envelopes = participants.map(({ address, x25519Public }) => {
    const recipientPublic = fromB64(x25519Public);
    const ephemeralSecret = randomBytes(32);
    const ephemeralPublic = x25519.getPublicKey(ephemeralSecret);
    const shared = x25519.getSharedSecret(ephemeralSecret, recipientPublic);
    const wrapNonce = randomBytes(NONCE_BYTES);
    const wrapped = xchacha20poly1305(
      kek(shared, ephemeralPublic, recipientPublic),
      wrapNonce,
    ).encrypt(messageKey);

    return {
      recipient: address,
      ephemeralPublic: toB64(ephemeralPublic),
      nonce: toB64(wrapNonce),
      wrappedKey: toB64(wrapped),
    };
  });

  return { ciphertext: toB64(ciphertext), nonce: toB64(nonce), envelopes };
}

/**
 * Decrypt a message, or return `null` when this key cannot open it.
 *
 * `null` rather than a thrown error: a thread legitimately contains messages encrypted before this
 * device registered a key, and a throw would take down the whole thread rather than showing the
 * one message as unreadable.
 */
export function decrypt(
  payload: EncryptedPayload,
  viewer: string,
  secret: Uint8Array,
): string | null {
  const bytes = decryptBytes(payload, viewer, secret);
  return bytes === null ? null : new TextDecoder().decode(bytes);
}

/** See {@link encryptBytes}. `null` for exactly the reasons `decrypt` gives. */
export function decryptBytes(
  payload: EncryptedPayload,
  viewer: string,
  secret: Uint8Array,
): Uint8Array | null {
  const envelope = payload.envelopes.find(
    (e) => e.recipient.toLowerCase() === viewer.toLowerCase(),
  );
  if (envelope === undefined) return null;

  try {
    const ephemeralPublic = fromB64(envelope.ephemeralPublic);
    const shared = x25519.getSharedSecret(secret, ephemeralPublic);
    const messageKey = xchacha20poly1305(
      kek(shared, ephemeralPublic, publicFromSecret(secret)),
      fromB64(envelope.nonce),
    ).decrypt(fromB64(envelope.wrappedKey));

    return xchacha20poly1305(messageKey, fromB64(payload.nonce)).decrypt(
      fromB64(payload.ciphertext),
    );
  } catch {
    // A wrong key, a tampered ciphertext, or an envelope from a rotated key. All three mean this
    // message is not readable here, and none of them should be dressed up as a decryption.
    return null;
  }
}
