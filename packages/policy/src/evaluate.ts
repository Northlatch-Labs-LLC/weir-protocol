// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The evaluator.
 *
 * # What a decision is, and what it is not
 *
 * `allow` is a permission to *offer* a signature. It is not a promise that the transaction will
 * succeed, that the price is fair, or that the counterparty is honest. It says one thing: what the
 * simulation showed is inside what the operator wrote down.
 *
 * `deny` always carries a reason written for the person who has to decide whether to widen the
 * policy. "denied by rule 7" tells them nothing; they need to know which command, which address,
 * which coin type, and how far over the line it was.
 *
 * # There is no third outcome, and no way to force one
 *
 * There is no `allowWithWarning`, no `override` argument and no `force` flag. A caller who wants a
 * different answer must change the policy document, which is hashed into the audit trail — so the
 * widening is visible afterwards, at the exact entry where it first took effect. A runtime
 * override would be invisible in exactly the record that exists to make it visible.
 */

import type { SimulatedEffects } from './effects.js';
import type { LedgerState } from './ledger.js';
import type { PolicyDoc } from './policy.js';
import { RULES, type Rule, type RuleId } from './rules.js';

export type Decision =
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string; readonly ruleId: RuleId };

/**
 * Evaluate a simulation against a policy and the agent's prior spending.
 *
 * Pure: no clock, no network, no filesystem, no state carried between calls. The current time
 * arrives on `ledger.nowMs`, so the same three arguments always produce the same decision and an
 * audited decision can be replayed.
 */
export function evaluate(
  effects: SimulatedEffects,
  policy: PolicyDoc,
  ledger: LedgerState,
): Decision {
  return evaluateWith(RULES, effects, policy, ledger);
}

/**
 * Evaluate against an explicit rule list.
 *
 * # This exists for the mutation test, and the mutation test is the point
 *
 * A rule nobody has removed is a rule nobody has tested. `test/mutation.test.ts` calls this with
 * `RULES` minus one entry and asserts that a transaction the full set refuses is permitted by the
 * remainder — which is the only evidence that the deleted rule was carrying the refusal rather
 * than sitting behind another rule that happened to fire first.
 *
 * It is exported rather than kept internal because a test that reaches into a module's privates
 * is a test that stops working the moment the module is reorganised, and this one must never be
 * quietly disabled.
 *
 * **It is not a supported way to relax policy at runtime.** Passing a shortened list here is
 * exactly the override that {@link evaluate} refuses to offer; the audit entry records the policy
 * hash, not the rule list, so a caller doing this would leave a trail that looks compliant. Do not.
 */
export function evaluateWith(
  rules: readonly Rule[],
  effects: SimulatedEffects,
  policy: PolicyDoc,
  ledger: LedgerState,
): Decision {
  const input = { effects, policy, ledger };
  for (const rule of rules) {
    const reason = rule.check(input);
    if (reason !== null) {
      return { allow: false, reason: `[${rule.id}] ${reason}`, ruleId: rule.id };
    }
  }
  return { allow: true };
}

/** The rule list minus one entry, for the mutation test. Returns a new array; `RULES` is frozen. */
export function rulesWithout(id: RuleId): readonly Rule[] {
  return RULES.filter((rule) => rule.id !== id);
}
