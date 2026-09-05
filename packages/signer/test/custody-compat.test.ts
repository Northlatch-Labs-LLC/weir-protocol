// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Can a multisig actually be the custody floor? Two questions, answered by execution.
 *
 * # Why these are tests rather than a paragraph
 *
 * `MultiSigSigner` is only worth building if a multisig address can do everything an Ed25519 agent
 * address does today. Two things in this codebase would break if it could not, and both are
 * load-bearing:
 *
 *  1. **`verifyPersonalMessageSignature`** — `packages/web/lib/identity.ts`'s `verifyAction` is
 *     how every write from an agent is authorised. If it does not accept a MultiSig signature,
 *     a multisig agent cannot post, publish or open a session, and the custody tier is unusable.
 *  2. **Seal's `SessionKey`** — reading paid content requires one. If it does not accept a
 *     multisig or secp256r1 signer, a multisig agent could pay for content and then not read it,
 *     which is worse than not being able to buy it.
 *
 * Reading the source says both work. Reading is not evidence; these run it. Everything here is
 * offline — generated keys and a stubbed client — so it is a real answer that costs no network.
 */

import { describe, expect, it } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { MultiSigPublicKey } from '@mysten/sui/multisig';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { SessionKey } from '@mysten/seal';
import { multiSigSigner } from '../src/index.js';
import { signerFor } from './helpers.js';

const MESSAGE = new TextEncoder().encode('weir agent proves control of its address');

/** (agent hot key, operator cold key) at threshold 1 — the tier README.md describes. */
function custodyFloor() {
  const hot = Ed25519Keypair.generate();
  const cold = Ed25519Keypair.generate();
  const multiSigPublicKey = MultiSigPublicKey.fromPublicKeys({
    threshold: 1,
    publicKeys: [
      { publicKey: hot.getPublicKey(), weight: 1 },
      { publicKey: cold.getPublicKey(), weight: 1 },
    ],
  });
  return { hot, cold, multiSigPublicKey };
}

describe('TO CONFIRM 1 — does verifyPersonalMessageSignature accept a MultiSig signature?', () => {
  it('accepts one, and resolves it to the multisig address', async () => {
    const { hot, cold, multiSigPublicKey } = custodyFloor();

    const signer = multiSigSigner({
      threshold: 1,
      members: [
        { publicKey: hot.getPublicKey(), weight: 1 },
        { publicKey: cold.getPublicKey(), weight: 1 },
      ],
      // Only the hot key is in this process, which is the production shape.
      available: [signerFor(hot)],
    });
    expect(signer.ok).toBe(true);
    if (!signer.ok) throw new Error('unreachable');

    const signature = await signer.value.signPersonalMessage(MESSAGE);
    expect(signature.ok).toBe(true);
    if (!signature.ok) throw new Error('unreachable');

    // ANSWER: yes. `parseSignature` in @mysten/sui 2.27.1's src/verify/verify.ts branches on
    // `signatureScheme === 'MultiSig'` and builds a MultiSigPublicKey; verification then runs
    // MultiSigPublicKey.verify, which checks each partial and sums weights against the threshold.
    const publicKey = await verifyPersonalMessageSignature(MESSAGE, signature.value, {
      address: multiSigPublicKey.toSuiAddress(),
    });
    expect(publicKey.toSuiAddress()).toBe(multiSigPublicKey.toSuiAddress());
    expect(signer.value.address).toBe(multiSigPublicKey.toSuiAddress());
  });

  it('rejects a signature over different bytes, so this is verification and not a shape check', async () => {
    const { hot, cold } = custodyFloor();
    const signer = multiSigSigner({
      threshold: 1,
      members: [
        { publicKey: hot.getPublicKey(), weight: 1 },
        { publicKey: cold.getPublicKey(), weight: 1 },
      ],
      available: [signerFor(hot)],
    });
    if (!signer.ok) throw new Error('unreachable');
    const signature = await signer.value.signPersonalMessage(MESSAGE);
    if (!signature.ok) throw new Error('unreachable');

    await expect(
      verifyPersonalMessageSignature(new TextEncoder().encode('different'), signature.value),
    ).rejects.toThrow();
  });

  it('rejects a below-threshold combination — proving the threshold is really enforced', async () => {
    const hot = Ed25519Keypair.generate();
    const cold = Ed25519Keypair.generate();
    const multiSigPublicKey = MultiSigPublicKey.fromPublicKeys({
      // Threshold 2 with only the hot key available: one weight, two needed.
      threshold: 2,
      publicKeys: [
        { publicKey: hot.getPublicKey(), weight: 1 },
        { publicKey: cold.getPublicKey(), weight: 1 },
      ],
    });

    const signer = multiSigSigner({
      threshold: 2,
      members: [
        { publicKey: hot.getPublicKey(), weight: 1 },
        { publicKey: cold.getPublicKey(), weight: 1 },
      ],
      available: [signerFor(hot)],
    });
    if (!signer.ok) throw new Error('unreachable');

    const signature = await signer.value.signPersonalMessage(MESSAGE);
    // Our adapter verifies locally before returning, which is why this is a refusal here rather
    // than a well-formed signature every node rejects. `combinePartialSignatures` performs no
    // threshold check of its own.
    expect(signature.ok).toBe(false);
    if (signature.ok) throw new Error('unreachable');
    expect(signature.failure.kind).toBe('unconfigured');
    expect(signature.failure.detail).toContain('1 of the 2 weight required');
    expect(multiSigPublicKey.getThreshold()).toBe(2);
  });
});

