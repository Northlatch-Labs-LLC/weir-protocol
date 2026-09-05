// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Type-level assertions. **This file is compiled, never executed.**
 *
 * It carries no `.test.` in its name on purpose, so Vitest does not collect it, while
 * `tsconfig.json`'s `include: ["src", "test"]` does compile it. Its assertions are the compiler's
 * output, and `test/interface-variance.test.ts` is what turns that output into a passing or failing
 * test run.
 *
 * # What every `@ts-expect-error` below is really guarding
 *
 * `@ts-expect-error` fails **in both directions**, which is the whole reason it is used here rather
 * than a comment saying "this should not compile":
 *
 *   - If the line still errors, the directive is satisfied and `tsc` is silent.
 *   - If the line **stops** erroring — because somebody widened a type, or restored method syntax,
 *     or deleted a required field — the directive is unused and `tsc` raises **TS2578**.
 *
 * So a hole reopening is not a test that quietly keeps passing; it is a compile failure with a line
 * number. That property is what makes these assertions worth writing down at all.
 *
 * # The defect these exist for
 *
 * `SealDecryptor.decrypt` was declared with METHOD syntax — `decrypt(x): Promise<T>`. Under
 * `strictFunctionTypes`, TypeScript checks method parameters **bivariantly** (a deliberate
 * unsoundness kept for arrays and the DOM) and property-function parameters **contravariantly**.
 * Method syntax therefore accepts an implementation that demands MORE of its argument than the
 * interface promises to supply, in silence.
 *
 * The real implementation demanded `vaultId` and `contentKey` on a `SealApproval` that the
 * interface did not declare. It compiled. At run time it would have derived a Seal identity from
 * `undefined` — the right length, the wrong bytes — and a key server refusing that is
 * indistinguishable from this agent holding no entitlement at all.
 */

import { createAgent } from '../src/index.js';
import type { Agent, ReadOnlyAgent, Reading, SealApproval, SealDecryptor, SealedRef } from '../src/index.js';

// === Machinery ===

/** Fails to instantiate unless `T` is exactly `never`. The whole assertion is the constraint. */
type AssertNever<T extends never> = T;

/** Mutual assignability. `Equal<A, B>` is `true` only when A and B are the same type. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;

/** Fails unless `T` is literally `true`. */
type AssertTrue<T extends true> = T;

/**
 * The keys of `T` that are OPTIONAL.
 *
 * `{} extends Pick<T, K>` is true exactly when `K` may be absent. This is the mechanism that makes
 * the assertions below catch **the next field somebody adds** rather than only today's fields: a
 * new `vaultId?: string` lands in this union and the assertion stops instantiating.
 */
type OptionalKeys<T> = { [K in keyof T]-?: {} extends Pick<T, K> ? K : never }[keyof T];

// === 1. The variance hole itself ===

/**
 * The parameter type of `decrypt`, read off the interface rather than written out.
 *
 * Derived, so this proof tracks the interface instead of pinning a snapshot of it. Change
 * `SealedRef` and this changes with it; the assertions below keep meaning what they say.
 */
type DecryptParam = Parameters<SealDecryptor['decrypt']>[0];

/**
 * `SealedRef` plus one requirement it does not have.
 *
 * Built by intersection rather than by listing fields, so it is "whatever the parameter is today,
 * and one more thing" for ever. An implementation asking for this is demanding MORE than
 * `SealDecryptor` promises — the exact shape of the shipped defect.
 */
type DemandsMore = DecryptParam & { readonly __anExtraRequirement: 'not on SealedRef' };

/*
  THE PROOF.

  Contravariance says `(i: DemandsMore) => …` is assignable to `(i: DecryptParam) => …` only if
  `DecryptParam` is assignable to `DemandsMore`. It is not — it lacks `__anExtraRequirement` — so
  this is an error and the directive is satisfied.

  Restore method syntax on `SealDecryptor.decrypt` and bivariance also accepts the reverse
  direction, the error vanishes, and this directive becomes unused: TS2578, build fails.
*/
export const overSpecifiedDecryptor: SealDecryptor = {
  // NOTE ON PLACEMENT: the directive sits on the MEMBER, not on the declaration. Measured, not
  // guessed — with it on the `export const` line, `tsc` reported TS2322 on the member line anyway
  // and TS2578 "unused directive" on the declaration, i.e. two errors instead of none. An
  // assignability failure inside an object literal is attributed to the offending property.
  // @ts-expect-error — a decryptor demanding MORE than SealDecryptor promises must be REJECTED.
  decrypt: async (_input: DemandsMore) => new Uint8Array(),
};

/** Demanding LESS is sound and must keep compiling. A rule that refuses everything proves nothing. */
export const underSpecifiedDecryptor: SealDecryptor = {
  decrypt: async (_input: Pick<DecryptParam, 'blobId'>) => new Uint8Array(),
};

// === 2. The same proof for the Agent surface ===
//
// Every member of `Agent` is property-function syntax. These pin two of them — the two that move
// money — so a partial reversion is caught as well as a wholesale one.

type QuoteParam = Parameters<Agent['quote']>[0];
type UnlockParam = Parameters<Agent['unlock']>[0];

export const overSpecifiedQuote: Pick<Agent, 'quote'> = {
  // @ts-expect-error — an implementation of `quote` demanding more than `Agent` promises is REJECTED.
  quote: async (_p: QuoteParam & { readonly __extra: true }) => {
    throw new Error('never called');
  },
};

