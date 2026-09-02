// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Proving the Node Seal path without spending a coin.
 *
 * # What this suite can prove, and what it cannot
 *
 * It cannot prove that a key server releases a key, and no amount of cleverness changes that: there
 * are no open Seal key servers on Sui mainnet, every provider is permissioned, and exercising one
 * against a real entitlement means buying content. So the network step sits behind the
 * {@link RecoverKey} seam and everything on both sides of it is proven here, offline and
 * deterministically:
 *
 * - the identity bytes, asserted against `entitlement.move` **and against the Move source's own
 *   constants**, so a change to either fails here;
 * - the approval transaction, asserted **byte-identical to `packages/web/lib/seal-open.ts`'s
 *   `approvalFor`** — the browser path this module ports — for both entitlement kinds;
 * - the whole decrypt pipeline end to end with a real AES-256-GCM blob, a stubbed aggregator and a
 *   stubbed committee: the plaintext comes back, a flipped byte fails on GCM's tag, and a
 *   mismatched SHA-256 throws;
 * - that a decryptor names its own address and cannot be pointed at another.
 *
 * # Why `approvalFor` is reached here and never from the module
 *
 * `packages/web` is a Next.js application with no package exports, so production code in this
 * package must not reach into it. A **test** may, and this is the strongest available guard against
 * the failure the estate has already paid for once: two implementations of one byte layout drifting
 * apart, where the symptom is a key server refusing a reader who is perfectly entitled. The
 * mechanics of how it is loaded without dragging a DOM-typed module into this package's compiler
 * program are explained at {@link browserOpener}.
 */

import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';
import { EncryptedObject, InvalidParameterError, NoAccessError } from '@mysten/seal';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { fromBase64, toBase58 } from '@mysten/sui/utils';
import {
  SEAL_PERIOD_MS,
  SEAL_SUBSCRIPTION,
  SEAL_UNLOCK,
  approvalBytes,
  periodIdentity,
  sealId,
  unlockIdentity,
  type ProjectXSocialConfig,
} from '@projectx-social/sdk';

import {
  PUBLIC_WALRUS_AGGREGATORS,
  SealDecryptor,
  SealHashMismatchError,
  approvalTransactionFor,
  identityForApproval,
  looksLikeSettling,
  openBlob,
  sha256Hex,
  type SealApproval,
  type SealedRef,
} from '../src/seal-node.js';

/* --------------------------------------------------- the contract this class has to satisfy */

/**
 * The consumer's declaration of what a decryptor is, from `src/index.ts`.
 *
 * A **type-only** import: it is erased before the suite runs, so nothing in `index.ts` executes
 * here, and the sibling module can keep changing without this file loading it.
 *
 * `index.ts` says of its own copy of these shapes: *"the type system will not catch this one, so
 * the two definitions have to be kept aligned by hand."* That is true from where it stands — it
 * declares an interface and never sees an implementation. From here it is not true any more, and
 * the four lines below are why: they make `tsc` fail if the class stops satisfying the interface,
 * or if either `SealApproval` gains, loses or renames a field on either side.
 *
 * The failure this prevents is named in `index.ts` too, and it is the expensive kind: TypeScript
 * compares method parameters bivariantly, so a drifted implementation is *accepted* and surfaces at
 * runtime as an identity built from `undefined` — the right length, the wrong bytes, and a key
 * server refusing it in a way indistinguishable from having no entitlement at all.
 */
import type {
  SealApproval as SealApprovalContract,
  SealDecryptor as SealDecryptorContract,
} from '../src/index.js';

/** Assignable to the contract: every method the consumer will call exists with the right shape. */
const _implementsContract: SealDecryptorContract = null as unknown as SealDecryptor;
/** And the approval union is the same in both directions — no extra member, no missing one. */
const _approvalMatchesContract: SealApprovalContract = null as unknown as SealApproval;
const _contractMatchesApproval: SealApproval = null as unknown as SealApprovalContract;
void _implementsContract;
void _approvalMatchesContract;
void _contractMatchesApproval;

/* ------------------------------------------------------------------ mainnet facts, verified today */

/** @atlas's creator vault, USDC-denominated. */
const VAULT = '0xa1f80da9efffa73a2617163f5f35249130972e4f6e0bfd2bf7396c584423fd6d';
/** A content key actually priced on that vault, at 10000 minor units. */
const CONTENT_KEY = 'sealed-on-walrus-001';
/** The other one, at 250000. Used where a second, different key is needed. */
const OTHER_CONTENT_KEY = 'mistakes-setting-up';
/** The ORIGINAL publish. Version 1, and therefore the only valid Seal namespace. */
const PACKAGE = '0xc5c833991ed1123d70b1001c0bcdb01ec5728b09f25dfc42a0edaf16005d404d';
/** Version 3, and therefore the only valid `moveCall` target. */
const LATEST = '0xfa7eb18bbb29b047ec86434e8a8f4cfba35615bde9680eebd781a187ca3a3694';

const CONFIG: ProjectXSocialConfig = {
  network: 'mainnet',
  grpcUrl: 'https://fullnode.mainnet.sui.io:443',
  packageId: PACKAGE,
  latestPackageId: LATEST,
  platformId: '0x3f695b2c32714e2359c4bb9515598d8dd765b216148c5b8fa818073d52b50f36',
  registryId: '0x1a3fb4ac25458d7524be064a2b7e1586ccd9ed09c0d5b351621e3b101e1203a0',
};

const UNLOCK_OBJECT = `0x${'11'.repeat(32)}`;
const SUBSCRIPTION_OBJECT = `0x${'22'.repeat(32)}`;

