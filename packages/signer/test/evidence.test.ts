// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The translation, tested against shapes measured on mainnet.
 *
 * `test/helpers.ts`'s `mainnetSuccessResponse` reproduces, field for field, what `@mysten/sui`
 * 2.27.1's gRPC transport returned from a live mainnet simulation on 2026-08-31. The three
 * FINDING tests below each assert a thing a reasonable implementation would have got wrong, and
 * each one corresponds to a comment in `src/evidence.ts`.
 */

import { describe, expect, it } from 'vitest';
import { evaluate } from '@projectx-social/policy';
import { UNRESOLVED_RECIPIENT, readSimulation } from '../src/index.js';
import { AGENT, SUI_TYPE, UNLOCK, effectsFor, mainnetSuccessResponse, policyFor } from './helpers.js';

const RESPONSE = mainnetSuccessResponse(AGENT);

/**
 * A deep copy of a response with one field removed.
 *
 * A bare `delete` needs the property to be declared optional, and widening the fixture's type to
 * make every field optional would weaken every other assertion in this file. Removing the key
 * through an index signature keeps the fixture honestly typed and still lets a test ask "what
 * happens when the node does not send this?" — which is the question that separates absence from
 * emptiness.
 */
function withoutField<T>(value: T, path: readonly string[]): T {
  const clone = structuredClone(value);
  let node = clone as Record<string, unknown>;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string, unknown>;
  delete node[path[path.length - 1]!];
  return clone;
}

describe('a successful mainnet simulation', () => {
  it('translates into effects the evaluator permits', () => {
    const reading = readSimulation(RESPONSE, AGENT);
    expect(reading.ok).toBe(true);
    if (!reading.ok) throw new Error('unreachable');

    const { effects } = reading.value;
    expect(reading.value.wouldSucceed).toBe(true);
    expect(effects.sender).toBe(AGENT);
    expect(effects.gasBudgetMist).toBe('1188000');
    expect(effects.commandKinds).toEqual(['SplitCoins', 'MoveCall', 'TransferObjects']);
    expect(effects.moveCalls).toEqual([{ index: 1, target: UNLOCK, typeArguments: [SUI_TYPE] }]);
    expect(evaluate(effects, policyFor(AGENT), { nowMs: Date.now(), spend: [] })).toEqual({
      allow: true,
    });
  });

  it('keeps the amount as the signed decimal string the node wrote', () => {
    const reading = readSimulation(RESPONSE, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.effects.balanceChanges[0]!.amount).toBe('-1088000');
    // Never a number. Above 2^53 a number has already lost the value, and `String(number)` would
    // launder that loss into something the parser accepts.
    expect(typeof reading.value.effects.balanceChanges[0]!.amount).toBe('string');
  });
});

describe('FINDING 1 — a failing simulation is under FailedTransaction, not Transaction', () => {
  /*
    @mysten/sui 2.27.1, src/grpc/core.ts:1597-1605:

      return status.success
        ? { $kind: 'Transaction',       Transaction: result }
        : { $kind: 'FailedTransaction', FailedTransaction: result };

    `packages/sdk/src/client.ts`'s simulate() reads only `Transaction?.status` and the JSON-RPC
    fallback, so it returns fail('malformed', …) here and the decoded abort never reaches the
    caller. This reader looks in the right place.
  */
  const failed = {
    $kind: 'FailedTransaction',
    FailedTransaction: {
      status: {
        success: false,
        error: {
          message:
            "MoveAbort in 2nd command, abort code: 12, in " +
            "'0xc5c8::creator::unlock' (instruction 55)",
          command: 1,
        },
      },
      balanceChanges: [],
      effects: { transactionDigest: 'FailedDigest111111111111111111111111111111111' },
      transaction: {
        sender: AGENT,
        gasData: { budget: '1188000', payment: [], price: '100' },
        inputs: [],
        commands: [],
      },
    },
  };

  it('is read as a failure, not as a shape mismatch', () => {
    const reading = readSimulation(failed, AGENT);
    expect(reading.ok).toBe(true);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.wouldSucceed).toBe(false);
  });

  it('decodes the abort, which is the part the SDK gate cannot reach', () => {
    const reading = readSimulation(failed, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.abort?.module).toBe('creator');
    expect(reading.value.abort?.code).toBe(12);
    expect(reading.value.abort?.explanation).toBe('This content is not for sale.');
  });

  it('reads the structured error object rather than stringifying it to [object Object]', () => {
    // The node's `error` is an object with a `message`, not a string. A naive
    // `String(status.error)` yields "[object Object]", which decodes to module "unknown" and
    // code -1 — an abort report with no abort in it.
    const reading = readSimulation(failed, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.status).toContain('abort code: 12');
    expect(reading.value.status).not.toContain('[object Object]');
  });

  it('refuses a response whose envelope and status contradict each other', () => {
    const contradiction = { $kind: 'Transaction', Transaction: { ...failed.FailedTransaction } };
    const reading = readSimulation(contradiction, AGENT);
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error('unreachable');
    expect(reading.failure.detail).toContain('Refusing on a contradiction');
  });
});

