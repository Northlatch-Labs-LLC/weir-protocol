// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The rules, one function each, in a table.
 *
 * # Why a table and not a single `evaluate` function full of `if`s
 *
 * A policy engine whose rules have never been shown to *do* anything is decoration, and it is
 * worse than no engine because it is trusted. The only proof that a rule works is that removing
 * it changes an outcome — so the rules are addressable, `evaluateWith` takes the list, and
 * `test/mutation.test.ts` deletes each rule in turn and asserts that a transaction the full set
 * refuses becomes one the reduced set permits.
 *
 * That test is not a nicety. It is the difference between twelve rules and twelve comments.
 *
 * # First denial wins, and the order is fixed
 *
 * Evaluation stops at the first rule that refuses. The order below is chosen so the earliest
 * refusals are the ones that make later rules meaningless: there is no point reporting a ceiling
 * breach on a document whose schema version we do not understand, or on a simulation belonging to
 * a different address entirely. A caller that wants every violation can call the rules directly;
 * the exported {@link RULES} array is the whole list, in order.
 *
 * # Every rule fails closed
 *
 * A rule that cannot decide — a malformed address, an unparseable amount, a name that does not
 * normalise — refuses. None of them return "pass" on input they did not understand. This is the
 * property that makes an unrecognised future command kind, a renamed field or a corrupted policy
 * file a refusal rather than a signature.
 */

import { outflowMagnitude, parseSignedAmount, parseUnsignedAmount } from './amounts.js';
import type { SimulatedEffects } from './effects.js';
import type { LedgerState } from './ledger.js';
import { normaliseAddress, normaliseTarget, normaliseType } from './names.js';
import type { PolicyDoc } from './policy.js';

export type RuleId =
  | 'policy-version'
  | 'sender-mismatch'
  | 'command-kind'
  | 'move-call-target'
  | 'type-argument'
  | 'transfer-recipient'
  | 'object-input'
  | 'gas-budget'
  | 'balance-evidence'
  | 'amount-wellformed'
  | 'coin-type-unlisted'
  | 'outflow-ceiling';

export interface RuleInput {
  readonly effects: SimulatedEffects;
  readonly policy: PolicyDoc;
  readonly ledger: LedgerState;
}

export interface Rule {
  readonly id: RuleId;
  /** One line, for the mutation table and for a reviewer reading the list rather than the code. */
  readonly summary: string;
  /**
   * Property-function syntax, not a method.
   *
   * `check(input: RuleInput): string | null` and `check: (input: RuleInput) => string | null`
   * differ in TypeScript: method parameters are compared **bivariantly** and property-function
   * parameters **contravariantly**. Under the method form a rule declared to take a narrower
   * input than `RuleInput` is accepted silently, and it then reads a field the caller never
   * promised. That exact hole let an under-specified implementation through on this branch once
   * already, which is why every interface member in these two packages is written this way.
   */
  readonly check: (input: RuleInput) => string | null;
}

/** Normalise the agent's own address once; `null` if the policy names something that is not one. */
function agentAddress(policy: PolicyDoc): string | null {
  return normaliseAddress(policy.agentAddress);
}

const policyVersion: Rule = {
  id: 'policy-version',
  summary: 'The policy document must declare schema version 1.',
  check: ({ policy }) =>
    policy.version === 1
      ? null
      : `policy document declares version ${String(policy.version)}; this evaluator understands ` +
        `only version 1. Reading a newer document as version 1 would apply the fields it happens ` +
        `to recognise and silently ignore every restriction it does not.`,
};

const senderMismatch: Rule = {
  id: 'sender-mismatch',
  summary: 'The simulated sender must be the address the policy governs.',
  check: ({ effects, policy }) => {
    const expected = agentAddress(policy);
    if (expected === null) {
      return `policy agentAddress ${JSON.stringify(policy.agentAddress)} is not a Sui address.`;
    }
    const actual = normaliseAddress(effects.sender);
    if (actual === null) {
      return `the simulation reports sender ${JSON.stringify(effects.sender)}, which is not a ` +
        `Sui address.`;
    }
    return actual === expected
      ? null
      : `this policy governs ${expected} but the transaction would be signed by ${actual}. ` +
        `A ceiling counted against one address says nothing about spending by another.`;
  },
};