const UNLOCK: SealApproval = {
  kind: 'unlock',
  vaultId: VAULT,
  contentKey: CONTENT_KEY,
  unlockId: UNLOCK_OBJECT,
};
/** Period 689 at tier 0 — the period the live post `pmtgxffvy` is actually sealed to. */
const SUBSCRIPTION: SealApproval = {
  kind: 'subscription',
  vaultId: VAULT,
  tier: 0n,
  period: 689n,
  subscriptionId: SUBSCRIPTION_OBJECT,
  coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
};

const here = fileURLToPath(new URL('.', import.meta.url));
const readRepoFile = (relative: string): string =>
  readFileSync(new URL(`../../../${relative}`, `file://${here}`), 'utf8');

/**
 * The browser opener, loaded at runtime through a computed specifier.
 *
 * Not a static import, and the reason is mechanical rather than stylistic. `seal-open.ts` is a
 * browser module: it uses `crypto.subtle` and `BufferSource`, which need the DOM lib. A static
 * import would pull it into **this package's** `tsc` program, where `lib` is `["ES2023"]` and
 * `types` is `["node"]`, and `pnpm typecheck` in `packages/agent` would then fail on four errors
 * in a file this package does not own and must not configure around.
 *
 * A computed specifier is invisible to `tsc` — it types the result as `any` and adds no file to the
 * program — while `vitest` resolves and transforms it exactly like any other module. So the runtime
 * assertion survives with none of the compile-time coupling.
 *
 * The assertion it buys is the one worth having: **the transaction this module builds is
 * byte-identical to the one the shipped reader path builds.** Two implementations of one
 * transaction is how a desk loses an afternoon to a key server refusing somebody entitled.
 *
 * If this ever stops resolving, the fix is to move `approvalFor` into the SDK where both callers
 * can import it properly — not to delete the assertion.
 */
// The web application is not part of the published library tree. Where it is absent the byte-
// identity suite below is SKIPPED with its reason printed, never counted as passed; the monorepo
// runs it on every commit.
const WEB_SEAL_OPEN = fileURLToPath(new URL('../../web/lib/seal-open.ts', import.meta.url));
const browserOpener = (existsSync(WEB_SEAL_OPEN) ? await import(pathToFileURL(WEB_SEAL_OPEN).href) : null) as null | {
  approvalFor: (
    config: ProjectXSocialConfig,
    entitlement:
      | { kind: 'unlock'; vaultId: string; contentKey: string; unlockId: string }
      | {
          kind: 'subscription';
          vaultId: string;
          tier: bigint;
          period: bigint;
          subscriptionId: string;
          coinType: string;
        },
  ) => Parameters<typeof approvalBytes>[0];
};
const approvalFor = browserOpener === null ? null : browserOpener.approvalFor;

/* ---------------------------------------------------------------------------------- test doubles */

/**
 * A key of exactly the shape `src/keys.ts` produces, from a throwaway keypair.
 *
 * Generated, never fixed. `.gitignore` records why: the first version of the browser test signer
 * used fixed seeds, funded them on mainnet, and both addresses were swept within thirty seconds by
 * a bot that held the keys.
 */
function agentKey(): { address: string; keypair: Ed25519Keypair } {
  const keypair = Ed25519Keypair.generate();
  return { address: keypair.toSuiAddress(), keypair };
}

/**
 * A chain client that resolves owned object references without a network.
 *
 * `seal_approve_unlock` takes `&Unlock` and an owned object reference in a transaction carries a
 * version and a digest, neither of which is derivable from the id — so `Transaction.build` has to
 * ask somebody. `client.core.resolveTransactionPlugin()` is the single method it asks (established
 * by trapping every property access on a real build), and returning a plugin that fills the
 * references in with fixed values makes the build deterministic and offline.
 */
function offlineClient(): never {
  const digest = toBase58(new Uint8Array(32).fill(7));
  return {
    core: {
      resolveTransactionPlugin:
        () =>
        async (
          data: { inputs: Record<string, unknown>[] },
          _options: unknown,
          next: () => Promise<void>,
        ): Promise<void> => {
          for (const input of data.inputs) {
            if (input['$kind'] !== 'UnresolvedObject') continue;
            const { objectId } = input['UnresolvedObject'] as { objectId: string };
            delete input['UnresolvedObject'];
            input['$kind'] = 'Object';
            input['Object'] = {
              $kind: 'ImmOrOwnedObject',
              ImmOrOwnedObject: { objectId, version: '1', digest },
            };
          }
          await next();
        },
    },
    // The suite only ever passes this where a `SuiGrpcClient` is expected and only the one method
    // above is reached. Cast at the seam rather than sprinkling `any` through the tests.
  } as never;
}

/**
 * The same double, with the real resolver's compatibility rule enforced.
 *
 * Quoted from `@mysten/sui` 2.27.1 `src/transactions/TransactionData.ts:512`, where an
 * `UnresolvedObject` that resolves to an owned object is refused if it carries any shared-object
 * property:
 *
 * ```ts
 * // Objects with shared object properties should not resolve to owned objects
 * original.mutable != null ||
 * ```
 *
 * `Unlock` and `Subscription` are owned, and the SDK's `entitlementRef()` sets `mutable: false`. So
 * this double reproduces, offline, the failure measured on mainnet against real objects.
 */