describe('FINDING 2 — TransferObjects.address is an argument reference, not an address', () => {
  it('resolves an Input reference through the base64 Pure input to a real address', () => {
    const reading = readSimulation(RESPONSE, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    // The live response carried `{"$kind":"Input","Input":1}` and input 1 was base64 of the 32
    // raw address bytes. Reading `.address` directly would have produced an object.
    expect(reading.value.effects.transfers).toEqual([{ index: 2, recipient: AGENT }]);
  });

  it('marks a recipient computed at runtime as unresolved, so no allow-list can match it', () => {
    const runtimeRecipient = structuredClone(RESPONSE);
    runtimeRecipient.Transaction.transaction.commands[2] = {
      $kind: 'TransferObjects',
      TransferObjects: {
        objects: [{ $kind: 'NestedResult', NestedResult: [0, 0] }],
        // A destination produced by an earlier command cannot be known before execution.
        address: { $kind: 'NestedResult', NestedResult: [0, 1] },
      },
    } as (typeof runtimeRecipient)['Transaction']['transaction']['commands'][number];

    const reading = readSimulation(runtimeRecipient, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.effects.transfers[0]!.recipient).toBe(UNRESOLVED_RECIPIENT);

    // And the policy refuses it. A destination we cannot name before signing is one we cannot
    // approve.
    const decision = evaluate(reading.value.effects, policyFor(AGENT), {
      nowMs: Date.now(),
      spend: [],
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('transfer-recipient');
  });

  it('refuses a Pure input that is not 32 bytes rather than padding it into an address', () => {
    const shortInput = structuredClone(RESPONSE);
    shortInput.Transaction.transaction.inputs[1] = { $kind: 'Pure', Pure: { bytes: 'AQID' } };
    const reading = readSimulation(shortInput, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.effects.transfers[0]!.recipient).toBe(UNRESOLVED_RECIPIENT);
  });
});

describe('FINDING 3 — the digest is on the effects, not on the transaction', () => {
  it('reads effects.transactionDigest', () => {
    const reading = readSimulation(RESPONSE, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.txDigest).toBe('2Wm1kXwYxPjkjVqT1rvHi9oqmvSZY3md6eirK8WheHbR');
  });

  it('leaves the digest empty rather than fabricating one when the node reported none', () => {
    const noEffects = withoutField(RESPONSE, ['Transaction', 'effects']);
    const reading = readSimulation(noEffects, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.txDigest).toBe('');
  });
});

describe('absence is never emptiness', () => {
  it('records that balance changes were not observed, and the policy then refuses', () => {
    const noChanges = withoutField(RESPONSE, ['Transaction', 'balanceChanges']);

    const reading = readSimulation(noChanges, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.effects.balanceChangesObserved).toBe(false);
    expect(reading.value.effects.balanceChanges).toEqual([]);

    const decision = evaluate(reading.value.effects, policyFor(AGENT), {
      nowMs: Date.now(),
      spend: [],
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('balance-evidence');
  });

  it('distinguishes an observed empty list from an absent one', () => {
    const empty = structuredClone(RESPONSE);
    empty.Transaction.balanceChanges = [];
    const reading = readSimulation(empty, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.effects.balanceChangesObserved).toBe(true);
  });
});

describe('shapes this reader refuses', () => {
  it('refuses a response with neither envelope key', () => {
    const reading = readSimulation({ $kind: 'Transaction' }, AGENT);
    expect(reading.ok).toBe(false);
  });

  it('refuses a null payload rather than throwing a TypeError inside its own try', () => {
    // Optional chaining guards `undefined`, not `null`. A throw here would be reported as a
    // transport fault — a permanent condition wearing a transient's name.
    const reading = readSimulation({ $kind: 'Transaction', Transaction: null }, AGENT);
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error('unreachable');
    expect(reading.failure.kind).toBe('malformed');
  });

  it('refuses a numeric amount rather than coercing it to a string', () => {
    const numeric = structuredClone(RESPONSE) as unknown as {
      Transaction: { balanceChanges: { amount: unknown }[] };
    };
    numeric.Transaction.balanceChanges[0]!.amount = -1088000;
    const reading = readSimulation(numeric, AGENT);
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error('unreachable');
    expect(reading.failure.detail).toContain('not coerced from numbers');
  });

  it('refuses when the parsed transaction data was not requested', () => {
    const noTransaction = withoutField(RESPONSE, ['Transaction', 'transaction']);
    const reading = readSimulation(noTransaction, AGENT);
    expect(reading.ok).toBe(false);
    if (reading.ok) throw new Error('unreachable');
    expect(reading.failure.detail).toContain('include: { transaction: true }');
  });

  it('maps an unrecognised command kind to Unknown, which no policy permits', () => {
    const future = structuredClone(RESPONSE) as unknown as {
      Transaction: { transaction: { commands: unknown[] } };
    };
    future.Transaction.transaction.commands.push({ $kind: 'SomeFutureCommand' });
    const reading = readSimulation(future, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.effects.commandKinds).toContain('Unknown');

    const decision = evaluate(reading.value.effects, policyFor(AGENT), {
      nowMs: Date.now(),
      spend: [],
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('command-kind');
  });

  it('reports an unreadable gas budget as unparseable, so gas-budget refuses', () => {
    const noBudget = withoutField(RESPONSE, ['Transaction', 'transaction', 'gasData', 'budget']);
    const reading = readSimulation(noBudget, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    expect(reading.value.effects.gasBudgetMist).toBe('unreadable');

    const decision = evaluate(reading.value.effects, policyFor(AGENT), {
      nowMs: Date.now(),
      spend: [],
    });
    expect(decision.allow).toBe(false);
    if (decision.allow) throw new Error('unreachable');
    expect(decision.ruleId).toBe('gas-budget');
  });
});

describe('effectsFor, the hand-written fixture', () => {
  it('matches what the real translation produces, so the two never drift apart', () => {
    const reading = readSimulation(RESPONSE, AGENT);
    if (!reading.ok) throw new Error('unreachable');
    const translated = reading.value.effects;
    const handWritten = effectsFor(AGENT);
    expect(translated.commandKinds).toEqual(handWritten.commandKinds);
    expect(translated.moveCalls).toEqual(handWritten.moveCalls);
    expect(translated.transfers).toEqual(handWritten.transfers);
    expect(translated.gasBudgetMist).toBe(handWritten.gasBudgetMist);
  });
});

/**
 * FINDING 4 — the object inputs, which is the evidence the twelfth rule stands on.
 *
 * `object-input` refuses a Move call whose object arguments are not allow-listed. It is the rule
 * that stops an injected instruction paying **an attacker's `CreatorVault`** through an otherwise
 * perfectly legal `creator::unlock`: permitted target, permitted coin type, `Unlock` transferred
 * home, whole spend inside the ceiling — every other rule passes, and the vault argument is what
 * decides whose earnings the money lands in. Anyone can open a vault for 29 SUI, so that
 * destination is attacker-supplied and repeatable.
 *
 * A rule is only as good as the evidence it reads, and this extraction had none of its own tests.
 * These are it. Shapes verified against `@mysten/sui` 2.27.1 `src/transactions/data/internal.ts`:
 * `ObjectArgSchema` (:270) is `ImmOrOwnedObject | SharedObject | Receiving`, and the outer
 * `CallArgSchema` (:309) has **five** variants — `UnresolvedObject` and `FundsWithdrawal` are
 * there too, and both must surface as `unclassified` rather than be dropped.
 *
 * The direction of every ambiguity is the same: **unreadable is refused, never skipped.** A
 * dropped input is an unbounded destination that reads as a clean pass.
 */
describe('object inputs are extracted, and never quietly dropped', () => {
  const SHARED = (id: string) => ({
    $kind: 'Object',
    Object: { $kind: 'SharedObject', SharedObject: { objectId: id, initialSharedVersion: '1', mutable: true } },
  });
  const OWNED = (id: string) => ({
    $kind: 'Object',
    Object: { $kind: 'ImmOrOwnedObject', ImmOrOwnedObject: { objectId: id, version: '7', digest: 'd' } },
  });

  const VAULT = `0x${'a1'.repeat(32)}`;
  const PLATFORM = `0x${'3f'.repeat(32)}`;

  function responseWith(inputs: unknown[]) {
    return {
      Transaction: {
        status: { success: true, error: null },
        effects: {
          transactionDigest: 'D',
          gasUsed: { computationCost: '1', storageCost: '1', storageRebate: '0', nonRefundableStorageFee: '0' },
        },
        balanceChanges: [],
        transaction: {
          kind: 'ProgrammableTransaction',
          inputs,
          commands: [{ MoveCall: { package: '0x2', module: 'creator', function: 'unlock', arguments: [], typeArguments: [] } }],
        },
      },
    };
  }

  it('reads a shared vault and an owned object, each with its ownership shape', () => {
    const r = readSimulation(responseWith([SHARED(PLATFORM), SHARED(VAULT), OWNED(`0x${'77'.repeat(32)}`)]), AGENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ids = r.value.effects.objectInputs.map((o) => o.objectId);
    expect(ids).toHaveLength(3);
    const shapes = r.value.effects.objectInputs.map((o) => o.ownership);
    expect(shapes).toContain('shared');
    expect(shapes).toContain('imm-or-owned');
    expect(shapes).not.toContain('unclassified');
  });

  it('marks an unknown ObjectArg variant unclassified rather than skipping it', () => {
    const r = readSimulation(
      responseWith([{ $kind: 'Object', Object: { $kind: 'SomethingNewInASDKUpgrade', SomethingNewInASDKUpgrade: {} } }]),
      AGENT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.effects.objectInputs).toHaveLength(1);
    expect(r.value.effects.objectInputs[0]?.ownership).toBe('unclassified');
  });

  it('marks UnresolvedObject unclassified and keeps its id for the refusal message', () => {
    const id = `0x${'be'.repeat(32)}`;
    const r = readSimulation(responseWith([{ $kind: 'UnresolvedObject', UnresolvedObject: { objectId: id } }]), AGENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.effects.objectInputs[0]?.ownership).toBe('unclassified');
    expect(r.value.effects.objectInputs[0]?.objectId).toContain('be');
  });

  it('does not mistake a Pure input for an object', () => {
    const r = readSimulation(responseWith([{ $kind: 'Pure', Pure: { bytes: 'AAAA' } }, SHARED(VAULT)]), AGENT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.effects.objectInputs).toHaveLength(1);
    expect(r.value.effects.objectInputs[0]?.ownership).toBe('shared');
  });
});