const commandKind: Rule = {
  id: 'command-kind',
  summary: 'Every command kind in the transaction must be explicitly permitted.',
  check: ({ effects, policy }) => {
    const allowed = new Set(policy.allowedCommandKinds);
    for (let i = 0; i < effects.commandKinds.length; i += 1) {
      const kind = effects.commandKinds[i]!;
      if (!allowed.has(kind)) {
        return `command ${i} is a ${kind}, which this policy does not permit. A command kind ` +
          `with no rule of its own — Publish and Upgrade have no target to allow-list and no ` +
          `recipient to check — is refused here rather than passing through unexamined.`;
      }
    }
    return null;
  },
};

const moveCallTarget: Rule = {
  id: 'move-call-target',
  summary: 'Every MoveCall target must appear in the allow-list.',
  check: ({ effects, policy }) => {
    const allowed = new Set<string>();
    for (const entry of policy.allowedTargets) {
      const normalised = normaliseTarget(entry);
      if (normalised === null) {
        return `allowedTargets contains ${JSON.stringify(entry)}, which is not a valid ` +
          `address::module::function. A malformed allow-list entry matches nothing, so the rule ` +
          `it was meant to relax would silently deny for a reason invisible in the policy file.`;
      }
      allowed.add(normalised);
    }

    for (const call of effects.moveCalls) {
      const normalised = normaliseTarget(call.target);
      if (normalised === null) {
        return `command ${call.index} calls ${JSON.stringify(call.target)}, which does not parse ` +
          `as a Move call target.`;
      }
      if (!allowed.has(normalised)) {
        return `command ${call.index} calls ${normalised}, which is not in this policy's ` +
          `allowedTargets. An agent authorised to buy must not also be able to call ` +
          `claim_earnings; nothing on chain distinguishes them, so this list does.`;
      }
    }
    return null;
  },
};

const typeArgument: Rule = {
  id: 'type-argument',
  summary: 'Every type argument of every MoveCall must appear in the allow-list.',
  check: ({ effects, policy }) => {
    const allowed = new Set<string>();
    for (const entry of policy.allowedTypeArguments) {
      const normalised = normaliseType(entry);
      if (normalised === null) {
        return `allowedTypeArguments contains ${JSON.stringify(entry)}, which is not a valid ` +
          `Move type.`;
      }
      allowed.add(normalised);
    }

    for (const call of effects.moveCalls) {
      for (const argument of call.typeArguments) {
        const normalised = normaliseType(argument);
        if (normalised === null) {
          return `command ${call.index} is instantiated with ${JSON.stringify(argument)}, which ` +
            `does not parse as a Move type.`;
        }
        if (!allowed.has(normalised)) {
          return `command ${call.index} is instantiated with ${normalised}, which is not in this ` +
            `policy's allowedTypeArguments. The same function at a different coin type is a ` +
            `different money path, and an allow-list on the target alone does not see the ` +
            `difference.`;
        }
      }
    }
    return null;
  },
};

const transferRecipient: Rule = {
  id: 'transfer-recipient',
  summary: 'Every TransferObjects recipient must appear in the allow-list.',
  check: ({ effects, policy }) => {
    const allowed = new Set<string>();
    for (const entry of policy.allowedRecipients) {
      const normalised = normaliseAddress(entry);
      if (normalised === null) {
        return `allowedRecipients contains ${JSON.stringify(entry)}, which is not a Sui address.`;
      }
      allowed.add(normalised);
    }

    for (const transfer of effects.transfers) {
      const normalised = normaliseAddress(transfer.recipient);
      if (normalised === null) {
        return `command ${transfer.index} transfers to ${JSON.stringify(transfer.recipient)}, ` +
          `which is not a Sui address.`;
      }
      if (!allowed.has(normalised)) {
        return `command ${transfer.index} transfers objects to ${normalised}, which is not in ` +
          `this policy's allowedRecipients. Change coins and purchased entitlements belong back ` +
          `at the agent's own address; any other destination is an exfiltration path that costs ` +
          `no coin balance and so no ceiling would notice it.`;
      }
    }
    return null;
  },
};

