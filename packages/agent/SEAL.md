<!-- Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev> -->

# Seal, from Node

How an agent opens sealed content with a raw Ed25519 keypair, no browser and no wallet — and the
one thing this module must never be allowed to become.

Implementation: `packages/agent/src/seal-node.ts`. Tests: `packages/agent/test/seal-node.test.ts`.

---

## 1. THE PERMANENT CONSTRAINT

**A Seal key is a deterministic function of its identity. Once derived it exists for ever, and no
second check ever runs.**

The key servers evaluate `entitlement::seal_approve_unlock` or `seal_approve_subscription` exactly
once — at the moment the key is derived, with the requesting address as `ctx.sender()`. After that
the key is 32 opaque bytes. There is no expiry on them, no revocation, no re-authorisation, and
nothing anybody can take back. `entitlement.move` says so in its own words, and builds the design
around it:

> A Seal key, once derived, is permanent. Requiring the subscription to be *currently* active would
> therefore control nothing — a subscriber could fetch every key the day before lapsing and keep
> them.

### Therefore: this module must NEVER be extended to let one address decrypt on another's behalf.

Not as a convenience. Not behind a flag. Not "just for the platform". Specifically forbidden:

- a `decryptFor(address)` parameter, or any delegation argument;
- a shared or pooled `SessionKey`, or one signed by anything other than the agent's own key;
- a service that holds several agent keys and opens content for whichever caller asks;
- an "agent acts for user" mode, in any form, including one where the user consents.

Each of those converts **one entitlement into a permanent, un-revocable key-issuing service** for
content the holder never bought. And it does it silently: the contract's check still passes, the key
server still behaves correctly, and nothing downstream looks wrong. There is no monitoring that
catches it and no rollback that undoes it, because the keys are already out.

### Agents hold their own entitlements.

An agent that must read a creator's paid post **buys that post with its own address** and opens it
with its own key. An agent that must read subscriber content **holds its own subscription**. This is
not a limitation to be engineered around in a later sprint. It is the property that makes the
paywall mean anything at all, and it is the reason a creator can be told the truth about who can
read their work.

If a future requirement seems to need delegation, the answer is a second entitlement, not a second
reader.

---

## 2. What was unproven, and what is now measured

Every sealed read this system had ever performed happened in a browser tab, with a wallet supplying
the personal-message signature (`SealedMedia.tsx`, `SealedBody.tsx`). Whether a headless process
could do the same was the open question the whole agent economy sits on.

**It can.** `SessionKey.create` takes an optional `signer` — the installed `@mysten/seal` 1.4.6 types
name `EnokiSigner` as the example — and `Ed25519Keypair` already implements that `Signer` interface,
`signPersonalMessage` included. There is no wallet-shaped hole to fill.

Measured on **mainnet, 2026-08-31**, with freshly generated throwaway keys that have never held a
coin (`@mysten/seal` 1.4.6, `@mysten/sui` 2.27.1, gRPC `https://fullnode.mainnet.sui.io:443`):

```
agent address (fresh, unfunded): 0xd8232f7eb8f6f55d182ae4a53342c5d3d8afd04c27d2822c4b3e9d799058527f
approval built over gRPC: 207 bytes; identity 53 bytes
SessionKey: { user: '0xd8232f…527f', ttl_min: 10, sigLen: 132, expired: false }
same session reused: true
walrus ZqPLyhQFhpDUXNht2DBNly7NjSfTbv-2Vxm94o0LeMI: HTTP 200, 734 bytes, PNG magic false
walrus YnL5u_hqseYxT2jdeS2d9ci-PYyYmmuWYTHrpuAELxo: HTTP 200, 170 bytes, PNG magic false
```

The approval was built against a **real** `Unlock` object owned by
`0xda784b6c20c5995f6b719a20a26eddee5ec971c8ecec890e61c8b4634dd1715d`
(`0x405bbf4ac0334bf325aa53992356be4e1fb138c99cc0580bb0e819a50f5af4e5`), resolved over gRPC. The two
blobs are the live subscriber body and image recorded in `UPDATE.md` on 2026-08-31, and both byte
counts match what was recorded there.

**Not proven, and it cannot be from here:** a key server actually releasing a key to an agent. See
§6.

### The package-id trap, also measured

`SessionKey.create` reads the package object and requires `version === 1`:

```
packageId 0xc5c833…404d (v1, the ORIGINAL publish)  →  SessionKey.create OK in 289 ms
packageId 0xfa7eb1…3694 (v3, the LATEST publish)    →  InvalidPackageError: Package ID used in PTB is invalid
```

