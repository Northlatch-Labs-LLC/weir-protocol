// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The gate, end to end, with no network.
 *
 * The transaction is fully specified — explicit sender, gas payment, budget and price, and pure
 * inputs only — so `build()` resolves nothing remotely. The client is a stub that returns the
 * recorded mainnet response from `test/helpers.ts`. That means these tests exercise the real
 * build, the real translation, the real SDK gate and the real evaluator, and the only thing that
 * is not real is the node.
 */

import { describe, expect, it, vi } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { verifyTransactionSignature } from '@mysten/sui/verify';
import type { LedgerState, PolicyDoc } from '@projectx-social/policy';
import { policySigner, readOnlySigner, type SimulationPort } from '../src/index.js';
import {
  CLAIM_EARNINGS,
  SUI_TYPE,
  mainnetSuccessResponse,
  policyFor,
  signerFor,
} from './helpers.js';

const KEYPAIR = Ed25519Keypair.generate();
const AGENT = KEYPAIR.toSuiAddress();
const EMPTY: () => LedgerState = () => ({ nowMs: 1_788_000_000_000, spend: [] });

/** A transaction that needs no chain read to build. */
function localTransaction(): Transaction {
  const tx = new Transaction();
  tx.setSender(AGENT);
  tx.setGasPrice(1000n);
  tx.setGasBudget(1_188_000n);
  tx.setGasPayment([
    {
      objectId: `0x${'7'.repeat(64)}`,
      version: '1',
      digest: '11111111111111111111111111111111',
    },
  ]);
  const [coin] = tx.splitCoins(tx.gas, [1n]);
  tx.transferObjects([coin!], AGENT);
  return tx;
}

/** A client that answers the SDK gate with whatever response the test supplies. */
function stubClient(response: unknown): SuiGrpcClient {
  return { simulateTransaction: async () => response } as unknown as SuiGrpcClient;
}

/** A simulation port that answers with a recorded response, without a network. */
function stubPort(response: unknown, sender: string = AGENT): SimulationPort {
  return {
    observe: async ({ transactionBytes }) => {
      expect(transactionBytes.byteLength).toBeGreaterThan(0);
      const { readSimulation } = await import('../src/evidence.js');
      return readSimulation(response, sender);
    },
  };
}

function makeSigner(overrides: {
  policy?: PolicyDoc;
  response?: unknown;
  ledger?: () => LedgerState;
  inner?: ReturnType<typeof signerFor>;
}) {
  const response = overrides.response ?? mainnetSuccessResponse(AGENT);
  return policySigner({
    inner: overrides.inner ?? signerFor(KEYPAIR),
    policy: overrides.policy ?? policyFor(AGENT),
    client: stubClient(response),
    ledger: overrides.ledger ?? EMPTY,
    simulation: stubPort(response),
  });
}

describe('a permitted transaction', () => {
  it('is signed, and the signature verifies over the exact bytes that were simulated', async () => {
    const signer = makeSigner({});
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    const publicKey = await verifyTransactionSignature(result.value.bytes, result.value.signature, {
      address: AGENT,
    });
    expect(publicKey.toSuiAddress()).toBe(AGENT);
    expect(result.value.txDigest).toBe('2Wm1kXwYxPjkjVqT1rvHi9oqmvSZY3md6eirK8WheHbR');
  });

  it('records the allow entry, and the chain verifies', async () => {
    const signer = makeSigner({});
    await signer.signTransaction(localTransaction());
    const entries = signer.audit.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.decision).toBe('allow');
    expect(entries[0]!.policyHash).toBe(signer.policyHash);
    expect(signer.audit.verify().intact).toBe(true);
  });

  it('returns the effects, so the caller can record the spend against its own ledger', async () => {
    const signer = makeSigner({});
    const result = await signer.signTransaction(localTransaction());
    if (!result.ok) throw new Error('unreachable');
    expect(result.value.effects.balanceChanges[0]!.amount).toBe('-1088000');
  });
});