function strictOfflineClient(): never {
  const digest = toBase58(new Uint8Array(32).fill(7));
  return {
    core: {
      resolveTransactionPlugin:
        () =>
        async (
          data: { inputs: Record<string, unknown>[] },
          _options: unknown,
          next: () => Promise<void>,
        ): Promise<void> => {
          for (const input of data.inputs) {
            if (input['$kind'] !== 'UnresolvedObject') continue;
            const unresolved = input['UnresolvedObject'] as {
              objectId: string;
              mutable?: boolean;
              initialSharedVersion?: string;
            };
            if (unresolved.mutable != null || unresolved.initialSharedVersion != null) {
              throw new Error(
                `Input did not match unresolved object. ${JSON.stringify(unresolved)} is not ` +
                  `compatible with an owned object`,
              );
            }
            delete input['UnresolvedObject'];
            input['$kind'] = 'Object';
            input['Object'] = {
              $kind: 'ImmOrOwnedObject',
              ImmOrOwnedObject: { objectId: unresolved.objectId, version: '1', digest },
            };
          }
          await next();
        },
    },
  } as never;
}

/** A Seal `EncryptedObject` sealed to one identity, with no real ciphertext in it. */
function wrappedKeyFor(identity: Uint8Array): string {
  const bytes = EncryptedObject.serialize({
    version: 0,
    packageId: PACKAGE,
    id: sealId(identity),
    services: [[`0x${'33'.repeat(32)}`, 1]],
    threshold: 1,
    encryptedShares: {
      BonehFranklinBLS12381: {
        nonce: new Uint8Array(96),
        encryptedShares: [new Uint8Array(32)],
        encryptedRandomness: new Uint8Array(32),
      },
    },
    ciphertext: { Plain: {} },
  }).toBytes();
  return Buffer.from(bytes).toString('base64');
}

/**
 * A blob in exactly the layout `packages/web/lib/blob-crypto.ts` writes: body ‖ 16-byte tag.
 *
 * Built with `node:crypto` directly rather than by calling `encryptBlob`, which carries
 * `import 'server-only'` and throws outside a Next server bundle. The drift test below is what
 * keeps this construction honest.
 */
function sealBlob(plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  key: Uint8Array;
  nonce: string;
  sha256: string;
} {
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    ciphertext: new Uint8Array(Buffer.concat([body, cipher.getAuthTag()])),
    key: new Uint8Array(key),
    nonce: nonce.toString('base64'),
    sha256: createHash('sha256').update(plaintext).digest('hex'),
  };
}

/**
 * A response, duck-typed rather than constructed.
 *
 * `new Response(bytes)` needs `BodyInit`, a DOM lib type this package's `tsc` program does not
 * carry. The module reads exactly three members off what `fetch` returns, so those three are what
 * the double provides — which also documents, in one place, the whole of what it depends on.
 */
function served(status: number, bytes?: Uint8Array): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    arrayBuffer: async () => (bytes ?? new Uint8Array()).slice().buffer,
  } as unknown as Response;
}

/** An aggregator that serves one blob id and 404s everything else. */
function aggregatorServing(blobId: string, bytes: Uint8Array): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) =>
    String(input).endsWith(`/v1/blobs/${blobId}`) ? served(200, bytes) : served(404)) as typeof fetch;
}

/* ------------------------------------------------------------------------------------- the suite */

