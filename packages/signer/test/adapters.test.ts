// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The four adapters.
 *
 * Every key here is generated in this process and discarded. Nothing reads the operator's real
 * `~/.sui/sui_config/sui.keystore`: a test that did would only pass on one machine and would pull
 * real private keys into a process whose output is captured.
 */

import { describe, expect, it } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import {
  kmsSigner,
  localKeypairSignerFromKeystore,
  localKeypairSignerFromSecret,
  multiSigSigner,
  readOnlySigner,
} from '../src/index.js';
import { signerFor, writeKeystore } from './helpers.js';

const MESSAGE = new TextEncoder().encode('hello');

describe('LocalKeypairSigner from a bech32 secret', () => {
  it('loads an Ed25519 key and signs a verifiable personal message', async () => {
    const keypair = Ed25519Keypair.generate();
    const signer = localKeypairSignerFromSecret(keypair.getSecretKey());
    expect(signer.ok).toBe(true);
    if (!signer.ok) throw new Error('unreachable');

    expect(signer.value.address).toBe(keypair.toSuiAddress());
    expect(signer.value.scheme).toBe('ed25519');

    const signature = await signer.value.signPersonalMessage(MESSAGE);
    if (!signature.ok) throw new Error('unreachable');
    const publicKey = await verifyPersonalMessageSignature(MESSAGE, signature.value, {
      address: keypair.toSuiAddress(),
    });
    expect(publicKey.toSuiAddress()).toBe(keypair.toSuiAddress());
  });

  it('takes the scheme from the encoding, so a secp256r1 key is not loaded as Ed25519', () => {
    const keypair = Secp256r1Keypair.generate();
    const signer = localKeypairSignerFromSecret(keypair.getSecretKey());
    if (!signer.ok) throw new Error('unreachable');
    expect(signer.value.scheme).toBe('secp256r1');
    expect(signer.value.address).toBe(keypair.toSuiAddress());
  });

  it('never quotes the secret in a failure', () => {
    const secret = 'suiprivkey1thisisnotarealkeyandmustnotappearinanymessage';
    const signer = localKeypairSignerFromSecret(secret);
    expect(signer.ok).toBe(false);
    if (signer.ok) throw new Error('unreachable');
    // The whole point: a crypto library's parse error routinely includes the offending value, and
    // that value ends up in a log aggregator.
    expect(signer.failure.detail).not.toContain(secret);
    expect(signer.failure.detail).toContain('deliberately not shown');
  });

  it('refuses raw hex, which is indistinguishable from a public key or an object id', () => {
    const raw = `0x${'11'.repeat(32)}`;
    expect(localKeypairSignerFromSecret(raw).ok).toBe(false);
  });

  it('reports an empty secret as unconfigured rather than as a parse failure', () => {
    const signer = localKeypairSignerFromSecret('   ');
    if (signer.ok) throw new Error('unreachable');
    expect(signer.failure.kind).toBe('unconfigured');
  });
});

describe('LocalKeypairSigner from a Sui CLI keystore', () => {
  it('finds the key for a named address among several', async () => {
    const wanted = Ed25519Keypair.generate();
    const others = [Ed25519Keypair.generate(), Ed25519Keypair.generate()];
    const path = await writeKeystore(
      [others[0]!, wanted, others[1]!].map((k) => decodeSuiPrivateKey(k.getSecretKey()).secretKey),
    );

    const signer = await localKeypairSignerFromKeystore({
      path,
      address: wanted.toSuiAddress(),
    });
    expect(signer.ok).toBe(true);
    if (!signer.ok) throw new Error('unreachable');
    expect(signer.value.address).toBe(wanted.toSuiAddress());
  });

  it('matches an address written without padding', async () => {
    const keypair = Ed25519Keypair.generate();
    const path = await writeKeystore([decodeSuiPrivateKey(keypair.getSecretKey()).secretKey]);
    const unpadded = `0x${keypair.toSuiAddress().slice(2).replace(/^0+/, '')}`;
    const signer = await localKeypairSignerFromKeystore({ path, address: unpadded });
    expect(signer.ok).toBe(true);
  });

  it('reports not-found without saying anything about the other entries', async () => {
    const path = await writeKeystore([
      decodeSuiPrivateKey(Ed25519Keypair.generate().getSecretKey()).secretKey,
      decodeSuiPrivateKey(Ed25519Keypair.generate().getSecretKey()).secretKey,
    ]);
    const missing = Ed25519Keypair.generate().toSuiAddress();
    const signer = await localKeypairSignerFromKeystore({ path, address: missing });
    if (signer.ok) throw new Error('unreachable');
    expect(signer.failure.kind).toBe('not-found');
    // A keystore inventory does not belong in a log.
    expect(signer.failure.detail).not.toMatch(/\b2\b/);
  });

  it('reports a missing keystore as unconfigured, not as a transport fault', async () => {
    const signer = await localKeypairSignerFromKeystore({
      path: '/nonexistent/sui.keystore',
      address: `0x${'1'.repeat(64)}`,
    });
    if (signer.ok) throw new Error('unreachable');
    // Retrying will not create the file.
    expect(signer.failure.kind).toBe('unconfigured');
  });
});