/**
 * The twelfth rule, and the one the other eleven leave a hole under.
 *
 * # What the other eleven do not bound
 *
 * `move-call-target` bounds the verb. `type-argument` bounds the currency. `transfer-recipient`
 * bounds where objects end up. `outflow-ceiling` and `gas-budget` bound the size. Between them
 * they describe a transaction completely — except for **which objects it acts on**.
 *
 * On this protocol that gap is the whole payment. `creator::unlock` is declared
 * (`sui-contracts/sources/creator.move:661`) as:
 *
 * ```move
 * public fun unlock<T>(
 *     platform: &Platform,
 *     vault: &mut CreatorVault<T>,   // <- this argument decides who is paid
 *     buyer: &SocialAccount,
 *     content_key: vector<u8>,
 *     mut payment: Coin<T>,
 *     clock: &Clock,
 *     ctx: &mut TxContext,
 * ): Coin<T>
 * ```
 *
 * Swap the vault and everything else still passes: the permitted target, the permitted coin type,
 * the change transferred home to the agent, the spend inside the rolling ceiling. Eleven rules
 * report allow and the money lands in a stranger's vault. Vault creation is open to anyone for
 * 29 SUI (`UPDATE.md`, 2026-08-30, read live from mainnet), so the attacker supplies the
 * destination, it costs them almost nothing, and the agent will do it again on the next
 * instruction. The ceiling caps a single drain; it does not stop one.
 *
 * # Why this cannot simply refuse shared objects
 *
 * The obvious defence — treat every shared object as suspect — refuses every legitimate call in
 * the same breath. `unlock` takes the `Platform` and the `Clock` as shared objects too, and both
 * are mandatory. A rule that fired on shared-ness would deny the transaction it exists to permit,
 * would be turned off within a day, and would then be a comment. So the discrimination is by
 * **id**, from a list the operator writes, exactly like every other allow-list in this package.
 *
 * # Why an unclassified input is refused rather than skipped
 *
 * An input whose shape the translator could not read carries no id that can be compared. Skipping
 * it produces a shorter list, and a shorter list is a *cleaner-looking* transaction — the vault
 * argument would simply not be there, and this rule would find nothing to object to. So
 * `ownership: 'unclassified'` refuses on sight, before any id comparison. The same fail-closed
 * reasoning as `command-kind`: a shape nobody has looked at is not a shape anybody has approved.
 */
const objectInput: Rule = {
  id: 'object-input',
  summary: 'Every object the transaction takes as an input must appear in the allow-list.',
  check: ({ effects, policy }) => {
    /*
      Absence means opposite things on the two sides, and both readings are the strict one.

      On the POLICY side an absent or malformed `allowedObjects` is read as the EMPTY list, which
      permits no object at all. A document written before this evaluator bounded objects said
      nothing about which vault may be paid, and "said nothing" is not "said yes". Reading it as
      empty refuses every object input it ever sees; the only transaction it still permits is one
      that takes no object inputs, which has no vault in it to get wrong.

      On the EVIDENCE side an absent `objectInputs` is read as UNKNOWN and refused outright — the
      same distinction `balance-evidence` draws. An empty list is the translator stating that the
      transaction takes no objects. A missing list is nobody stating anything, and a policy engine
      that treats silence about the destination as an empty destination is one that signs.
    */
    if (!Array.isArray(effects.objectInputs)) {
      return `the simulation carries no object-input evidence at all. An empty list and an ` +
        `absent one are different facts — one says this transaction touches no objects, the ` +
        `other says nobody looked — and only the first can be weighed against an allow-list. ` +
        `The vault argument decides who gets paid, so an unexamined input list is an unbounded ` +
        `destination.`;
    }

    const declared = Array.isArray(policy.allowedObjects) ? policy.allowedObjects : [];
    const allowed = new Set<string>();
    for (const entry of declared) {
      // Object ids are 32-byte addresses and fold exactly like one, so the same normaliser
      // applies. A policy written with `0x6` for the Clock must match the padded `0x000…006` the
      // node reports, or the rule would deny every call for a reason invisible in the file.
      const normalised = normaliseAddress(entry);
      if (normalised === null) {
        return `allowedObjects contains ${JSON.stringify(entry)}, which is not a Sui object id. ` +
          `A malformed allow-list entry matches nothing, so the vault it was meant to authorise ` +
          `would be refused and the policy file would look as though it had already permitted it.`;
      }
      allowed.add(normalised);
    }

    for (const input of effects.objectInputs) {
      const where = input.commandIndexes.length === 0
        ? 'referenced by no command this reader recognised'
        : `referenced by command ${input.commandIndexes.join(', ')}`;

      if (input.ownership === 'unclassified') {
        return `input ${String(input.index)}, ${where}, is an object whose shape this reader ` +
          `could not classify, so the id it carries cannot be trusted or compared. It is refused ` +
          `rather than skipped: skipping it would shorten the input list, and a transaction that ` +
          `appears to touch no objects is one this rule has nothing to say about — which is ` +
          `exactly how the argument that decides who gets paid would go past unexamined.`;
      }

      const normalised = normaliseAddress(input.objectId);
      if (normalised === null) {
        return `input ${String(input.index)}, ${where}, names the object ` +
          `${JSON.stringify(input.objectId)}, which is not a Sui object id.`;
      }

      if (!allowed.has(normalised)) {
        return `input ${String(input.index)} is the object ${normalised} (${input.ownership}), ` +
          `${where}, and it is not in this policy's allowedObjects. Every other rule can pass ` +
          `while this one does not: the call can be the permitted creator::unlock, at the ` +
          `permitted coin type, with the Unlock transferred home to the agent and the whole ` +
          `spend inside the ceiling — and still pay a stranger's CreatorVault, because the vault ` +
          `argument is what chooses whose earnings the payment lands in. Anyone can open a vault ` +
          `for 29 SUI, so that destination is attacker-supplied and repeatable, and no ceiling ` +
          `notices it. If ${normalised} is a vault the agent is meant to buy from, add it; the ` +
          `Platform, the Clock and the agent's own SocialAccount belong in the same list.`;
      }
    }
    return null;
  },
};