describe('the identity an agent asks for', () => {
  it('builds an unlock identity as vault ‖ 0x00 ‖ contentKey', () => {
    const identity = identityForApproval(UNLOCK);
    const contentKey = new TextEncoder().encode(CONTENT_KEY);

    expect(identity.length).toBe(32 + 1 + contentKey.length);
    expect(Buffer.from(identity.subarray(0, 32)).toString('hex')).toBe(VAULT.slice(2));
    expect(identity[32]).toBe(0x00);
    expect(Buffer.from(identity.subarray(33))).toEqual(Buffer.from(contentKey));
  });

  it('builds a subscription identity as vault ‖ 0x01 ‖ tier LE ‖ period LE', () => {
    const identity = identityForApproval(SUBSCRIPTION);

    expect(identity.length).toBe(32 + 1 + 8 + 8);
    expect(Buffer.from(identity.subarray(0, 32)).toString('hex')).toBe(VAULT.slice(2));
    expect(identity[32]).toBe(0x01);
    // tier 0, then period 689 = 0x02b1, little-endian.
    expect([...identity.subarray(33, 41)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...identity.subarray(41, 49)]).toEqual([0xb1, 0x02, 0, 0, 0, 0, 0, 0]);
  });

  it('delegates to the SDK derivations rather than deriving anything itself', () => {
    /*
      The SDK's `seal.ts` is the file held byte-for-byte against `entitlement.move` by tests in both
      TypeScript and Move. This module must add nothing to it — an identity built here that merely
      *resembles* the SDK's is the exact defect that reads as "the key server refused us".
    */
    expect(identityForApproval(UNLOCK)).toEqual(
      unlockIdentity(VAULT, new TextEncoder().encode(CONTENT_KEY)),
    );
    expect(identityForApproval(SUBSCRIPTION)).toEqual(periodIdentity(VAULT, 0n, 689n));
  });

  it('encodes the content key as UTF-8, the same encoding the sealer used', () => {
    /*
      `content_key` is `vector<u8>` in Move and the contract matches it byte-for-byte without
      interpreting it, so the encoding is a decision made off chain and it must be the SAME decision
      everywhere: `packages/web/lib/seal.ts` seals with `new TextEncoder().encode(contentKey)`, and
      `creator::unlock` was called with whatever bytes the application sent.

      For an ASCII slug like `sealed-on-walrus-001` every encoding agrees, which is exactly why this
      needs a non-ASCII case — latin1 and UTF-8 diverge only above 0x7f, so a creator using an
      accented or non-Latin content key is where the two silently produce different identities and
      the buyer is refused content they paid for.
    */
    const contentKey = 'café-über-日本';
    const identity = identityForApproval({
      kind: 'unlock',
      vaultId: VAULT,
      contentKey,
      unlockId: UNLOCK_OBJECT,
    });

    const utf8 = Buffer.from(contentKey, 'utf8');
    const latin1 = Buffer.from(contentKey, 'latin1');
    expect(Buffer.from(utf8)).not.toEqual(Buffer.from(latin1));
    expect(Buffer.from(identity.subarray(33))).toEqual(utf8);
    expect(identity.length).toBe(32 + 1 + utf8.length);
  });

  it('keeps the two families apart, which is what stops one cheap unlock opening a period', () => {
    /*
      `entitlement.move` states the reason: `content_key` is arbitrary creator-supplied bytes, so
      without the tag byte a creator could publish under the content key `0x01 ‖ tier ‖ period` and
      make an unlock-gated identity byte-identical to a subscription-gated one.
    */
    const forgedContentKey = new Uint8Array([
      SEAL_SUBSCRIPTION,
      ...new Uint8Array(8), // tier 0, u64 LE
      0xb1,
      0x02,
      ...new Uint8Array(6), // period 689, u64 LE
    ]);
    const asSubscription = periodIdentity(VAULT, 0n, 689n);

    // The collision that WOULD exist if the identity were simply `vault ‖ content_key`: bytes
    // chosen by the creator reproduce a subscription identity exactly.
    const withoutTag = new Uint8Array([...Buffer.from(VAULT.slice(2), 'hex'), ...forgedContentKey]);
    expect(Buffer.from(withoutTag)).toEqual(Buffer.from(asSubscription));

    // The tag byte is what breaks it. One cheap unlock cannot be made to open a whole period.
    const asUnlock = unlockIdentity(VAULT, forgedContentKey);
    expect(Buffer.from(asUnlock)).not.toEqual(Buffer.from(asSubscription));
    expect(asUnlock.length).toBe(asSubscription.length + 1);
    expect(asUnlock[32]).toBe(SEAL_UNLOCK);
    expect(asSubscription[32]).toBe(SEAL_SUBSCRIPTION);
  });

  it('still agrees with the constants entitlement.move actually declares', () => {
    // The Move source is the specification. If somebody edits it, this fails here rather than in a
    // key server months later.
    const move = readRepoFile('sui-contracts/sources/entitlement.move');
    expect(move).toContain('const SEAL_UNLOCK: u8 = 0;');
    expect(move).toContain('const SEAL_SUBSCRIPTION: u8 = 1;');
    expect(move).toContain('const PERIOD_MS: u64 = 30 * 24 * 60 * 60 * 1000;');
    expect(SEAL_UNLOCK).toBe(0);
    expect(SEAL_SUBSCRIPTION).toBe(1);
    expect(SEAL_PERIOD_MS).toBe(30n * 24n * 60n * 60n * 1000n);
  });
});