describe('ReadOnlySigner', () => {
  it('fails unconfigured on both signing calls, loudly and identically', async () => {
    const signer = readOnlySigner({
      address: `0x${'1'.repeat(64)}`,
      because: 'the cold key is held offline.',
    });

    for (const attempt of [
      await signer.signPersonalMessage(MESSAGE),
      await signer.signTransaction(MESSAGE),
    ]) {
      expect(attempt.ok).toBe(false);
      if (attempt.ok) throw new Error('unreachable');
      expect(attempt.failure.kind).toBe('unconfigured');
      expect(attempt.failure.detail).toContain('the cold key is held offline');
      expect(attempt.failure.detail).toContain('Nothing was signed');
    }
  });

  it('never silently succeeds, which is the entire reason it exists rather than a null signer', async () => {
    const signer = readOnlySigner({ address: `0x${'1'.repeat(64)}` });
    const attempt = await signer.signTransaction(MESSAGE);
    expect(attempt.ok).toBe(false);
  });
});

describe('KmsSigner', () => {
  it('refuses with no transport, naming what is missing', async () => {
    const signer = kmsSigner({ address: `0x${'2'.repeat(64)}` });
    const attempt = await signer.signTransaction(MESSAGE);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.failure.kind).toBe('unconfigured');
    expect(attempt.failure.detail).toContain('documented stub');
  });

  it('still refuses when a transport is supplied, rather than returning a plausible signature', async () => {
    // The honest state of the adapter. Returning something signature-shaped from an unimplemented
    // path is the class of defect this repository documents rather than ships.
    const signer = kmsSigner({
      address: `0x${'2'.repeat(64)}`,
      transport: {
        publicKey: async () => new Uint8Array(33),
        signDigest: async () => new Uint8Array(64),
      },
    });
    const attempt = await signer.signPersonalMessage(MESSAGE);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.failure.detail).toContain('no implementation');
  });
});

describe('MultiSigSigner configuration', () => {
  const hot = Ed25519Keypair.generate();
  const cold = Ed25519Keypair.generate();
  const members = [
    { publicKey: hot.getPublicKey(), weight: 1 },
    { publicKey: cold.getPublicKey(), weight: 1 },
  ];

  it('refuses a threshold no combination of weights could reach', () => {
    const signer = multiSigSigner({ threshold: 3, members, available: [signerFor(hot)] });
    if (signer.ok) throw new Error('unreachable');
    expect(signer.failure.detail).toContain('could never be signed for by anyone');
  });

  it('refuses a threshold of zero, which is an address anybody can sign for', () => {
    const signer = multiSigSigner({ threshold: 0, members, available: [signerFor(hot)] });
    expect(signer.ok).toBe(false);
  });

  it('refuses an available signer that is not a member, at construction rather than at 3am', () => {
    const stranger = signerFor(Ed25519Keypair.generate());
    const signer = multiSigSigner({ threshold: 1, members, available: [stranger] });
    if (signer.ok) throw new Error('unreachable');
    expect(signer.failure.detail).toContain('is not a member of this multisig');
  });

  it('refuses when no member key is available, pointing at readOnlySigner instead', () => {
    const signer = multiSigSigner({ threshold: 1, members, available: [] });
    if (signer.ok) throw new Error('unreachable');
    expect(signer.failure.detail).toContain('readOnlySigner()');
  });

  it('reports a member that could not sign, naming which one', async () => {
    const absent = readOnlySigner({ address: hot.toSuiAddress(), because: 'key is elsewhere.' });
    const signer = multiSigSigner({ threshold: 1, members, available: [absent] });
    if (!signer.ok) throw new Error('unreachable');
    const attempt = await signer.value.signPersonalMessage(MESSAGE);
    if (attempt.ok) throw new Error('unreachable');
    expect(attempt.failure.detail).toContain(hot.toSuiAddress());
    expect(attempt.failure.detail).toContain('key is elsewhere');
  });

  it('accepts either member alone at threshold 1 — which is what makes an operator sweep possible', async () => {
    for (const member of [hot, cold]) {
      const signer = multiSigSigner({ threshold: 1, members, available: [signerFor(member)] });
      if (!signer.ok) throw new Error('unreachable');
      const signature = await signer.value.signPersonalMessage(MESSAGE);
      expect(signature.ok, member.toSuiAddress()).toBe(true);
    }
  });

  it('gives the same address whichever member is holding it', () => {
    const a = multiSigSigner({ threshold: 1, members, available: [signerFor(hot)] });
    const b = multiSigSigner({ threshold: 1, members, available: [signerFor(cold)] });
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.value.address).toBe(b.value.address);
    // And it is not either member's own address — which is why the account, being soulbound,
    // must be opened at the multisig address from the very beginning. See README.md.
    expect(a.value.address).not.toBe(hot.toSuiAddress());
    expect(a.value.address).not.toBe(cold.toSuiAddress());
  });
});
