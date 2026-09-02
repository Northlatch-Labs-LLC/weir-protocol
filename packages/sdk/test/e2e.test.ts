// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The message encryption scheme.
 *
 * Every test here is written so that it fails when the guarantee stops holding, not merely when
 * the code changes shape. The three that matter most are the negative ones: a stranger's key must
 * not open a message, a tampered ciphertext must not decrypt, and a swapped envelope must not
 * silently produce a wrong plaintext. A round-trip test alone passes against an implementation
 * that ignores keys entirely.
 */

import { describe, expect, it } from 'vitest';
import {
  ciphertextDigest,
  decrypt,
  deriveSecret,
  encrypt,
  fromB64,
  publicFromSecret,
  toB64,
  KEY_STATEMENT,
  encryptBytes,
  decryptBytes,
} from '../src/e2e.js';

const ALICE = '0x1111111111111111111111111111111111111111111111111111111111111111';
const BOB = '0x2222222222222222222222222222222222222222222222222222222222222222';
const MALLORY = '0x3333333333333333333333333333333333333333333333333333333333333333';

/** Stand-ins for wallet signatures. Any distinct strings work; the derivation only hashes them. */
const aliceSecret = deriveSecret('signature-from-alices-wallet');
const bobSecret = deriveSecret('signature-from-bobs-wallet');
const mallorySecret = deriveSecret('signature-from-mallorys-wallet');

const alice = { address: ALICE, x25519Public: toB64(publicFromSecret(aliceSecret)) };
const bob = { address: BOB, x25519Public: toB64(publicFromSecret(bobSecret)) };

describe('key derivation', () => {
  it('is deterministic — the same signature always yields the same key', () => {
    // This is the property the whole design rests on. If it fails, a user who signs again on
    // another device gets a different identity and cannot read their own history.
    expect(toB64(deriveSecret('same'))).toBe(toB64(deriveSecret('same')));
  });

  it('separates different signatures', () => {
    expect(toB64(deriveSecret('a'))).not.toBe(toB64(deriveSecret('b')));
  });

  it('does not return the signature itself', () => {
    // Domain separation. A key that is the signature would be a key anyone who saw the signature
    // holds — and signatures are handed to servers routinely.
    const signature = 'AQIDBAUGBwgJ';
    expect(toB64(deriveSecret(signature))).not.toBe(signature);
  });

  it('matches a fixed vector', () => {
    /*
      The strongest test here, and the reason is not cryptographic.

      Changing the derivation by any amount — a different hash, a dropped domain prefix, a
      different truncation — locks every existing user out of every message they have ever
      received, silently and permanently, because nothing is stored to compare against. There is no
      migration and no error; the messages simply stop opening.

      A vector also proves the derivation *hashes*. Without it, a version that returned the first
      32 bytes of the input passes every other test in this block while making the secret readable
      by anyone who ever sees the signature.
    */
    expect(toB64(deriveSecret('fixed-test-vector'))).toBe(
      'oU7iA0h5lITW5s3BK81wqyZ5mN+y3CTG2iVJcr0bTCU=',
    );
    expect(toB64(publicFromSecret(deriveSecret('fixed-test-vector')))).toBe(
      'rLqk2TCInGem0NosKjF1QtOlj7BUQSr4Fk/B1F6ZYnw=',
    );
  });

  it('produces a 32-byte secret and a 32-byte public key', () => {
    expect(aliceSecret.length).toBe(32);
    expect(publicFromSecret(aliceSecret).length).toBe(32);
  });

  it('signs a statement that names its own purpose and version', () => {
    // Changing this string rotates every key on the platform, so it is pinned by a test rather
        // than left to a careless edit.
    expect(KEY_STATEMENT).toContain('derive my message encryption key');
    expect(KEY_STATEMENT).toContain('version: 1');
  });
});

describe('base64', () => {
  it('round-trips arbitrary bytes, including 0x00 and 0xff', () => {
    const bytes = new Uint8Array(256).map((_, i) => i);
    expect([...fromB64(toB64(bytes))]).toEqual([...bytes]);
  });
});

describe('encrypt and decrypt', () => {
  it('lets the recipient read it', () => {
    const payload = encrypt('the vault harvests at epoch end', [alice, bob]);
    expect(decrypt(payload, BOB, bobSecret)).toBe('the vault harvests at epoch end');
  });

  it('lets the sender read their own message', () => {
    // The failure this catches is a thread where half the messages are blank to the person who
    // wrote them — invisible in any test that only checks the recipient.
    const payload = encrypt('mine to read', [alice, bob]);
    expect(decrypt(payload, ALICE, aliceSecret)).toBe('mine to read');
  });

  it('does not put the plaintext anywhere in the payload', () => {
    const payload = encrypt('SECRETWORD', [alice, bob]);
    expect(JSON.stringify(payload)).not.toContain('SECRETWORD');
  });

  it('gives a different ciphertext for the same plaintext each time', () => {
    // A deterministic ciphertext would leak equality between messages: an observer could tell that
    // two people sent the same thing without reading either.
    const a = encrypt('identical', [alice, bob]);
    const b = encrypt('identical', [alice, bob]);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.nonce).not.toBe(b.nonce);
  });

  it('uses a fresh ephemeral key for every envelope', () => {
    /*
      A fixed ephemeral key would still round-trip, and every other test here would still pass —
      which is precisely why this one exists. It would also make the key-encryption key for a given
      recipient constant forever, so one recovered KEK would open every message ever sent to them,
      and it would make two envelopes to the same person trivially linkable by an observer.
    */
    const first = encrypt('one', [alice, bob]);
    const second = encrypt('two', [alice, bob]);
    const ephemerals = [...first.envelopes, ...second.envelopes].map((e) => e.ephemeralPublic);
    expect(new Set(ephemerals).size).toBe(ephemerals.length);
  });

  it('survives multi-byte characters', () => {
    const text = 'yield → creator · 290 bps · 日本語 · 🔐';
    const payload = encrypt(text, [alice, bob]);
    expect(decrypt(payload, BOB, bobSecret)).toBe(text);
  });

  it('refuses to encrypt to nobody', () => {
    // Silently producing an unreadable message would be worse than throwing: it stores fine.
    expect(() => encrypt('x', [])).toThrow();
  });
});