describe.skipIf(approvalFor === null)('the approval transaction handed to the key servers (web mirror; skipped where packages/web is absent)', () => {
  it('is byte-identical to the browser opener for an unlock', async () => {
    /*
      The anti-drift assertion this whole suite exists for. `packages/web/lib/seal-open.ts` builds
      the approval the shipped reader path uses; this module builds the one an agent uses. Two
      implementations of one transaction is how a desk loses an afternoon to a key server refusing
      somebody who is entitled.
    */
    const mine = approvalTransactionFor(CONFIG, UNLOCK);
    const browser = approvalFor!(CONFIG, {
      kind: 'unlock',
      vaultId: VAULT,
      contentKey: CONTENT_KEY,
      unlockId: UNLOCK_OBJECT,
    });

    expect(mine.getData()).toEqual(browser.getData());
    expect(await approvalBytes(mine, offlineClient())).toEqual(
      await approvalBytes(browser, offlineClient()),
    );
  });

  it('is byte-identical to the browser opener for a subscription', async () => {
    const mine = approvalTransactionFor(CONFIG, SUBSCRIPTION);
    const browser = approvalFor!(CONFIG, {
      kind: 'subscription',
      vaultId: VAULT,
      tier: 0n,
      period: 689n,
      subscriptionId: SUBSCRIPTION_OBJECT,
      coinType: '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC',
    });

    expect(mine.getData()).toEqual(browser.getData());
    expect(await approvalBytes(mine, offlineClient())).toEqual(
      await approvalBytes(browser, offlineClient()),
    );
  });

  it('targets the LATEST package, never the Seal namespace', () => {
    /*
      Sui does not resolve a package id to its newest version, so a call to the original address
      executes the original bytecode. The namespace rule is the mirror image and getting either
      backwards fails a long way from the mistake. On this deployment the two ids differ, so the
      test can actually tell them apart.
    */
    expect(LATEST).not.toBe(PACKAGE);
    // Since v5 the two approvals live in different modules: unlocks in `entitlement`, subscriptions
    // in `creator`, where the tier prices are. Both still target the LATEST package.
    for (const [approval, module] of [[UNLOCK, 'entitlement'], [SUBSCRIPTION, 'creator']] as const) {
      const command = approvalTransactionFor(CONFIG, approval).getData().commands[0];
      expect(command?.MoveCall?.package).toBe(LATEST);
      expect(command?.MoveCall?.module).toBe(module);
    }
  });

  it('calls seal_approve_unlock with the identity and the unlock object', () => {
    const data = approvalTransactionFor(CONFIG, UNLOCK).getData();
    expect(data.commands[0]?.MoveCall?.function).toBe('seal_approve_unlock');

    // Argument 0 is BCS `vector<u8>`: a ULEB128 length, then the identity bytes.
    const identity = identityForApproval(UNLOCK);
    const pure = fromBase64(data.inputs[0]?.Pure?.bytes ?? '');
    expect(pure[0]).toBe(identity.length);
    expect(Buffer.from(pure.subarray(1))).toEqual(Buffer.from(identity));

    // Argument 1 is the owned entitlement, named and nothing more.
    //
    // It used to carry `mutable: false`, on the reasoning that the Move signature already says the
    // reference is immutable so declaring it saved a round trip. That was right about Move and
    // wrong about the SDK: `mutable` is a SHARED-object property and an `Unlock` is owned, so
    // `@mysten/sui` refused every approval it appeared on. The builder now reads the function's
    // signature and learns immutability from the contract itself — one extra read, in exchange for
    // a transaction that builds.
    expect(data.inputs[1]?.UnresolvedObject).toEqual({ objectId: UNLOCK_OBJECT });
    expect(data.inputs[1]?.UnresolvedObject).not.toHaveProperty('mutable');
  });

  it('calls seal_approve_subscription with tier and period both beside and inside the identity', () => {
    const data = approvalTransactionFor(CONFIG, SUBSCRIPTION).getData();
    expect(data.commands[0]?.MoveCall?.function).toBe('seal_approve_subscription');

    // The redundancy is the contract's design, not duplication to remove: the assertion
    // `id == period_identity(vault, tier, period)` is what stops a reader naming one period in the
    // arguments and being checked against another.
    expect([...fromBase64(data.inputs[1]?.Pure?.bytes ?? '')]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect([...fromBase64(data.inputs[2]?.Pure?.bytes ?? '')]).toEqual([
      0xb1, 0x02, 0, 0, 0, 0, 0, 0,
    ]);
    // v5: the vault comes before the subscription, because the policy reads the tier's price from it.
    expect(data.inputs[3]?.UnresolvedObject).toEqual({ objectId: VAULT });
    expect(data.inputs[4]?.UnresolvedObject).toEqual({ objectId: SUBSCRIPTION_OBJECT });
    expect(data.commands[0]?.MoveCall?.typeArguments).toEqual([SUBSCRIPTION.coinType]);
    expect(data.inputs[3]?.UnresolvedObject).not.toHaveProperty('mutable');
  });

  it('carries no gas budget, price or payment', () => {
    // Nothing is signed and no gas is spent — the key servers dry-run it. A gas budget here would
    // be a claim about a coin the agent may not hold.
    const gas = approvalTransactionFor(CONFIG, UNLOCK).getData().gasData;
    expect(gas).toEqual({ budget: null, price: null, owner: null, payment: null });
  });
});

describe('an agent decrypts for itself and for nobody else', () => {
  it('names its own address as the sender of every approval', async () => {
    /*
      The permanent constraint, stated as a test rather than only as a comment.

      A Seal key is a deterministic function of its identity: once derived it exists for ever and no
      second check ever runs. So the only thing standing between an entitlement and a permanent
      key-issuing service is that this module has no way to act for another address. There is no
      parameter to pass one, and the sender is read from the agent's own key.
    */
    const key = agentKey();
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key,
      suiClient: offlineClient(),
    });

    expect(decryptor.address).toBe(key.address);

    const bytes = await decryptor.approvalBytesFor(UNLOCK);
    const other = agentKey();
    const otherBytes = await new SealDecryptor({
      config: CONFIG,
      key: other,
      suiClient: offlineClient(),
    }).approvalBytesFor(UNLOCK);

    // `onlyTransactionKind` omits the sender, so the two serialise identically — which is exactly
    // why the sender is not what protects anybody. The key servers substitute the *certificate's*
    // user, and that certificate is signed by the agent's own key and no other.
    expect(bytes).toEqual(otherBytes);
    expect(key.address).not.toBe(other.address);
  });

  it('satisfies the decryptor contract src/index.ts declares', () => {
    // The compile-time half is at the top of this file and is the load-bearing one. This is the
    // runtime companion: the method the consumer calls is actually there, on an instance.
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
    });
    expect(typeof decryptor.decrypt).toBe('function');
    expect(decryptor.decrypt.length).toBe(1);
  });

  it('exposes no way to name a different holder', () => {
    // Structural, and deliberately blunt. If a future edit adds a delegation parameter, this fails
    // and whoever wrote it has to read SEAL.md before deleting the assertion.
    const surface = Object.getOwnPropertyNames(SealDecryptor.prototype);
    expect(surface.sort()).toEqual(
      ['constructor', 'approvalBytesFor', 'address', 'decrypt', 'recoverKeyFromCommittee', 'sessionKey'].sort(),
    );
  });
});