export const overSpecifiedUnlock: Pick<Agent, 'unlock'> = {
  // @ts-expect-error — same for `unlock`, which spends.
  unlock: async (_p: UnlockParam & { readonly __extra: true }) => {
    throw new Error('never called');
  },
};

// === 3. The next field anybody adds ===
//
// A field arriving as OPTIONAL is how this defect recurs in practice: `vaultId?: string` compiles
// against every existing call site, and then it is `undefined` in production. These assertions
// have no field names in them, so they cover fields that do not exist yet.

type UnlockApproval = Extract<SealApproval, { kind: 'unlock' }>;
type SubscriptionApproval = Extract<SealApproval, { kind: 'subscription' }>;

export type _noOptionalOnUnlockApproval = AssertNever<OptionalKeys<UnlockApproval>>;
export type _noOptionalOnSubscriptionApproval = AssertNever<OptionalKeys<SubscriptionApproval>>;
export type _noOptionalOnSealedRef = AssertNever<OptionalKeys<SealedRef>>;

// === 4. One definition of each Seal shape, not two ===
//
// `index.ts` re-exports the types `seal-node.ts` declares instead of restating them. These pin that
// they are the SAME type rather than two that happen to agree today — the failure being guarded
// against is somebody re-inlining the shape into `index.ts` "to avoid the import".

export type _decryptTakesTheRealSealedRef = AssertTrue<Equal<DecryptParam, SealedRef>>;

// === 5. Today's fields, named ===
//
// The generic assertions above are the durable half. This is the anchor: the literal shape of the
// defect that shipped, so the diff that reintroduces it is unmistakable to a human reader.

// @ts-expect-error — an 'unlock' approval without `vaultId` cannot derive an identity.
export const missingVaultId: SealApproval = { kind: 'unlock', contentKey: 'k', unlockId: '0x1' };

// @ts-expect-error — nor without `contentKey`.
export const missingContentKey: SealApproval = { kind: 'unlock', vaultId: '0x1', unlockId: '0x2' };

// @ts-expect-error — a subscription approval without `period` opens a creator's archive for ever.
export const missingPeriod: SealApproval = {
  kind: 'subscription',
  vaultId: '0x1',
  tier: 0n,
  subscriptionId: '0x2',
};

/** The complete shapes, which must keep compiling. */
export const goodApprovals: SealApproval[] = [
  { kind: 'unlock', vaultId: '0x1', contentKey: 'k', unlockId: '0x2' },
  { kind: 'subscription', vaultId: '0x1', tier: 0n, period: 689n, subscriptionId: '0x2', coinType: '0x2::sui::SUI' },
];

// === 6. A read-only agent cannot be asked to sign or spend ===
//
// `createAgent({ keypair: null })` returns a DISTINCT type with no spending member on it. The
// defect this closes was a runtime `TypeError` on a null key; the guarantee that replaces it is
// that a caller holding the keyless agent cannot write the call at all.

/** Every member of `Agent` that needs the key. Mirrors `NEEDS_A_KEY` in `read-only-agent.test.ts`. */
type NeedsAKey =
  | 'address'
  | 'sign'
  | 'session'
  | 'openAccount'
  | 'unlock'
  | 'subscribe'
  | 'tip'
  | 'post'
  | 'send'
  | 'balance';

/** None of those names is a key of `ReadOnlyAgent`. Add one to the interface and this stops instantiating. */
export type _noSigningMemberOnReadOnly = AssertNever<Extract<keyof ReadOnlyAgent, NeedsAKey>>;

/** And the keyed agent has all of them, so the union above is checked against something real. */
export type _keyedAgentHasThemAll = AssertNever<Exclude<NeedsAKey, keyof Agent>>;

/** The read set is a subset of the full agent: one builder, two surfaces. */
export type _readSetIsOnAgent = AssertNever<Exclude<keyof ReadOnlyAgent, keyof Agent>>;

declare const env: Record<string, string | undefined>;

/** The overload chosen by a literal `null` is the read-only one, and nothing wider. */
const keyless = createAgent({ keypair: null, config: env });
export type _nullKeyGivesReadOnly = AssertTrue<Equal<typeof keyless, Reading<ReadOnlyAgent>>>;

export function cannotSpendWithoutAKey(agent: ReadOnlyAgent): void {
  // @ts-expect-error — no `unlock` on a read-only agent. A compile error, not a runtime throw.
  void agent.unlock;
  // @ts-expect-error — no `sign` either; a read session is minted by signing.
  void agent.sign;
  // @ts-expect-error — and no `address`, because there is no key to have one.
  void agent.address;
}

/** The read set compiles on both. */
export function readsCompileOnEither(agent: ReadOnlyAgent): Promise<unknown> {
  return Promise.all([agent.quote({ vaultId: '0x1', contentKey: 'k' }), agent.balanceOf('0x2'), agent.feed({})]);
}

/** Absence is a compile error, not a silently read-only agent. */
// @ts-expect-error — `keypair` must be given: a key, or `null` written out.
export const forgotTheKey = createAgent({ config: env });

// @ts-expect-error — `undefined` is refused; `process.env.X` is `string | undefined` and must be checked first.
export const undefinedKey = createAgent({ keypair: env['PROJECTX_SOCIAL_AGENT_SECRET'], config: env });

/** A value that MAY be null must be branched on. Neither overload accepts the union. */
declare const maybeKey: string | null;
// @ts-expect-error — `string | null` matches neither overload; decide which agent you are building.
export const undecided = createAgent({ keypair: maybeKey, config: env });
