// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * One baseline that every rule permits, and one minimal violation per rule.
 *
 * # The discipline these fixtures enforce
 *
 * Each violation below breaks **exactly one** rule. That is what makes the mutation test mean
 * something: if a fixture broke two rules, deleting one of them would leave the other still
 * refusing, the mutation test would still see a denial, and it would report a passing rule that
 * had in fact been deleted. A fixture that violates two rules is a mutation test that cannot fail.
 *
 * The baseline is a real shape. `SUI_TYPE` and the balance-change form are copied from a live
 * mainnet simulation on `@mysten/sui` 2.27.1, 2026-08-31 — the padded 64-hex coin type and the
 * signed decimal string amount, both exactly as the node wrote them.
 */

import type { LedgerState, PolicyDoc, SimulatedEffects } from '../src/index.js';
import type { RuleId } from '../src/rules.js';

/** The agent. Padded form, as the chain reports it. */
export const AGENT = '0xda784b6c20c5995f6b719a20a26eddee5ec971c8ecec890e61c8b4634dd1715d';

/** A creator's address, allowed as nothing — it receives value, it is never a transfer target. */
export const CREATOR = '0x00000000000000000000000000000000000000000000000000000000000000aa';

/** Someone the policy has never heard of. */
export const STRANGER = '0x00000000000000000000000000000000000000000000000000000000000000bb';

/** Exactly as a live mainnet simulation reported it, padding included. */
export const SUI_TYPE =
  '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';

/** A second coin type, so "unlisted coin" can be tested without touching the SUI ceiling. */
export const USDC_TYPE =
  '0x00000000000000000000000000000000000000000000000000000000000000dd::usdc::USDC';

export const PACKAGE = '0x00000000000000000000000000000000000000000000000000000000000000c5';

export const UNLOCK = `${PACKAGE}::creator::unlock`;
export const CLAIM_EARNINGS = `${PACKAGE}::creator::claim_earnings`;

/**
 * The four objects a legitimate `creator::unlock` takes, and the one an attacker substitutes.
 *
 * `PLATFORM` is the real mainnet id, read live from chain on 2026-08-30 and recorded in
 * `UPDATE.md`. The rest are fixture ids in the padded form the node reports.
 *
 * `CLOCK` is written **short** in the policy and **padded** in the effects on purpose. `0x6` is
 * what a human and every config file writes; `0x000…006` is what the simulator returns. If the
 * two sides were not both normalised, the Clock would be refused on every call the agent ever
 * makes, and the failure would look like a policy that had already listed it.
 */
export const PLATFORM = '0x3f695b2c32714e2359c4bb9515598d8dd765b216148c5b8fa818073d52b50f36';
export const CLOCK_SHORT = '0x6';
export const CLOCK_PADDED = '0x0000000000000000000000000000000000000000000000000000000000000006';
/** The agent's own `SocialAccount`. Owned, and its id never changes — `account.move:174`. */
export const ACCOUNT = '0x00000000000000000000000000000000000000000000000000000000000000e1';
/** The `CreatorVault` the principal authorised the agent to buy from. */
export const VAULT = '0x00000000000000000000000000000000000000000000000000000000000000c0';
/** A vault the attacker opened for 29 SUI. Same type, same module, same function. */
export const ATTACKER_VAULT = '0x00000000000000000000000000000000000000000000000000000000000000ba';

/**
 * A policy for an agent that may buy content in SUI and nothing else.
 *
 * Note what is deliberately absent: `claim_earnings` is not in `allowedTargets`, `USDC` has no
 * ceiling, and the only permitted transfer recipient is the agent itself.
 */
export const POLICY: PolicyDoc = {
  version: 1,
  agentAddress: AGENT,
  outflowCeilings: [{ coinType: '0x2::sui::SUI', maxPerPeriod: '10000000', periodMs: 86_400_000 }],
  allowedTargets: [UNLOCK],
  allowedTypeArguments: ['0x2::sui::SUI'],
  allowedRecipients: [AGENT],
  // The Clock is written in the short spelling a human uses; the node reports it padded.
  allowedObjects: [PLATFORM, VAULT, ACCOUNT, CLOCK_SHORT],
  maxGasBudgetMist: '20000000',
  allowedCommandKinds: ['MoveCall', 'SplitCoins', 'TransferObjects'],
};

/** Nothing spent yet. `nowMs` is fixed so window arithmetic in tests is exact. */
export const NOW = 1_788_000_000_000;
export const LEDGER: LedgerState = { nowMs: NOW, spend: [] };

/**
 * A transaction this policy permits: split a coin, unlock content, send the change home.
 *
 * The SUI outflow is 1_088_000 — the exact figure a live mainnet simulation reported for a
 * one-MIST self-transfer, which is very nearly all gas. It is used here to keep the reminder in
 * front of a reader that **gas is part of the SUI outflow a ceiling counts**.
 */
