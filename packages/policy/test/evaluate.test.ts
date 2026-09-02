// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Behaviour the mutation test cannot reach: window arithmetic, cumulative spend, canonical
 * hashing input, and the shape of a decision.
 */

import { describe, expect, it } from 'vitest';
import { canonicalPolicyJson, evaluate, type PolicyDoc } from '../src/index.js';
import {
  AGENT,
  ATTACKER_VAULT,
  BASELINE,
  CLOCK_PADDED,
  LEDGER,
  NOW,
  POLICY,
  SUI_TYPE,
  USDC_TYPE,
  VAULT,
} from './fixtures.js';

const DAY = 86_400_000;

describe('the rolling window', () => {
  it('counts a spend at the exact start of the window', () => {
    // Inclusive at both ends on purpose. Excluding the boundary opens a one-millisecond hole that
    // a loop can be timed against.
    const decision = evaluate(BASELINE, POLICY, {
      nowMs: NOW,
      spend: [{ coinType: SUI_TYPE, amountOut: '9000000', atMs: NOW - DAY }],
    });
    expect(decision.allow).toBe(false);
  });

  it('ignores a spend one millisecond older than the window', () => {
    const decision = evaluate(BASELINE, POLICY, {
      nowMs: NOW,
      spend: [{ coinType: SUI_TYPE, amountOut: '9000000', atMs: NOW - DAY - 1 }],
    });
    expect(decision).toEqual({ allow: true });
  });

  it('counts many small spends, because a per-transaction cap is defeated by a loop', () => {
    const spend = Array.from({ length: 90 }, (_, i) => ({
      coinType: SUI_TYPE,
      amountOut: '100000',
      atMs: NOW - i * 1000,
    }));
    // 90 × 100_000 = 9_000_000, plus this transaction's 1_088_000 = 10_088_000 > 10_000_000.
    expect(evaluate(BASELINE, POLICY, { nowMs: NOW, spend }).allow).toBe(false);
    // One fewer and it fits.
    expect(evaluate(BASELINE, POLICY, { nowMs: NOW, spend: spend.slice(1) })).toEqual({
      allow: true,
    });
  });

  it('does not count a spend in a different coin type against a ceiling', () => {
    const decision = evaluate(BASELINE, POLICY, {
      nowMs: NOW,
      spend: [{ coinType: USDC_TYPE, amountOut: '9999999999', atMs: NOW }],
    });
    expect(decision).toEqual({ allow: true });
  });

  it('matches a ledger entry written in the short spelling against a padded coin type', () => {
    const decision = evaluate(BASELINE, POLICY, {
      nowMs: NOW,
      spend: [{ coinType: '0x2::sui::SUI', amountOut: '9000000', atMs: NOW }],
    });
    expect(decision.allow).toBe(false);
  });

  it('refuses a window of zero, which would make the ceiling per-transaction', () => {
    const policy: PolicyDoc = {
      ...POLICY,
      outflowCeilings: [{ coinType: SUI_TYPE, maxPerPeriod: '10000000', periodMs: 0 }],
    };
    expect(evaluate(BASELINE, policy, LEDGER).allow).toBe(false);
  });
});

describe('outflow accounting', () => {
  it('does not count a counterparty gaining value as the agent spending', () => {
    expect(evaluate(BASELINE, POLICY, LEDGER)).toEqual({ allow: true });
  });

  it('sums several changes in the same coin for the same address', () => {
    const decision = evaluate(
      {
        ...BASELINE,
        balanceChanges: [
          { coinType: SUI_TYPE, address: AGENT, amount: '-6000000' },
          { coinType: SUI_TYPE, address: AGENT, amount: '-5000000' },
        ],
      },
      POLICY,
      LEDGER,
    );
    // 11_000_000 in one transaction, over the 10_000_000 ceiling. Neither change alone is.
    expect(decision.allow).toBe(false);
  });

  it('permits a spend of exactly the ceiling and refuses one MIST more', () => {
    const at = (amount: string) =>
      evaluate(
        { ...BASELINE, balanceChanges: [{ coinType: SUI_TYPE, address: AGENT, amount }] },
        POLICY,
        LEDGER,
      );
    expect(at('-10000000')).toEqual({ allow: true });
    expect(at('-10000001').allow).toBe(false);
  });
});

describe('a decision', () => {
  it('names the rule and explains itself to whoever must widen the policy', () => {
    const decision = evaluate({ ...BASELINE, gasBudgetMist: '99999999' }, POLICY, LEDGER);
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('gas-budget');
    expect(decision.reason).toContain('99999999');
    expect(decision.reason).toContain('20000000');
  });
});