const gasBudget: Rule = {
  id: 'gas-budget',
  summary: 'The gas budget must not exceed the policy ceiling.',
  check: ({ effects, policy }) => {
    const ceiling = parseUnsignedAmount(policy.maxGasBudgetMist);
    if (ceiling === null) {
      return `policy maxGasBudgetMist is ${JSON.stringify(policy.maxGasBudgetMist)}, which is ` +
        `not an unsigned decimal integer.`;
    }
    const budget = parseUnsignedAmount(effects.gasBudgetMist);
    if (budget === null) {
      return `the simulation reports a gas budget of ${JSON.stringify(effects.gasBudgetMist)}, ` +
        `which is not an unsigned decimal integer.`;
    }
    return budget <= ceiling
      ? null
      : `gas budget ${budget.toString()} MIST exceeds the policy ceiling of ` +
        `${ceiling.toString()} MIST. Gas is spendable value that leaves the agent whether the ` +
        `transaction succeeds or aborts, so an unbounded budget is an unbounded loss on a ` +
        `transaction that buys nothing.`;
  },
};

const balanceEvidence: Rule = {
  id: 'balance-evidence',
  summary: 'Balance changes must have been observed, not merely absent.',
  check: ({ effects }) =>
    effects.balanceChangesObserved
      ? null
      : `the simulation carries no balance-change evidence. An empty list of changes and a list ` +
        `that was never requested are different facts — one says this transaction moves no ` +
        `money, the other says we do not know what it moves — and only the first is safe to ` +
        `weigh against a spending ceiling.`,
};

const amountWellformed: Rule = {
  id: 'amount-wellformed',
  summary: 'Every reported balance-change amount must parse as a decimal integer.',
  check: ({ effects }) => {
    for (const change of effects.balanceChanges) {
      if (parseSignedAmount(change.amount) === null) {
        return `a balance change for ${change.coinType} reports the amount ` +
          `${JSON.stringify(change.amount)}, which is not a decimal integer. BigInt('') is 0n, ` +
          `so an unchecked parse would turn an unreadable amount into a zero outflow and report ` +
          `that a spend did not happen.`;
      }
    }
    return null;
  },
};

/**
 * Every coin type the agent loses value in, with the magnitude summed.
 *
 * Only the agent's own address is counted. A counterparty's balance changing is the transaction
 * working, not the agent spending. Unparseable amounts are skipped here because
 * `amount-wellformed` has already refused them; when that rule is deleted by the mutation test
 * this must still not throw, which is why the parse is checked again rather than assumed.
 */
function agentOutflows(
  effects: SimulatedEffects,
  agent: string,
): Map<string, bigint> | { readonly error: string } {
  const totals = new Map<string, bigint>();

  for (const change of effects.balanceChanges) {
    const address = normaliseAddress(change.address);
    if (address === null) {
      return { error: `a balance change names ${JSON.stringify(change.address)}, not an address.` };
    }
    if (address !== agent) continue;

    const amount = parseSignedAmount(change.amount);
    if (amount === null) continue;

    const magnitude = outflowMagnitude(amount);
    if (magnitude === null) continue;

    const coinType = normaliseType(change.coinType);
    if (coinType === null) {
      return {
        error: `a balance change names the coin type ${JSON.stringify(change.coinType)}, which ` +
          `does not parse as a Move type, so no ceiling can be matched to it.`,
      };
    }

    totals.set(coinType, (totals.get(coinType) ?? 0n) + magnitude);
  }

  return totals;
}

function isError(value: unknown): value is { readonly error: string } {
  return typeof value === 'object' && value !== null && 'error' in value;
}