describe('opening the blob', () => {
  const PLAINTEXT = new TextEncoder().encode(
    'Where a paid post actually goes. Bytes an agent will act on, so they are checked twice.',
  );

  it('returns exactly what was sealed', async () => {
    const blob = sealBlob(PLAINTEXT);
    const identity = identityForApproval(UNLOCK);
    const ref: SealedRef = {
      blobId: 'ZqPLyhQFhpDUXNht2DBNly7NjSfTbv-2Vxm94o0LeMI',
      sealWrappedKey: wrappedKeyFor(identity),
      nonce: blob.nonce,
      sha256: blob.sha256,
      approval: UNLOCK,
    };

    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: aggregatorServing(ref.blobId, blob.ciphertext),
      recoverKey: async () => blob.key,
    });

    expect(new TextDecoder().decode(await decryptor.decrypt(ref))).toBe(
      new TextDecoder().decode(PLAINTEXT),
    );
  });

  it('THROWS when the SHA-256 does not match what was recorded at publish', async () => {
    /*
      The assertion the whole module is built around. These bytes travelled through storage nobody
      here operates and came back reassembled from slivers held by many separate nodes. An agent
      that acts on what it reads must never be handed bytes that are not the bytes.
    */
    const blob = sealBlob(PLAINTEXT);
    const ref: SealedRef = {
      blobId: 'blob-with-a-lying-hash',
      sealWrappedKey: wrappedKeyFor(identityForApproval(UNLOCK)),
      nonce: blob.nonce,
      sha256: 'f'.repeat(64),
      approval: UNLOCK,
    };

    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: aggregatorServing(ref.blobId, blob.ciphertext),
      recoverKey: async () => blob.key,
    });

    await expect(decryptor.decrypt(ref)).rejects.toThrow(SealHashMismatchError);
    await expect(decryptor.decrypt(ref)).rejects.toThrow(/do not match the hash recorded at publish/);
    // The real digest is named, so an operator can tell a corrupted blob from a wrong row.
    await expect(decryptor.decrypt(ref)).rejects.toThrow(new RegExp(blob.sha256));
  });

  it('fails on GCM’s tag before the hash is ever reached, for a single flipped byte', async () => {
    const blob = sealBlob(PLAINTEXT);
    const altered = Uint8Array.from(blob.ciphertext);
    altered[0] = (altered[0] ?? 0) ^ 0x01;

    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: aggregatorServing('b', altered),
      recoverKey: async () => blob.key,
    });

    await expect(
      decryptor.decrypt({
        blobId: 'b',
        sealWrappedKey: wrappedKeyFor(identityForApproval(UNLOCK)),
        nonce: blob.nonce,
        sha256: blob.sha256,
        approval: UNLOCK,
      }),
      // Not a `SealHashMismatchError`: authentication is supposed to catch this first, and if it
      // ever stops doing so the failure mode becomes "plausible plaintext".
    ).rejects.not.toThrow(SealHashMismatchError);
  });

  it('refuses a wrong-length key or nonce rather than producing noise', () => {
    const blob = sealBlob(PLAINTEXT);
    expect(() =>
      openBlob({ ciphertext: blob.ciphertext, key: blob.key.subarray(0, 31), nonce: new Uint8Array(12) }),
    ).toThrow(/must be 32 bytes; this one is 31/);
    expect(() =>
      openBlob({ ciphertext: blob.ciphertext, key: blob.key, nonce: new Uint8Array(11) }),
    ).toThrow(/must be 12 bytes; this one is 11/);
    expect(() =>
      openBlob({ ciphertext: new Uint8Array(16), key: blob.key, nonce: new Uint8Array(12) }),
    ).toThrow(/too short to carry an authentication tag/);
  });

  it.skipIf(!existsSync(WEB_SEAL_OPEN))('still agrees with the layout blob-crypto.ts actually writes', () => {
    /*
      `blob-crypto.ts` carries `import 'server-only'` and cannot be imported here, so the layout is
      transcribed — and a transcription is checked against its source or it is a guess. Same
      register as `packages/sdk/test/drift.test.ts`, which asserts a BCS field order against
      `platform.move`.
    */
    const source = readRepoFile('packages/web/lib/blob-crypto.ts');
    expect(source).toContain('const KEY_BYTES = 32;');
    expect(source).toContain('const NONCE_BYTES = 12;');
    expect(source).toContain('const TAG_BYTES = 16;');
    expect(source).toContain('Buffer.concat([body, tag])');
    expect(source).toContain("createCipheriv('aes-256-gcm'");
  });

  it('hashes the way the publisher hashed', () => {
    expect(sha256Hex(new Uint8Array())).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex(PLAINTEXT)).toBe(createHash('sha256').update(PLAINTEXT).digest('hex'));
  });
});

describe('refusing before a metered request is spent', () => {
  it('refuses an approval that does not cover the identity the content is sealed to', async () => {
    /*
      Same vault, same kind, different content key. The key servers would abort with `EWrongIdentity`
      and that arrives looking exactly like "you have no entitlement" — a wrong and alarming answer
      to give an agent holding a perfectly good `Unlock` for a different post.
    */
    const sealedTo = unlockIdentity(VAULT, new TextEncoder().encode(OTHER_CONTENT_KEY));
    const recoverKey = vi.fn();

    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: (() => {
        throw new Error('the aggregator must not be reached');
      }) as unknown as typeof fetch,
      recoverKey: recoverKey as never,
    });

    await expect(
      decryptor.decrypt({
        blobId: 'b',
        sealWrappedKey: wrappedKeyFor(sealedTo),
        nonce: Buffer.alloc(12).toString('base64'),
        sha256: '0'.repeat(64),
        approval: UNLOCK,
      }),
    ).rejects.toThrow(/does not open this blob/);

    expect(recoverKey).not.toHaveBeenCalled();
  });

  it('refuses a nonce that is not twelve bytes', async () => {
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      recoverKey: async () => new Uint8Array(32),
    });

    await expect(
      decryptor.decrypt({
        blobId: 'b',
        sealWrappedKey: wrappedKeyFor(identityForApproval(UNLOCK)),
        nonce: Buffer.alloc(8).toString('base64'),
        sha256: '0'.repeat(64),
        approval: UNLOCK,
      }),
    ).rejects.toThrow(/nonce must be 12 bytes; this one is 8/);
  });

  it('says so plainly when it has neither a committee nor a seam', async () => {
    const blob = sealBlob(new Uint8Array([1, 2, 3]));
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: aggregatorServing('b', blob.ciphertext),
    });

    await expect(
      decryptor.decrypt({
        blobId: 'b',
        sealWrappedKey: wrappedKeyFor(identityForApproval(UNLOCK)),
        nonce: blob.nonce,
        sha256: blob.sha256,
        approval: UNLOCK,
      }),
    ).rejects.toThrow(/no key server committee/);
  });
});

