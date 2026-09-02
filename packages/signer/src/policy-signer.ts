// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `PolicySigner` — the gated path for signatures that spend on someone else's behalf.
 *
 * # Two exceptions, named here, because an unnamed exception makes this docblock false
 *
 * This opened with a claim that it was the only path to a transaction signature in this
 * repository. That was not true, and it had not been true for as long as either of these existed:
 *
 *  - `packages/daemon/src/adapters/signer.ts` — the harvest daemon. Its key is **capability-less
 *    and gas-only**: no `AdminCap`, no `CreatorCap`, no treasury authority, and the one call it
 *    can make is `stake_vault::harvest`, which moves a vault's own principal into its own stake
 *    and can send nothing anywhere else. The control is what that key CANNOT do. A spend ceiling
 *    on an amount it cannot direct would be ceremony rather than a control.
 *
 *  - `packages/agent/src/tx.ts` — the agent SDK. It signs with the OPERATOR'S OWN key, for the
 *    operator, on their own funds. There is no third party whose money a policy would be
 *    protecting; the person bearing the risk is the person holding the key. It still simulates
 *    before it signs, through the SDK's `simulate()` gate, which is the property that matters
 *    there.
 *
 * Both exceptions are deliberate and both arguments are sound. Neither was written down, and the
 * false claim was written here — in the file somebody reads when deciding whether a NEW signing
 * path has to come through this one. It answered "everything already does". That was the wrong
 * answer twice already and would have been wrong a third time.
 *
 * **What must come through here: anything holding a capability, spending a budget, or moving
 * another party's funds.** A third exception is named in that list, or the claim above is false
 * again. `packages/signer/test/the-only-path-claim.test.ts` fails until it is.
 *
 * # The five steps, in order, and why the order is the design
 *
 *  1. **Build.** Bytes are produced once and every later step uses *those* bytes. Nothing rebuilds.
 *  2. **Observe.** One simulation, giving both the verdict and the effects. One call, so the
 *     verdict and the effects describe the same observation of the same chain state.
 *  3. **Gate.** `simulate()` from `@projectx-social/sdk`, as the mandated verdict. Both it and
 *     step 2 must say success.
 *  4. **Evaluate.** `@projectx-social/policy` judges the observed effects.
 *  5. **Record, then sign.** The audit entry is appended **before** the signature is produced.
 *
 * Step 5's order is deliberate and is the one most likely to be "tidied" later. If signing came
 * first, a crash between signing and recording would leave a signature in the world with no entry
 * behind it — and the entry is the only evidence of what the policy said at that moment. Recording
 * first can at worst leave an entry for a signature that was never produced, which a reviewer can
 * see and reconcile. An unrecorded signature is invisible. **Never swap these.**
 *
 * # Why the effects reader runs before the SDK gate
 *
 * `packages/sdk/src/client.ts`'s `simulate()` reads the status only from `Transaction.status`.
 * On `@mysten/sui` 2.27.1's gRPC transport a *failing* simulation is returned under
 * `FailedTransaction` instead — proven from `src/grpc/core.ts:1597-1605` — so `simulate()` returns
 * `fail('malformed', …)` for a genuine abort, carrying the text *"This is a client/server shape
 * mismatch, not a rejected transaction."*
 *
 * It fails **closed**, so nothing unsafe follows from it. But the operator gets the wrong sentence
 * and never sees the decoded abort. Running `src/evidence.ts` first means a real abort is reported
 * as a real abort, with its code and its explanation, and the SDK gate is still consulted and
 * still able to veto. The gate can only ever refuse; it is never the thing that grants permission
 * on its own.
 *
 * # Refusals are values, not exceptions
 *
 * Every outcome is a `Reading`. An unattended agent loop that caught a thrown refusal three frames
 * up would turn it into a retry, and a retry against a policy denial is a loop hammering a wall.
 *
 * # What this does NOT protect against, said here rather than in a release note
 *
 * A compromised process. Everything below runs in the same memory as the key it guards; an
 * attacker with code execution here calls the underlying adapter directly and never passes this
 * function at all. `PolicySigner` bounds what a *misled* agent can do — one steered by text
 * somebody else wrote, which is the actual threat model of an agent that reads the internet. It
 * does not bound what a *compromised host* can do. The chain-level bound in `bound-coin.ts` is the
 * one that survives this file being bypassed entirely, which is why there are two.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import { fail, ok, simulate, type DecodedAbort, type Reading } from '@projectx-social/sdk';