const coinTypeUnlisted: Rule = {
  id: 'coin-type-unlisted',
  summary: 'A coin type with no configured ceiling may not leave the agent at all.',
  check: ({ effects, policy }) => {
    const agent = agentAddress(policy);
    if (agent === null) return `policy agentAddress is not a Sui address.`;

    const outflows = agentOutflows(effects, agent);
    if (isError(outflows)) return outflows.error;

    const configured = new Set<string>();
    for (const ceiling of policy.outflowCeilings) {
      const coinType = normaliseType(ceiling.coinType);
      if (coinType === null) {
        return `an outflowCeiling names the coin type ${JSON.stringify(ceiling.coinType)}, which ` +
          `is not a valid Move type. A ceiling that cannot be matched to a coin is a ceiling ` +
          `that never applies.`;
      }
      configured.add(coinType);
    }

    for (const [coinType, magnitude] of outflows) {
      if (!configured.has(coinType)) {
        return `${magnitude.toString()} of ${coinType} would leave the agent, and this policy ` +
          `configures no ceiling for that coin type. An unlisted coin is refused rather than ` +
          `treated as unlimited: a policy author who enumerates what an agent may spend has ` +
          `said nothing about the token they had never heard of.`;
      }
    }
    return null;
  },
};

const outflowCeiling: Rule = {
  id: 'outflow-ceiling',
  summary: 'Prior spend in the rolling window plus this outflow must stay under the ceiling.',
  check: ({ effects, policy, ledger }) => {
    const agent = agentAddress(policy);
    if (agent === null) return `policy agentAddress is not a Sui address.`;

    const outflows = agentOutflows(effects, agent);
    if (isError(outflows)) return outflows.error;

    for (const ceiling of policy.outflowCeilings) {
      const coinType = normaliseType(ceiling.coinType);
      if (coinType === null) {
        return `an outflowCeiling names the coin type ${JSON.stringify(ceiling.coinType)}, ` +
          `which is not a valid Move type.`;
      }

      const limit = parseUnsignedAmount(ceiling.maxPerPeriod);
      if (limit === null) {
        return `the ceiling for ${coinType} is ${JSON.stringify(ceiling.maxPerPeriod)}, which ` +
          `is not an unsigned decimal integer.`;
      }

      if (!Number.isInteger(ceiling.periodMs) || ceiling.periodMs <= 0) {
        return `the ceiling for ${coinType} declares periodMs ${String(ceiling.periodMs)}. A ` +
          `window that is zero, negative or fractional cannot contain a prior spend, so the ` +
          `ceiling would apply to this transaction alone and a loop would defeat it.`;
      }

      const windowStart = ledger.nowMs - ceiling.periodMs;
      let prior = 0n;
      for (const entry of ledger.spend) {
        const entryCoinType = normaliseType(entry.coinType);
        if (entryCoinType === null) {
          return `a ledger entry names the coin type ${JSON.stringify(entry.coinType)}, which ` +
            `does not parse. An unreadable record of past spending must not be counted as zero.`;
        }
        if (entryCoinType !== coinType) continue;
        // Inclusive at both ends. An entry recorded at exactly `nowMs - periodMs` is still inside
        // the window; excluding it would open a one-millisecond hole at the boundary.
        if (entry.atMs < windowStart || entry.atMs > ledger.nowMs) continue;

        const amount = parseUnsignedAmount(entry.amountOut);
        if (amount === null) {
          return `a ledger entry for ${coinType} records ${JSON.stringify(entry.amountOut)}, ` +
            `which is not an unsigned decimal integer.`;
        }
        prior += amount;
      }

      const now = outflows.get(coinType) ?? 0n;
      const total = prior + now;
      if (total > limit) {
        return `this transaction would put ${total.toString()} of ${coinType} out in the last ` +
          `${String(ceiling.periodMs)}ms (${prior.toString()} already spent, ${now.toString()} ` +
          `now), above the ceiling of ${limit.toString()}. Note that on SUI this figure includes ` +
          `gas, because gas is an outflow the node reports like any other.`;
      }
    }
    return null;
  },
};

/**
 * The rules, in evaluation order. First denial wins.
 *
 * Exported as the whole list so `evaluateWith` can be handed a subset — which is how the mutation
 * test deletes one rule at a time and proves the remaining ten no longer refuse what the eleven
 * did.
 */
export const RULES: readonly Rule[] = [
  policyVersion,
  senderMismatch,
  commandKind,
  moveCallTarget,
  typeArgument,
  transferRecipient,
  objectInput,
  gasBudget,
  balanceEvidence,
  amountWellformed,
  coinTypeUnlisted,
  outflowCeiling,
];