describe('canonicalPolicyJson', () => {
  it('is insensitive to key order, so a round trip does not change the policy hash', () => {
    const reordered: PolicyDoc = {
      allowedCommandKinds: POLICY.allowedCommandKinds,
      maxGasBudgetMist: POLICY.maxGasBudgetMist,
      allowedRecipients: POLICY.allowedRecipients,
      allowedObjects: POLICY.allowedObjects,
      outflowCeilings: POLICY.outflowCeilings,
      allowedTypeArguments: POLICY.allowedTypeArguments,
      allowedTargets: POLICY.allowedTargets,
      agentAddress: POLICY.agentAddress,
      version: 1,
    };
    expect(canonicalPolicyJson(reordered)).toBe(canonicalPolicyJson(POLICY));
  });

  it('changes when any restriction changes', () => {
    const widened: PolicyDoc = {
      ...POLICY,
      allowedTargets: [...POLICY.allowedTargets, '0xc5::creator::claim_earnings'],
    };
    expect(canonicalPolicyJson(widened)).not.toBe(canonicalPolicyJson(POLICY));
  });

  it('distinguishes an empty list from a missing one', () => {
    const noRecipients: PolicyDoc = { ...POLICY, allowedRecipients: [] };
    expect(canonicalPolicyJson(noRecipients)).not.toBe(canonicalPolicyJson(POLICY));
  });

  it('hashes a document that never bounded objects differently from one that bounds none', () => {
    // `allowedObjects` is the one key a previously-valid policy file can genuinely lack, so
    // `canonicalPolicyJson` encodes an absent one as `null` rather than throwing or defaulting.
    // Those two documents describe different authority — one permits no object, the other never
    // considered the question and could pay any vault on the platform — so they must not share a
    // hash, or an audit entry from before this rule existed would be indistinguishable from one
    // written under it.
    const legacy = { ...POLICY } as Record<string, unknown>;
    delete legacy['allowedObjects'];

    const bare = canonicalPolicyJson(legacy as unknown as PolicyDoc);
    const empty = canonicalPolicyJson({ ...POLICY, allowedObjects: [] });

    expect(bare).toContain('"allowedObjects":null');
    expect(empty).toContain('"allowedObjects":[]');
    expect(bare).not.toBe(empty);
  });
});

describe('a policy document written before allowedObjects existed', () => {
  it('is read as permitting no object, so it refuses rather than throwing', () => {
    // A policy arrives as JSON from disk, where TypeScript is not present — the same reason
    // `policy-version` is enforced by a rule. Silence about which vault may be paid is not
    // permission, and a crash here would be a refusal nobody could read.
    const legacy = { ...POLICY } as Record<string, unknown>;
    delete legacy['allowedObjects'];

    const decision = evaluate(BASELINE, legacy as unknown as PolicyDoc, LEDGER);
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('object-input');
  });

  it('still permits a transaction that takes no object inputs, because there is none to bound', () => {
    const legacy = { ...POLICY } as Record<string, unknown>;
    delete legacy['allowedObjects'];

    const decision = evaluate(
      { ...BASELINE, objectInputs: [] },
      legacy as unknown as PolicyDoc,
      LEDGER,
    );
    expect(decision).toEqual({ allow: true });
  });
});

describe('object-input evidence', () => {
  it('refuses when the field is absent, which is not the same as an empty list', () => {
    // The opposite reading from the policy side, and deliberately so: an absent POLICY field is
    // the empty permission, an absent EVIDENCE field is nobody having looked.
    const blind = { ...BASELINE } as Record<string, unknown>;
    delete blind['objectInputs'];

    const decision = evaluate(blind as unknown as typeof BASELINE, POLICY, LEDGER);
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('object-input');
    expect(decision.reason).toContain('nobody looked');
  });

  it('refuses an unclassified input even when its id would have been allow-listed', () => {
    const decision = evaluate(
      {
        ...BASELINE,
        objectInputs: [
          { index: 2, objectId: VAULT, ownership: 'unclassified', commandIndexes: [1] },
        ],
      },
      POLICY,
      LEDGER,
    );
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('object-input');
  });

  it('names the rejected id, so the operator can see what to add', () => {
    const decision = evaluate(
      {
        ...BASELINE,
        objectInputs: [
          { index: 2, objectId: ATTACKER_VAULT, ownership: 'shared', commandIndexes: [1] },
        ],
      },
      POLICY,
      LEDGER,
    );
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.reason).toContain(ATTACKER_VAULT);
  });

  it('matches a short-spelled allow-list entry against the padded id the node reports', () => {
    // `0x6` in the policy, `0x000…006` from the simulator. If both sides were not normalised the
    // Clock would be refused on every call, and the policy file would look as if it listed it.
    const decision = evaluate(
      {
        ...BASELINE,
        objectInputs: [
          { index: 5, objectId: CLOCK_PADDED, ownership: 'shared', commandIndexes: [1] },
        ],
      },
      POLICY,
      LEDGER,
    );
    expect(decision).toEqual({ allow: true });
  });
});