import {
  canonicalPolicyJson,
  evaluate,
  type Decision,
  type LedgerState,
  type PolicyDoc,
  type SimulatedEffects,
} from '@projectx-social/policy';
import { AuditLog, policyHash, type AuditEntry } from './audit.js';
import { buildBytes, grpcSimulation, type SimulationPort } from './evidence.js';
import type { SerializedSignature, Signer } from './signer.js';

export interface PolicySignerOptions {
  /** The adapter that actually holds the key. Any `Signer`, including `ReadOnlySigner`. */
  readonly inner: Signer;
  readonly policy: PolicyDoc;
  readonly client: SuiGrpcClient;
  /**
   * Where prior spend is read from.
   *
   * A function rather than a value, because a rolling window needs the *current* time and the
   * spend recorded since the last call. Handing in a snapshot at construction would freeze both,
   * and a ceiling evaluated against a stale ledger is not a ceiling.
   */
  readonly ledger: () => LedgerState;
  /** Defaults to a fresh in-memory chain. Supply one to keep a chain across signers. */
  readonly audit?: AuditLog;
  /** Defaults to gRPC. Supplied by tests with a recorded mainnet response. */
  readonly simulation?: SimulationPort;
}

/** What a caller gets back when a signature was produced. */
export interface SignedTransaction {
  readonly signature: SerializedSignature;
  /** The exact bytes that were simulated, evaluated and signed. Not rebuilt at any point. */
  readonly bytes: Uint8Array;
  readonly txDigest: string;
  /** Everything the policy judged, so the caller can record the spend against its own ledger. */
  readonly effects: SimulatedEffects;
  readonly auditEntry: AuditEntry;
}

export interface PolicySigner {
  /** The address signatures will come from. */
  readonly address: string;
  /**
   * The one method that can produce a transaction signature.
   *
   * Property-function syntax throughout, for the variance reason in `signer.ts`.
   */
  readonly signTransaction: (transaction: Transaction) => Promise<Reading<SignedTransaction>>;
  /**
   * Sign a personal message.
   *
   * **Not policy-gated, and the reason is worth stating.** A personal message moves nothing: it
   * proves control of the address to our own server (`verifyAction`) or opens a Seal session. There
   * are no effects to simulate, so there is nothing for a policy that reasons about effects to
   * judge, and a gate that always allowed would be theatre. What it does do is record the
   * signature in the audit chain, because "the agent proved itself at 03:14" is a fact worth
   * having when working out how something happened.
   */
  readonly signPersonalMessage: (bytes: Uint8Array) => Promise<Reading<SerializedSignature>>;
  /** The audit chain. Read-only; entries are appended by the two methods above. */
  readonly audit: AuditLog;
  /** sha256 of the canonical policy, recorded in every entry. */
  readonly policyHash: string;
}