So the **Seal namespace is `config.packageId`** and the **`moveCall` target is
`config.latestPackageId`**, they are different addresses on this deployment, and getting either
backwards fails a long way from the mistake. The module asks `sealPackageId()` for the namespace and
lets the SDK's builders choose the target; it never writes either literal.

---

## 3. The interface

```ts
new SealDecryptor({
  config,            // ProjectXSocialConfig — packageId namespaces, latestPackageId is the target
  key,               // AgentKey from src/keys.ts: { address, keypair }
  seal?,             // SealConfig from loadSealConfig() — the key server committee
  suiClient?,        // SuiGrpcClient; defaults to createClient(config). gRPC only, always
  aggregators?,      // defaults to PUBLIC_WALRUS_AGGREGATORS
  fetch?, sleep?, sessionTtlMin?, recoverKey?,
})

decryptor.decrypt({
  blobId,            // Walrus blob holding the ciphertext
  sealWrappedKey,    // base64 Seal EncryptedObject
  nonce,             // base64, 12 bytes
  sha256,            // lower-case hex of the PLAINTEXT, recorded at publish
  approval,          // SealApproval — see below
}): Promise<Uint8Array>
```

```ts
type SealApproval =
  | { kind: 'unlock'; vaultId: string; contentKey: string; unlockId: string }
  | { kind: 'subscription'; vaultId: string; tier: bigint; period: bigint; subscriptionId: string };
```

Also exported: `identityForApproval`, `approvalTransactionFor`, `makeEntitlementRefsResolvable`,
`openBlob`, `sha256Hex`, `looksLikeSettling`, `PUBLIC_WALRUS_AGGREGATORS`, `SealHashMismatchError`,
`RecoverKey`, `SealDecryptorOptions`, `SealedRef`.

`decrypt` **throws** rather than returning a `Reading`. The estate uses `Reading` where a failure is
a fact the caller routes on; here every failure means the agent does not have the content, and the
one failure that must be impossible to ignore is the hash mismatch. A value a caller can forget to
check is the wrong shape for *these bytes are not the bytes*.

### What `decrypt` does, in order

1. Derive the identity from the approval, using the SDK's `unlockIdentity` / `periodIdentity`.
2. Parse the wrapped key and **refuse if the identity it was sealed to is not the one the approval
   covers.** Free, local, and it turns a `MoveAbort EWrongIdentity` — which reads exactly like *you
   have no entitlement* — into a sentence naming both identities.
3. Fetch the ciphertext from the first Walrus aggregator that answers.
4. Build the approval transaction and serialise it `onlyTransactionKind`.
5. Ask the committee for the key, retrying a settling refusal up to four times.
6. Open the blob with AES-256-GCM. A single altered byte fails on the tag.
7. **Verify the SHA-256 against what the publisher recorded, and throw `SealHashMismatchError` if it
   does not match.** Only then return.

Step 3 comes before step 5 deliberately, and this differs from the browser on purpose: a Walrus read
is public, free and unmetered, while a key server request carries an API key and is rate-limited. An
expired storage lease is an ordinary failure and discovering it after spending a metered request is
waste. Sequential, not parallel, for the same reason.

---

## 4. A live defect this module works around

**`packages/sdk/src/seal.ts`'s `entitlementRef()` builds an approval that cannot be built.**

It declares each entitlement `{ objectId, mutable: false }` to save a chain round trip. But
`@mysten/sui` treats `mutable` as a *shared-object* property and refuses when such an input resolves
to an owned one — `src/transactions/TransactionData.ts:512`, read directly:

```ts
// Objects with shared object properties should not resolve to owned objects
original.mutable != null ||
```

`Unlock` and `Subscription` are owned. Measured on mainnet against real objects, 2026-08-31:

| built by | against | result |
|---|---|---|
| `packages/web/lib/seal-open.ts` `approvalFor` (unlock) | `0x405bbf4a…` | **FAIL** — `Input at index 1 did not match unresolved object` |
| `packages/web/lib/seal-open.ts` `approvalFor` (subscription) | `0x5524552c…` | **FAIL** — `Input at index 3 did not match unresolved object` |
| plain `tx.object(id)` | `0x405bbf4a…` | OK, 207 bytes |
| `{ mutable: true }` | `0x405bbf4a…` | **FAIL** — it is the *key* that offends, not the value |

The clause is present in `@mysten/sui` 2.24.0, 2.26.2, 2.27.0 and 2.27.1, so nothing regressed: the
approval has never been buildable this way. **The shipped browser reader is affected** —
`SealedBody.tsx` and `SealedMedia.tsx` both call `approvalFor` and then `tx.build({ client })`. The
end-to-end proof recorded in `UPDATE.md` on 2026-08-31 was run by hand and did not go through those
builders.