describe('the entitlement reference the SDK builds, now that it resolves', () => {
  /*
    This block used to assert the defect and pin the workaround. Both are gone.

    `entitlementRef()` declared `mutable: false`. It is a SHARED-object property; `Unlock` and
    `Subscription` are owned. `@mysten/sui` rejects on `original.mutable != null` — the PRESENCE of
    the key — so `mutable: true` failed identically. Measured on mainnet with 2.27.1 against real
    objects: `approvalFor` FAILED on an unlock and on a subscription, plain `tx.object(id)` built
    207 bytes. Present in 2.24.0 through 2.27.1: never a regression, never buildable.

    Fixed at source in `packages/sdk/src/seal.ts`, proven by building AND simulating a real approval
    against the live `Unlock` 0x405bbf4a… — 347 bytes, simulation success. The plugin this module
    carried is deleted rather than kept as a no-op: a no-op that strips a key nobody sets would
    silently absorb the regression it was written to survive. One guard, in the SDK, where the
    decision is made — `packages/sdk/test/entitlement-ref.test.ts`.
  */
  it('builds straight from the SDK builder, with no workaround in the path', async () => {
    for (const approval of [UNLOCK, SUBSCRIPTION]) {
      const bytes = await approvalBytes(
        approvalTransactionFor(CONFIG, approval),
        strictOfflineClient(),
      );
      expect(bytes.length).toBeGreaterThan(0);
    }
  });

  it('is what the decryptor actually uses, so a real approval builds', async () => {
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: strictOfflineClient(),
    });
    expect((await decryptor.approvalBytesFor(UNLOCK)).length).toBeGreaterThan(0);
    expect((await decryptor.approvalBytesFor(SUBSCRIPTION)).length).toBeGreaterThan(0);
  });

  it('carries no workaround for the SDK to outgrow', () => {
    // The plugin is gone from the module. If anyone reintroduces a local strip instead of fixing
    // the SDK, this fails and points at the one place the decision belongs.
    const source = readRepoFile('packages/agent/src/seal-node.ts');
    expect(source).not.toContain('delete input.UnresolvedObject.mutable');
  });

  it('holds the SDK to the fix rather than to the defect', () => {
    /*
      Was: `expect(sdk).toContain('mutable: false')` — an assertion that the bug was still there.

      Scanned with comments stripped, and that is not fussiness. The SDK's doc block now explains
      the defect at length and necessarily quotes `mutable: false` while doing so; a raw substring
      search reads that history as the bug itself and fails. A test that punishes a file for
      documenting its own defect teaches the next author to delete the explanation, which is the
      opposite of what this estate wants. Same lesson the scale guard taught earlier tonight.
    */
    const code = readRepoFile('packages/sdk/src/seal.ts')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toContain('mutable');
    // And the prose IS still there, because the reasoning is worth keeping.
    // A single word, because the sentence wraps and a wrapped phrase is a brittle assertion about
    // line width rather than about content.
    expect(readRepoFile('packages/sdk/src/seal.ts')).toContain('SHARED-object');
  });
});

describe('the key server committee this module builds', () => {
  it('sets verifyKeyServers explicitly, and to true', () => {
    /*
      Read from this module's own source because the committee path is the one step the offline
      suite cannot execute — there are no open key servers on Sui mainnet. An assertion that cannot
      run is worth less than one that reads the decision off the file, and this decision is exactly
      the kind that gets "tidied away" as a redundant default by somebody who read the vendor's
      documentation.
    */
    const source = readRepoFile('packages/agent/src/seal-node.ts');
    expect(source).toContain('verifyKeyServers: true');
    expect(source).not.toContain('verifyKeyServers: false');
  });

  it('is still right to set it, because the shipped SDK default is false', () => {
    /*
      MEASURED, not quoted. Mysten's published documentation states this defaults to `true`; the
      code installed here reads `options.verifyKeyServers ?? false`, so anybody following their
      documentation gets unverified key servers. When this assertion starts failing, the vendor has
      fixed the default and this note can be retired — until then the explicit `true` above is
      load-bearing at every call site in the estate.
    */
    const shipped = readRepoFile('packages/agent/node_modules/@mysten/seal/dist/client.mjs');
    expect(shipped).toContain('verifyKeyServers = options.verifyKeyServers ?? false');
  });
});