export function policySigner(options: PolicySignerOptions): PolicySigner {
  const audit = options.audit ?? new AuditLog();
  const simulation = options.simulation ?? grpcSimulation(options.client);
  const hash = policyHash(canonicalPolicyJson(options.policy));
  const address = options.inner.address;
  const source = `policy signer ${address}`;

  /** Record the refusal, then return it. Never one without the other. */
  const refuse = <T>(
    kind: Parameters<typeof fail>[0],
    reason: string,
    txDigest: string,
  ): Reading<T> => {
    audit.append({
      ts: Date.now(),
      address,
      txDigest,
      policyHash: hash,
      decision: 'deny',
      reason,
    });
    return fail<T>(kind, source, reason);
  };


  /**
   * Anything thrown, turned into a recorded refusal.
   *
   * This file's header states that refusals are values rather than exceptions, and until now only
   * the *expected* refusals honoured it. `evaluate()` does not catch a throwing rule, and
   * `options.ledger()` is caller-supplied I/O — a file, a database — so either could escape.
   *
   * Escaping had two costs and the second is the serious one. An unattended loop that caught the
   * rejection three frames up would retry, which is the loop-hammering-a-wall this file exists to
   * prevent. And nothing was recorded: `refuse()` is what appends a deny entry, so a throw bypassed
   * the audit chain entirely and left no evidence that a signature had even been attempted.
   * Measured before the fix — a ledger that throws produced a rejected promise and zero entries.
   *
   * Failing closed was never in question; this path cannot produce a signature. What was missing is
   * that the refusal be a value, and be visible.
   */
  const refuseUnexpected = <T>(error: unknown): Reading<T> => {
    const detail = error instanceof Error ? error.message : String(error);
    const reason =
      `refused: the gate raised an unexpected error and nothing was signed — ${detail}. This is ` +
      `a fault in the policy evaluation or the ledger read rather than a decision about the ` +
      `transaction, and it is recorded as a denial because the transaction was in fact denied.`;
    try {
      return refuse<T>('malformed', reason, '');
    } catch {
      // The audit append itself failed. Still a value, never a throw: a caller handed an exception
      // here would retry, and the one thing known for certain is that retrying will not help.
      return fail<T>('malformed', source, reason);
    }
  };

  /**
   * The five steps. Held apart from the property below so that every way this can end — a refusal,
   * a signature, or a throw from anything it calls — passes through one place that records.
   */
  const attemptSign = async (transaction: Transaction): Promise<Reading<SignedTransaction>> => {
    // 1. Build once. Every later step uses these bytes.
    const built = await buildBytes(options.client, transaction, address);
    if (!built.ok) {
      return refuse('malformed', `refused before simulation: ${built.failure.detail}`, '');
    }
    const bytes = built.value;

    // 2. Observe once: verdict and effects from the same simulation.
    const observed = await simulation.observe({ transactionBytes: bytes, sender: address });
    if (!observed.ok) {
      return refuse(
        observed.failure.kind,
        `the simulation could not be read, so nothing was signed: ${observed.failure.detail}`,
        '',
      );
    }
    const evidence = observed.value;

    if (!evidence.wouldSucceed) {
      return refuse(
        'malformed',
        `the transaction would abort, so it was not signed: ${explainAbort(evidence.abort, evidence.status)}`,
        evidence.txDigest,
      );
    }

    // 3. The mandated gate. It can veto; it never grants on its own.
    const verdict = await simulate(options.client, transaction, address);
    if (!verdict.ok) {
      return refuse(
        verdict.failure.kind,
        `the SDK simulation gate did not confirm success (${verdict.failure.kind}): ` +
          `${verdict.failure.detail} — note that on @mysten/sui 2.27.1 gRPC this is also what ` +
          `a genuine abort looks like through that function, because a failing simulation is ` +
          `returned under FailedTransaction and simulate() reads only Transaction.`,
        evidence.txDigest,
      );
    }
    if (!verdict.value.wouldSucceed) {
      return refuse(
        'malformed',
        `the SDK simulation gate reports the transaction would fail: ${verdict.value.status}`,
        evidence.txDigest,
      );
    }

    // 4. Policy.
    const decision: Decision = evaluate(evidence.effects, options.policy, options.ledger());
    if (!decision.allow) {
      return refuse('unconfigured', decision.reason, evidence.txDigest);
    }

    // 5. Record BEFORE signing. See this file's header; never swap these.
    const auditEntry = audit.append({
      ts: Date.now(),
      address,
      txDigest: evidence.txDigest,
      policyHash: hash,
      decision: 'allow',
      reason: '',
    });

    const signature = await options.inner.signTransaction(bytes);
    if (!signature.ok) {
      // The allow entry stands. It is true: the policy did permit this, and the signer then
      // could not act. Deleting it would make the chain a record of successes rather than of
      // decisions, and the following entry says what happened next.
      return refuse(
        signature.failure.kind,
        `the policy permitted this transaction and the signer could not produce a signature: ` +
          `${signature.failure.detail}`,
        evidence.txDigest,
      );
    }

    return ok({
      signature: signature.value,
      bytes,
      txDigest: evidence.txDigest,
      effects: evidence.effects,
      auditEntry,
    });
  };

  return {
    address,
    audit,
    policyHash: hash,

    signTransaction: async (transaction) => {
      try {
        return await attemptSign(transaction);
      } catch (error) {
        return refuseUnexpected<SignedTransaction>(error);
      }
    },

    signPersonalMessage: async (bytes) => {
      // Wrapped for the same reason: `options.inner` is an adapter, and an adapter that reaches a
      // KMS or a hardware device can throw rather than return a failure.
      try {
        const signature = await options.inner.signPersonalMessage(bytes);
        if (!signature.ok) {
          return refuse(
            signature.failure.kind,
            `a personal message could not be signed: ${signature.failure.detail}`,
            '',
          );
        }
        audit.append({
          ts: Date.now(),
          address,
          txDigest: '',
          policyHash: hash,
          decision: 'allow',
          reason: 'personal message; no effects to evaluate',
        });
        return ok(signature.value);
      } catch (error) {
        return refuseUnexpected<SerializedSignature>(error);
      }
    },
  };
}

/** The abort in words, falling back to the untouched raw text rather than to a guess. */
function explainAbort(abort: DecodedAbort | undefined, status: string): string {
  if (abort === undefined) return status;
  if (abort.explanation !== null) {
    return `${abort.module} abort ${abort.code} — ${abort.explanation} (${abort.raw})`;
  }
  return abort.raw;
}