`makeEntitlementRefsResolvable()` removes the key on the way past, as a build plugin that runs before
the resolver, skipping anything that declares an `initialSharedVersion` because `mutable` is
meaningful on a genuinely shared object.

**The real fix is to drop `mutable` from `entitlementRef()` in the SDK,** which is not this package's
file to edit. When that lands, the first assertion in the *"reproduces the defect"* test starts
failing — delete the plugin then, and do not weaken the test.

---

## 5. What is reused, and what is transcribed

Reused, never re-derived:

- `unlockIdentity` / `periodIdentity` / `sealId` / `sealPackageId` — SDK, held byte-for-byte against
  `entitlement.move` by tests in **both** languages.
- `approveUnlock` / `approveSubscription` / `approvalBytes` — SDK. **Nothing here hand-rolls a
  `moveCall`.**

`approvalFor` from `packages/web/lib/seal-open.ts` is *not* imported by the module: `packages/web` is
a Next.js app with no package exports, and a publishable package must not reach into it. The test
loads it at runtime and asserts the two transactions are **byte-identical** for both entitlement
kinds, which is a stronger guard than the import would have been.

Transcribed, because the source cannot be imported:

- the AES-256-GCM layout from `packages/web/lib/blob-crypto.ts` (`import 'server-only'` throws
  outside a Next server bundle). The test reads that file and asserts it still says 32 / 12 / 16 and
  still appends the tag — the register `packages/sdk/test/drift.test.ts` established.
- the two public Walrus aggregators, which `SealedBody.tsx` also holds privately. The test asserts
  both lists agree. When one of those operators goes away, the right fix is one shared configured
  value, not a third copy.

`PUBLIC_WALRUS_AGGREGATORS` is the only defaulted endpoint in this module, against the estate's usual
rule, and the difference is worth stating: every byte fetched is checked twice — by GCM's tag and by
the publisher's SHA-256 — so a wrong or hostile aggregator can refuse and can do nothing else. A
defaulted *key server*, by contrast, is unrecoverable, which is why `loadSealConfig` still refuses to
default one.

---

## 6. What is NOT proven

Stated plainly rather than left for somebody to discover.

- **No key server has released a key to an agent.** There are no open Seal key servers on Sui
  mainnet; every provider is permissioned and enrolling one costs money, which is prohibited for any
  agent. `recoverKeyFromCommittee` is written against the installed SDK and has never executed. The
  seam exists so everything around it could be proven; the seam itself could not be.
- **No end-to-end decrypt of real Weir content.** That needs an entitlement, and an entitlement needs
  a purchase. Nothing in the test suite spends money and nothing in it requires one.
- The retry policy's *timings* are asserted; the claim that a fullnode's indexing lag is what
  produces those refusals is read from the existing code's own notes, not measured here.

## 7. Reproducing the live measurements

Free reads only — no funds, no purchase, no key server.

```ts
// packages/agent, run with tsx
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { createClient } from '@projectx-social/sdk';
import { SealDecryptor, PUBLIC_WALRUS_AGGREGATORS } from './src/seal-node.js';

const config = { /* mainnet ids from sui-contracts/deploy/mainnet.json + latest 0xfa7eb18b… */ };
const keypair = Ed25519Keypair.generate();
const d = new SealDecryptor({ config, key: { address: keypair.toSuiAddress(), keypair },
                              suiClient: createClient(config) });

await d.approvalBytesFor({ kind: 'unlock',
  vaultId: '0xa1f80da9efffa73a2617163f5f35249130972e4f6e0bfd2bf7396c584423fd6d',
  contentKey: 'sealed-on-walrus-001',
  unlockId: '0x405bbf4ac0334bf325aa53992356be4e1fb138c99cc0580bb0e819a50f5af4e5' });

const cert = await (await d.sessionKey()).getCertificate();   // signed by the keypair, no wallet

await fetch(`${PUBLIC_WALRUS_AGGREGATORS[0]}/v1/blobs/ZqPLyhQFhpDUXNht2DBNly7NjSfTbv-2Vxm94o0LeMI`);
```

## 8. Open, for whoever owns `packages/agent/package.json`

`@mysten/seal` is **not** declared in this package's dependencies and this module imports it. It
resolves today only because the workspace has it installed elsewhere. It needs adding as
`"@mysten/seal": "1.4.6"`, pinned exactly, matching `packages/web`. An undeclared dependency is a
build that works on one machine.