describe('the policy gate', () => {
  it('refuses claim_earnings for an agent authorised only to buy', async () => {
    const response = mainnetSuccessResponse(AGENT);
    response.Transaction.transaction.commands[1] = {
      $kind: 'MoveCall',
      MoveCall: {
        package: CLAIM_EARNINGS.split('::')[0]!,
        module: 'creator',
        function: 'claim_earnings',
        typeArguments: [SUI_TYPE],
        arguments: [],
      },
    } as (typeof response)['Transaction']['transaction']['commands'][number];

    const signer = makeSigner({ response });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.detail).toContain('move-call-target');
    expect(result.failure.detail).toContain('claim_earnings');
  });

  it('refuses a spend over the rolling ceiling, counting prior spend', async () => {
    const signer = makeSigner({
      ledger: () => ({
        nowMs: 1_788_000_000_000,
        spend: [{ coinType: SUI_TYPE, amountOut: '9500000', atMs: 1_788_000_000_000 - 5 }],
      }),
    });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.detail).toContain('outflow-ceiling');
  });

  it('records the refusal with its full reason — a denial is evidence, not noise', async () => {
    const signer = makeSigner({
      ledger: () => ({
        nowMs: 1_788_000_000_000,
        spend: [{ coinType: SUI_TYPE, amountOut: '9500000', atMs: 1_788_000_000_000 - 5 }],
      }),
    });
    await signer.signTransaction(localTransaction());
    const entries = signer.audit.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.decision).toBe('deny');
    expect(entries[0]!.reason).toContain('outflow-ceiling');
    expect(signer.audit.verify().intact).toBe(true);
  });

  it('never signs when it refuses', async () => {
    const inner = signerFor(KEYPAIR);
    const spy = vi.spyOn(inner, 'signTransaction');
    const signer = policySigner({
      inner,
      policy: policyFor(AGENT),
      client: stubClient(mainnetSuccessResponse(AGENT)),
      ledger: () => ({
        nowMs: 1_788_000_000_000,
        spend: [{ coinType: SUI_TYPE, amountOut: '99999999', atMs: 1_788_000_000_000 }],
      }),
      simulation: stubPort(mainnetSuccessResponse(AGENT)),
    });
    await signer.signTransaction(localTransaction());
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the simulation gate', () => {
  it('refuses an aborting transaction and reports the decoded abort, not a shape mismatch', async () => {
    const failed = {
      $kind: 'FailedTransaction',
      FailedTransaction: {
        status: {
          success: false,
          error: {
            message:
              "MoveAbort in 2nd command, abort code: 12, in '0xc5c8::creator::unlock' (instruction 55)",
          },
        },
        balanceChanges: [],
        effects: { transactionDigest: 'abc' },
        transaction: {
          sender: AGENT,
          gasData: { budget: '1188000', payment: [], price: '100' },
          inputs: [],
          commands: [],
        },
      },
    };
    const signer = makeSigner({ response: failed });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    // The whole reason the effects reader runs before the SDK gate.
    expect(result.failure.detail).toContain('would abort');
    expect(result.failure.detail).toContain('This content is not for sale.');
    expect(result.failure.detail).not.toContain('shape mismatch');
  });

  it('refuses when the SDK gate cannot confirm success, even though the effects reader could', async () => {
    // The SDK gate reads only `Transaction.status`. Feed the port a success and the SDK client a
    // shape it cannot read: the gate must veto. It can only ever refuse; it never grants alone.
    const good = mainnetSuccessResponse(AGENT);
    const signer = policySigner({
      inner: signerFor(KEYPAIR),
      policy: policyFor(AGENT),
      client: stubClient({ somethingElse: true }),
      ledger: EMPTY,
      simulation: stubPort(good),
    });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.detail).toContain('SDK simulation gate did not confirm success');
  });

  it('refuses when the simulation could not be read at all', async () => {
    const signer = makeSigner({ response: { $kind: 'Transaction' } });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.detail).toContain('nothing was signed');
  });
});

describe('the inner adapter', () => {
  it('refusing to sign is recorded, and the allow entry that preceded it stands', async () => {
    const inner = readOnlySigner({
      address: AGENT,
      because: 'the cold key is held offline.',
    });
    const signer = policySigner({
      inner,
      policy: policyFor(AGENT),
      client: stubClient(mainnetSuccessResponse(AGENT)),
      ledger: EMPTY,
      simulation: stubPort(mainnetSuccessResponse(AGENT)),
    });

    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failure.kind).toBe('unconfigured');

    const entries = signer.audit.entries;
    // Two entries: the policy permitted it, and then the signer could not act. Both are true, and
    // deleting the first would make the chain a record of successes rather than of decisions.
    expect(entries.map((e) => e.decision)).toEqual(['allow', 'deny']);
    expect(entries[1]!.reason).toContain('the policy permitted this transaction');
    expect(signer.audit.verify().intact).toBe(true);
  });
});

describe('personal messages', () => {
  it('are signed without a policy evaluation, and recorded saying so', async () => {
    const signer = makeSigner({});
    const signature = await signer.signPersonalMessage(new TextEncoder().encode('prove yourself'));
    expect(signature.ok).toBe(true);
    const entries = signer.audit.entries;
    expect(entries[0]!.reason).toContain('no effects to evaluate');
  });
});