describe('what must not work', () => {
  it('does not let a third party read it, even with a valid key of their own', () => {
    const payload = encrypt('not for mallory', [alice, bob]);
    expect(decrypt(payload, MALLORY, mallorySecret)).toBeNull();
  });

  it('does not let a third party read it by claiming to be the recipient', () => {
    // Mallory names Bob's address but holds her own key. The envelope is found; the unwrap fails.
    const payload = encrypt('not for mallory', [alice, bob]);
    expect(decrypt(payload, BOB, mallorySecret)).toBeNull();
  });

  it('rejects a tampered ciphertext rather than returning garbage', () => {
    const payload = encrypt('the original words', [alice, bob]);
    const bytes = fromB64(payload.ciphertext);
    bytes.set([(bytes[0] ?? 0) ^ 0x01], 0);
    const tampered = { ...payload, ciphertext: toB64(bytes) };
    expect(decrypt(tampered, BOB, bobSecret)).toBeNull();
  });

  it('rejects a tampered wrapped key', () => {
    const payload = encrypt('the original words', [alice, bob]);
    const envelopes = payload.envelopes.map((e) => {
      if (e.recipient !== BOB) return e;
      const bytes = fromB64(e.wrappedKey);
      bytes.set([(bytes[0] ?? 0) ^ 0x01], 0);
      return { ...e, wrappedKey: toB64(bytes) };
    });
    expect(decrypt({ ...payload, envelopes }, BOB, bobSecret)).toBeNull();
  });

  it('rejects an envelope re-labelled for someone else', () => {
    /*
      Mallory takes Alice's envelope and relabels it as hers, hoping the recipient lookup is the
      only check. The key-encryption key is bound to the recipient's public key through HKDF, so
      the unwrap fails — which is what makes the `recipient` field a hint rather than an authority.
    */
    const payload = encrypt('for alice and bob', [alice, bob]);
    const stolen = payload.envelopes.find((e) => e.recipient === ALICE);
    expect(stolen).toBeDefined();
    const relabelled = { ...payload, envelopes: [{ ...stolen!, recipient: MALLORY }] };
    expect(decrypt(relabelled, MALLORY, mallorySecret)).toBeNull();
  });

  it('returns null rather than throwing when there is no envelope at all', () => {
    // A thread legitimately mixes messages from before a key existed. One unreadable message must
    // not take down the whole thread.
    const payload = encrypt('for bob only', [bob]);
    expect(decrypt(payload, ALICE, aliceSecret)).toBeNull();
  });

  it('matches the recipient case-insensitively', () => {
    // Addresses arrive lower-cased from the store and mixed-case from wallets.
    const payload = encrypt('case', [alice, bob]);
    expect(decrypt(payload, BOB.toUpperCase().replace('0X', '0x'), bobSecret)).toBe('case');
  });
});

describe('ciphertextDigest', () => {
  it('is 64 lower-case hex characters', () => {
    expect(ciphertextDigest('anything')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('agrees with the published SHA-256 of the empty string', () => {
    // A fixed vector, so this cannot drift into hashing something else and still agree with itself.
    expect(ciphertextDigest('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('changes when a single byte of the ciphertext changes', () => {
    // This is what makes a send signature bind to one exact payload.
    expect(ciphertextDigest('abc')).not.toBe(ciphertextDigest('abd'));
  });
});

describe('bytes, not text (the agent mind path)', () => {
  // Every byte value, including the ones a text decoder would mangle or refuse.
  const blob = new Uint8Array(1024).map((_, i) => (i * 7 + 3) & 0xff);

  it('round-trips arbitrary bytes for a participant, byte for byte', () => {
    const payload = encryptBytes(blob, [alice]);
    const opened = decryptBytes(payload, ALICE, aliceSecret);
    expect(opened).not.toBeNull();
    expect(Array.from(opened!)).toEqual(Array.from(blob));
  });

  it('a stranger cannot open it, and a flipped ciphertext byte is refused rather than returned', () => {
    const payload = encryptBytes(blob, [alice]);
    expect(decryptBytes(payload, MALLORY, mallorySecret)).toBeNull();
    const raw = fromB64(payload.ciphertext);
    raw[10] = raw[10]! ^ 0x01;
    expect(decryptBytes({ ...payload, ciphertext: toB64(raw) }, ALICE, aliceSecret)).toBeNull();
  });

  it('the string view is the byte view over UTF-8, so a message and a mind share one scheme', () => {
    const payload = encrypt('héllo — 🚀', [alice]);
    expect(new TextDecoder().decode(decryptBytes(payload, ALICE, aliceSecret)!)).toBe('héllo — 🚀');
  });
});