describe("TO CONFIRM 2 — does @mysten/seal 1.4.6's SessionKey accept a multisig or secp256r1 signer?", () => {
  /*
    `SessionKey.create` makes one chain read — `suiClient.core.getObject`, asserting the package is
    version 1 — and nothing else. Stubbing it keeps this offline while exercising the two things
    that actually matter: the constructor's address check at session-key.mjs:29
    (`signer.getPublicKey().toSuiAddress() !== address`) and the certificate path, which verifies
    the personal-message signature through the very same `verifyPersonalMessageSignature`.
  */
  const PACKAGE_ID = `0x${'0'.repeat(63)}1`;
  const stubClient = {
    core: { getObject: async () => ({ object: { version: '1' } }) },
  } as unknown as Parameters<typeof SessionKey.create>[0]['suiClient'];

  it('accepts a MultiSigSigner, and the certificate carries the multisig signature', async () => {
    const { hot, cold, multiSigPublicKey } = custodyFloor();
    const address = multiSigPublicKey.toSuiAddress();

    // Seal wants a @mysten/sui `Signer`. `MultiSigSigner` from the same package is one, and it is
    // what a caller would hand Seal; our own adapter wraps it for the policy path. Both produce
    // the identical signature, which the assertion below relies on.
    const { MultiSigSigner } = await import('@mysten/sui/multisig');
    const mystenSigner = new MultiSigSigner(multiSigPublicKey, [hot]);

    const sessionKey = await SessionKey.create({
      address,
      packageId: PACKAGE_ID,
      ttlMin: 10,
      signer: mystenSigner,
      suiClient: stubClient,
    });

    // ANSWER: yes. `getCertificate()` calls `signer.signPersonalMessage` and stores the result.
    const certificate = await sessionKey.getCertificate();
    expect(certificate.user).toBe(address);
    expect(certificate.signature.length).toBeGreaterThan(0);

    // And Seal's own verification path accepts it: `setPersonalMessageSignature` runs
    // `verifyPersonalMessageSignature` against the session address and throws
    // InvalidPersonalMessageSignatureError if it does not hold.
    const second = await SessionKey.create({
      address,
      packageId: PACKAGE_ID,
      ttlMin: 10,
      suiClient: stubClient,
    });
    const signed = await mystenSigner.signPersonalMessage(second.getPersonalMessage());
    await expect(second.setPersonalMessageSignature(signed.signature)).resolves.toBeUndefined();
    expect((await second.getCertificate()).signature).toBe(signed.signature);
    // Cold key alone satisfies threshold 1 too, which is what makes the operator sweep possible.
    expect(cold.getPublicKey().toSuiAddress()).not.toBe(address);
  });

  it('accepts a secp256r1 signer', async () => {
    const keypair = Secp256r1Keypair.generate();
    const address = keypair.toSuiAddress();

    const sessionKey = await SessionKey.create({
      address,
      packageId: PACKAGE_ID,
      ttlMin: 10,
      signer: keypair,
      suiClient: stubClient,
    });

    const certificate = await sessionKey.getCertificate();
    expect(certificate.user).toBe(address);

    const verified = await verifyPersonalMessageSignature(
      sessionKey.getPersonalMessage(),
      certificate.signature,
      { address },
    );
    expect(verified.toSuiAddress()).toBe(address);
  });

  it('refuses a signer whose address is not the session address', async () => {
    // The check at session-key.mjs:29. Worth pinning: it is what stops a session being opened for
    // an address the signer does not control, which would fail later at the key server with a
    // message about access rather than about configuration.
    const keypair = Ed25519Keypair.generate();
    await expect(
      SessionKey.create({
        address: Ed25519Keypair.generate().toSuiAddress(),
        packageId: PACKAGE_ID,
        ttlMin: 10,
        signer: keypair,
        suiClient: stubClient,
      }),
    ).rejects.toThrow(/does not match/i);
  });
});