describe('the audit chain across a whole session', () => {
  it('interleaves allows and denials and stays verifiable', async () => {
    const signer = makeSigner({});
    await signer.signTransaction(localTransaction());
    await signer.signPersonalMessage(new TextEncoder().encode('a'));
    await signer.signTransaction(localTransaction());

    const verdict = signer.audit.verify();
    expect(verdict.intact).toBe(true);
    if (!verdict.intact) throw new Error('unreachable');
    expect(verdict.length).toBe(3);

    // Every entry names the policy that judged it, so a later widening is visible at the entry
    // where it first took effect.
    for (const entry of signer.audit.entries) {
      expect(entry.policyHash).toBe(signer.policyHash);
    }
  });
});

describe('a fault inside the gate is a recorded refusal, not an exception', () => {
  /*
   * The header of `policy-signer.ts` says refusals are values rather than exceptions, and until
   * this block existed only the *expected* refusals honoured it.
   *
   * `evaluate()` does not catch a throwing rule, and `options.ledger()` is caller-supplied I/O — in
   * production a file or a database, both of which fail. Either could escape `signTransaction` as
   * a rejected promise.
   *
   * Failing closed was never in doubt: no signature is produced on that path. Two other things
   * were wrong. An unattended loop that caught the rejection would retry, which is the behaviour
   * the header explicitly exists to prevent. And `refuse()` is what appends a deny entry, so a
   * throw bypassed the audit chain and left **zero** entries — no evidence that a signature had
   * even been attempted, in the record whose entire purpose is to hold that evidence.
   */

  const throwingLedger = (): LedgerState => {
    throw new Error('the ledger store is unreachable');
  };

  it('a ledger that throws yields a Reading, not a rejected promise', async () => {
    const signer = makeSigner({ ledger: throwingLedger });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
  });

  it('and it is recorded as a denial', async () => {
    // Measured before the fix: zero entries. The refusal existed only as an exception nobody kept.
    const signer = makeSigner({ ledger: throwingLedger });
    await signer.signTransaction(localTransaction());
    expect(signer.audit.entries).toHaveLength(1);
    expect(signer.audit.entries[0]?.decision).toBe('deny');
  });

  it('the recorded reason names the underlying fault', async () => {
    // A denial reading "an error occurred" sends the operator to widen a policy that was never
    // consulted. The reason has to distinguish a fault from a decision.
    const signer = makeSigner({ ledger: throwingLedger });
    await signer.signTransaction(localTransaction());
    expect(signer.audit.entries[0]?.reason).toContain('the ledger store is unreachable');
    expect(signer.audit.entries[0]?.reason).toContain('nothing was signed');
  });

  it('no signature escapes when the gate faults', async () => {
    const signer = makeSigner({ ledger: throwingLedger });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    // Nothing in the audit chain claims a signature was produced.
    expect(signer.audit.entries.some((e) => e.decision === 'allow')).toBe(false);
  });

  it('an inner signer that throws is caught too', async () => {
    // A KMS or hardware adapter reaches a network or a device; it can throw rather than return a
    // failure, and it does so *after* the allow entry has been written.
    const signer = makeSigner({
      inner: {
        address: AGENT,
        scheme: 'ed25519',
        signPersonalMessage: async () => { throw new Error('the device is not connected'); },
        signTransaction: async () => { throw new Error('the device is not connected'); },
      } as unknown as ReturnType<typeof signerFor>,
    });
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(false);
    // The allow entry stands and the denial follows it: the policy did permit this, and the signer
    // then could not act. Two entries, in that order, is the honest record.
    expect(signer.audit.entries.map((e) => e.decision)).toEqual(['allow', 'deny']);
  });

  it('signPersonalMessage catches a throwing adapter as well', async () => {
    const signer = makeSigner({
      inner: {
        address: AGENT,
        scheme: 'ed25519',
        signPersonalMessage: async () => { throw new Error('the device is not connected'); },
        signTransaction: async () => { throw new Error('the device is not connected'); },
      } as unknown as ReturnType<typeof signerFor>,
    });
    const result = await signer.signPersonalMessage(new Uint8Array([1, 2, 3]));
    expect(result.ok).toBe(false);
    expect(signer.audit.entries).toHaveLength(1);
    expect(signer.audit.entries[0]?.decision).toBe('deny');
  });

  it('a permitted transaction is still signed — the wrapper changed nothing else', async () => {
    const signer = makeSigner({});
    const result = await signer.signTransaction(localTransaction());
    expect(result.ok).toBe(true);
  });
});