describe('reading ciphertext from a public aggregator', () => {
  const blob = sealBlob(new TextEncoder().encode('two aggregators, one of them awake'));

  it('falls through to the next aggregator when one is down', async () => {
    const seen: string[] = [];
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      aggregators: ['https://down.example', 'https://up.example'],
      fetch: (async (input: Parameters<typeof fetch>[0]) => {
        seen.push(String(input));
        return String(input).startsWith('https://down')
          ? served(503)
          : served(200, blob.ciphertext);
      }) as typeof fetch,
      recoverKey: async () => blob.key,
    });

    const bytes = await decryptor.decrypt({
      blobId: 'B1',
      sealWrappedKey: wrappedKeyFor(identityForApproval(UNLOCK)),
      nonce: blob.nonce,
      sha256: blob.sha256,
      approval: UNLOCK,
    });

    expect(new TextDecoder().decode(bytes)).toBe('two aggregators, one of them awake');
    expect(seen).toEqual(['https://down.example/v1/blobs/B1', 'https://up.example/v1/blobs/B1']);
  });

  it('names every aggregator it tried when none of them answers', async () => {
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      aggregators: ['https://a.example', 'https://b.example'],
      fetch: (async () => served(404)) as typeof fetch,
      recoverKey: async () => blob.key,
    });

    await expect(
      decryptor.decrypt({
        blobId: 'B2',
        sealWrappedKey: wrappedKeyFor(identityForApproval(UNLOCK)),
        nonce: blob.nonce,
        sha256: blob.sha256,
        approval: UNLOCK,
      }),
    ).rejects.toThrow(/a\.example answered 404; https:\/\/b\.example answered 404/);
  });

  it.skipIf(!existsSync(WEB_SEAL_OPEN))('defaults to the same two public aggregators the browser opener uses', () => {
    // A default is safe here and nowhere else in this system: every byte is checked twice, so a
    // hostile aggregator can refuse and can do nothing more. See the constant's own doc block.
    expect([...PUBLIC_WALRUS_AGGREGATORS]).toEqual([
      'https://aggregator.walrus-mainnet.walrus.space',
      'https://walrus.globalstake.io',
    ]);
    const browser = readRepoFile('packages/web/components/SealedBody.tsx');
    for (const url of PUBLIC_WALRUS_AGGREGATORS) expect(browser).toContain(url);
  });

  it('refuses to be built with no aggregator at all', () => {
    expect(
      () =>
        new SealDecryptor({
          config: CONFIG,
          key: agentKey(),
          suiClient: offlineClient(),
          aggregators: [],
        }),
    ).toThrow(/at least one Walrus aggregator/);
  });
});

describe('the settling window after a purchase', () => {
  const blob = sealBlob(new TextEncoder().encode('bought a moment ago'));
  const ref = (): SealedRef => ({
    blobId: 'S1',
    sealWrappedKey: wrappedKeyFor(identityForApproval(UNLOCK)),
    nonce: blob.nonce,
    sha256: blob.sha256,
    approval: UNLOCK,
  });

  it('retries a refusal that is really the fullnode catching up', async () => {
    /*
      A key server checks the policy by simulating against a fullnode, and a freshly created
      `Unlock` is not indexed there for a few seconds. An agent takes a refusal as a fact and writes
      it into a plan, so an unretried settling window becomes a paywall that does not exist.
    */
    const slept: number[] = [];
    let attempts = 0;

    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: aggregatorServing('S1', blob.ciphertext),
      sleep: async (ms) => {
        slept.push(ms);
      },
      recoverKey: async () => {
        attempts += 1;
        if (attempts < 3) throw new NoAccessError('User does not have access to one or more keys');
        return blob.key;
      },
    });

    expect(new TextDecoder().decode(await decryptor.decrypt(ref()))).toBe('bought a moment ago');
    expect(attempts).toBe(3);
    expect(slept).toEqual([1500, 3500]);
  });

  it('gives up after four attempts rather than spinning for ever', async () => {
    let attempts = 0;
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: aggregatorServing('S1', blob.ciphertext),
      sleep: async () => {},
      recoverKey: async () => {
        attempts += 1;
        throw new NoAccessError('User does not have access to one or more keys');
      },
    });

    await expect(decryptor.decrypt(ref())).rejects.toThrow(/does not have access/);
    expect(attempts).toBe(4);
  });

  it('does not retry a failure that is not a settling window', async () => {
    let attempts = 0;
    const decryptor = new SealDecryptor({
      config: CONFIG,
      key: agentKey(),
      suiClient: offlineClient(),
      fetch: aggregatorServing('S1', blob.ciphertext),
      sleep: async () => {},
      recoverKey: async () => {
        attempts += 1;
        throw new Error('InvalidCiphertextError: the encrypted object is malformed');
      },
    });

    await expect(decryptor.decrypt(ref())).rejects.toThrow(/malformed/);
    expect(attempts).toBe(1);
  });

  it('recognises the refusals a key server actually sends — by class, not by prose', () => {
    /*
      The case the old regex missed, verbatim from @mysten/seal: a freshly minted Unlock the
      fullnode has "not yet seen". The regex looked for "not yet exist" and never fired on it, so
      an agent that had just paid recorded the refusal as fact. Mutation predicted: put the regex
      back → this assertion goes red.
    */
    const justPaid = new InvalidParameterError(
      'PTB contains an invalid parameter, possibly a newly created object that the FN has not yet seen',
    );
    expect(justPaid.name).toBe('Error'); // the library's classes carry no name; a regex on it matches nothing
    expect(looksLikeSettling(justPaid)).toBe(true);
    expect(looksLikeSettling(new NoAccessError('User does not have access to one or more keys'))).toBe(true);
    // The committee unreachable is also worth the bounded retry.
    expect(looksLikeSettling(new Error('fetch failed'))).toBe(true);
    // Prose that merely contains the old words is not a settling window.
    expect(looksLikeSettling(new Error('NoAccess'))).toBe(false);
    expect(looksLikeSettling(new Error('Object does not yet exist'))).toBe(false);
    expect(looksLikeSettling(new Error('the network is on fire'))).toBe(false);
  });
});