export const BASELINE: SimulatedEffects = {
  sender: AGENT,
  gasBudgetMist: '1188000',
  balanceChanges: [
    { coinType: SUI_TYPE, address: AGENT, amount: '-1088000' },
    { coinType: SUI_TYPE, address: CREATOR, amount: '1000000' },
  ],
  balanceChangesObserved: true,
  moveCalls: [{ index: 1, target: UNLOCK, typeArguments: [SUI_TYPE] }],
  transfers: [{ index: 2, recipient: AGENT }],
  commandKinds: ['SplitCoins', 'MoveCall', 'TransferObjects'],
  /*
    The object arguments of `creator::unlock`, in the input positions a real call puts them.

    Indexes 1 and 4 are missing because they are `Pure` inputs — the split amount and the
    `content_key: vector<u8>` — and a Pure input is not an object. All four objects are referenced
    by command 1, the MoveCall; the SplitCoins and TransferObjects commands reference the gas coin
    and a Pure address, neither of which is an object input either.
  */
  objectInputs: [
    { index: 0, objectId: PLATFORM, ownership: 'shared', commandIndexes: [1] },
    { index: 2, objectId: VAULT, ownership: 'shared', commandIndexes: [1] },
    { index: 3, objectId: ACCOUNT, ownership: 'imm-or-owned', commandIndexes: [1] },
    { index: 5, objectId: CLOCK_PADDED, ownership: 'shared', commandIndexes: [1] },
  ],
  observedAtMs: NOW,
};

export interface Violation {
  readonly ruleId: RuleId;
  readonly what: string;
  readonly effects: SimulatedEffects;
  readonly policy: PolicyDoc;
  readonly ledger: LedgerState;
}

/**
 * One minimal violation per rule, in the same order as `RULES`.
 *
 * `test/mutation.test.ts` asserts this list covers every id in `RULES` exactly once, so adding a
 * rule without adding a fixture fails the build rather than quietly going untested.
 */
export const VIOLATIONS: readonly Violation[] = [
  {
    ruleId: 'policy-version',
    what: 'a policy document from a schema this evaluator does not understand',
    effects: BASELINE,
    policy: { ...POLICY, version: 2 as unknown as 1 },
    ledger: LEDGER,
  },
  {
    ruleId: 'sender-mismatch',
    what: 'a simulation belonging to a different address than the policy governs',
    effects: { ...BASELINE, sender: STRANGER },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'command-kind',
    what: 'a Publish command, which has no target and no recipient to check',
    effects: { ...BASELINE, commandKinds: ['SplitCoins', 'MoveCall', 'TransferObjects', 'Publish'] },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'move-call-target',
    what: 'claim_earnings called by an agent authorised only to buy',
    effects: {
      ...BASELINE,
      moveCalls: [{ index: 1, target: CLAIM_EARNINGS, typeArguments: [SUI_TYPE] }],
    },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'type-argument',
    what: 'an allowed function instantiated at a coin type the policy never permitted',
    effects: {
      ...BASELINE,
      moveCalls: [{ index: 1, target: UNLOCK, typeArguments: [USDC_TYPE] }],
    },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'transfer-recipient',
    what: 'the purchased object transferred to a stranger instead of home',
    effects: { ...BASELINE, transfers: [{ index: 2, recipient: STRANGER }] },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'object-input',
    what: "an attacker's vault substituted for the one the principal authorised",
    /*
      This is the fixture that names the hole. Nothing else about the transaction changes: the
      target is still the permitted `creator::unlock`, the type argument is still SUI, the change
      still comes home to the agent, the gas budget is untouched and the outflow is the same
      1_088_000 the baseline spends inside a 10_000_000 ceiling. Every other rule permits it.

      Only the vault argument moved, from the id the principal authorised to one anybody can open
      for 29 SUI — and that argument is the entire answer to whose earnings the payment lands in.
      Delete `object-input` and this transaction is signed.
    */
    effects: {
      ...BASELINE,
      objectInputs: [
        { index: 0, objectId: PLATFORM, ownership: 'shared', commandIndexes: [1] },
        { index: 2, objectId: ATTACKER_VAULT, ownership: 'shared', commandIndexes: [1] },
        { index: 3, objectId: ACCOUNT, ownership: 'imm-or-owned', commandIndexes: [1] },
        { index: 5, objectId: CLOCK_PADDED, ownership: 'shared', commandIndexes: [1] },
      ],
    },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'gas-budget',
    what: 'a gas budget above the ceiling',
    effects: { ...BASELINE, gasBudgetMist: '20000001' },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'balance-evidence',
    what: 'a simulation whose balance changes were never requested',
    effects: { ...BASELINE, balanceChanges: [], balanceChangesObserved: false },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'amount-wellformed',
    what: 'an amount that BigInt would read as zero',
    effects: {
      ...BASELINE,
      // Empty string. `BigInt('')` is `0n`, so an unchecked parse reports no outflow at all —
      // which is why `coin-type-unlisted` and `outflow-ceiling` also permit this fixture once
      // `amount-wellformed` is deleted, and why the mutation test for this rule is meaningful.
      balanceChanges: [{ coinType: SUI_TYPE, address: AGENT, amount: '' }],
    },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'coin-type-unlisted',
    what: 'an outflow in a coin type the policy configures no ceiling for',
    effects: {
      ...BASELINE,
      balanceChanges: [{ coinType: USDC_TYPE, address: AGENT, amount: '-1' }],
    },
    policy: POLICY,
    ledger: LEDGER,
  },
  {
    ruleId: 'outflow-ceiling',
    what: 'a spend that is inside the per-transaction figure but over the rolling window total',
    effects: BASELINE,
    policy: POLICY,
    ledger: {
      nowMs: NOW,
      // 9_000_000 already spent in the window; 1_088_000 more takes the total to 10_088_000,
      // which is 88_000 over the 10_000_000 ceiling. Neither figure alone breaches it.
      spend: [{ coinType: '0x2::sui::SUI', amountOut: '9000000', atMs: NOW - 1000 }],
    },
  },
];
