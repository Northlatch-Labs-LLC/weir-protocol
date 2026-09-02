// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The mutation test. **This is the test that makes the other tests worth having.**
 *
 * A policy engine whose rules have never been shown to change an outcome is decoration, and
 * decoration that is trusted is worse than nothing. So for every rule, this test:
 *
 *  1. asserts the full rule set REFUSES a transaction that violates exactly that rule, and names
 *     that rule as the reason — not merely that something refused;
 *  2. deletes the rule and asserts the remaining ten now PERMIT the same transaction.
 *
 * Step 2 is the mutation. Without it, a rule sitting behind another that happened to fire first
 * would look tested. With it, a rule that has been commented out, short-circuited, or made
 * unreachable by an ordering change fails this file immediately.
 *
 * If a rule is ever added without a fixture, `covers every rule exactly once` fails. That is
 * deliberate: an untested rule must not be able to enter the list quietly.
 */

import { describe, expect, it } from 'vitest';
import { RULES, evaluate, evaluateWith, rulesWithout } from '../src/index.js';
import { BASELINE, LEDGER, POLICY, VIOLATIONS } from './fixtures.js';

describe('the baseline', () => {
  it('is permitted by the full rule set, so every denial below is caused by its own mutation', () => {
    expect(evaluate(BASELINE, POLICY, LEDGER)).toEqual({ allow: true });
  });
});

describe('rule coverage', () => {
  it('covers every rule exactly once', () => {
    const ruleIds = RULES.map((r) => r.id).sort();
    const fixtureIds = VIOLATIONS.map((v) => v.ruleId).sort();
    expect(fixtureIds).toEqual(ruleIds);
  });
});

describe.each(VIOLATIONS)('rule $ruleId', ({ ruleId, what, effects, policy, ledger }) => {
  it(`refuses ${what}`, () => {
    const decision = evaluate(effects, policy, ledger);
    expect(decision.allow).toBe(false);
    // Named, not merely denied. A fixture that trips a different rule would prove nothing about
    // the rule it was written for.
    expect(decision.allow === false && decision.ruleId).toBe(ruleId);
  });

  it(`is permitted once ${ruleId} is deleted — so the rule carries the refusal`, () => {
    const mutated = evaluateWith(rulesWithout(ruleId), effects, policy, ledger);
    expect(mutated).toEqual({ allow: true });
  });
});
