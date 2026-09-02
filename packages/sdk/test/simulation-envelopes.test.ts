// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Where a simulation's status lives, and why one decoder rather than several.
 *
 * # The defect this pins
 *
 * `packages/daemon/src/adapters/signer.ts` carried its own copy of this read. The copy looked
 * under `Transaction` and the legacy `transaction.effects.status`, and NOT under
 * `FailedTransaction` — which is where a node puts a simulation that ABORTED.
 *
 * So a successful simulation decoded correctly, and a genuine Move abort found no status at all
 * and was reported as "a client/server shape mismatch, not a rejected transaction". The exact
 * opposite of what had happened: the chain had rejected the transaction, and the daemon wrote into
 * `daemon_harvests.error` that it could not tell what the response meant.
 *
 * It failed closed — nothing was signed — so this was a reporting defect rather than an incident.
 * It still wrote the wrong reason on every abort, for ever, and the correct decoder was in the
 * package the daemon already imports.
 *
 * # Why the shapes are literal
 *
 * They were measured on `@mysten/sui` 2.27.1 against mainnet rather than read from documentation,
 * and the whole point of this file is that they are not guessable — the success and failure
 * envelopes differ in the KEY, not in a field inside it.
 */

import { describe, expect, it } from 'vitest';
import { simulationStatus } from '../src/client';

describe('the gRPC envelopes', () => {
  it('reads a success from Transaction', () => {
    expect(simulationStatus({ $kind: 'Transaction', Transaction: { status: { success: true } } }))
      .toEqual({ success: true });
  });

  it('reads an abort from FailedTransaction — the envelope the daemon copy missed', () => {
    /*
      This single case is the finding. Before the fix the daemon returned `undefined` here and
      reported a shape mismatch, which reads to whoever is on call as "our client is out of date"
      rather than "the contract refused".
    */
    const aborted = {
      $kind: 'FailedTransaction',
      FailedTransaction: { status: { success: false, error: 'MoveAbort(…, 3)' } },
    };

    expect(simulationStatus(aborted)).toEqual({ success: false, error: 'MoveAbort(…, 3)' });
  });

  it('still reads the legacy JSON-RPC shape an older node speaks', () => {
    expect(simulationStatus({ transaction: { effects: { status: { success: true } } } }))
      .toEqual({ success: true });
  });

  it('prefers the gRPC envelope when a response somehow carries both', () => {
    const both = {
      Transaction: { status: { success: true } },
      transaction: { effects: { status: { success: false } } },
    };
    expect(simulationStatus(both)).toEqual({ success: true });
  });
});

describe('shapes that carry no status', () => {
  it('returns undefined for an unrecognised envelope, so the caller refuses', () => {
    // "No status found" must never read as permission to sign. The caller turns this into a
    // refusal; this function's job is only to be honest that it found nothing.
    expect(simulationStatus({ Something: { status: { success: true } } })).toBeUndefined();
  });

  for (const [name, value] of [
    ['null', null],
    ['undefined', undefined],
    ['a string', 'ok'],
    ['a number', 1],
  ] as const) {
    it(`survives ${name} without throwing`, () => {
      expect(simulationStatus(value)).toBeUndefined();
    });
  }

  it('survives a null Transaction, which optional chaining does NOT guard', () => {
    /*
      `shape.Transaction?.status` guards `Transaction` being undefined, not its being literally
      null. A node answering this would throw a TypeError inside the caller's try, which returns
      `fail('transport', …)` — telling the caller to retry something permanent.
    */
    expect(() => simulationStatus({ Transaction: null })).not.toThrow();
    expect(simulationStatus({ Transaction: null })).toBeUndefined();
  });

  it('survives a null status inside a real envelope', () => {
    expect(simulationStatus({ Transaction: { status: null } })).toBeUndefined();
  });
});
