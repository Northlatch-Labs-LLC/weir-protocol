// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Turning what a node said into what the evaluator will look at.
 *
 * # This file is the one place a client-library rename may break, and it must break loudly
 *
 * `@projectx-social/policy` has no dependencies and defines its own `SimulatedEffects`. Everything
 * that knows the shape of `@mysten/sui`'s simulation response lives here. That is deliberate: the
 * SDK has already been bitten once by exactly this boundary — `packages/sdk/src/client.ts` carries
 * a long comment about `transaction.effects.status` silently becoming `Transaction.status`, which
 * made every simulation report failure for weeks while the daemon exited 0 looking healthy.
 *
 * Every shape below was **measured against mainnet on `@mysten/sui` 2.27.1 on 2026-08-31**, not
 * read from documentation. The four findings that a reasonable implementation would have got
 * wrong are marked FINDING and each one changed the code.
 *
 * # FINDING 1 — a failed simulation is not at `Transaction`, it is at `FailedTransaction`
 *
 * `@mysten/sui`'s gRPC parser ends with a two-line ternary (`src/grpc/core.ts:1597-1605`):
 *
 * ```ts
 * return status.success
 *   ? { $kind: 'Transaction',       Transaction: result }
 *   : { $kind: 'FailedTransaction', FailedTransaction: result };
 * ```
 *
 * On failure the `Transaction` key is **absent**. `packages/sdk/src/client.ts`'s `simulate()`
 * reads only `Transaction?.status` and the JSON-RPC fallback `transaction?.effects?.status`, so a
 * genuinely aborting transaction produces neither — and `simulate()` returns
 * `fail('malformed', …)` with the text *"This is a client/server shape mismatch, not a rejected
 * transaction."* For a real abort that sentence is exactly backwards.
 *
 * The SDK still fails **closed**, which is the property that matters and is why this is a
 * reporting defect rather than a spending one. But the decoded abort the operator needs is
 * unreachable through it. So this file reads `FailedTransaction` itself. `PolicySigner` runs this
 * reader **before** the SDK gate, so an abort is reported as an abort.
 *
 * # FINDING 2 — `TransferObjects.address` is an argument reference, not an address
 *
 * Measured live. A `TransferObjects` command's recipient came back as:
 *
 * ```json
 * "address": { "$kind": "Input", "Input": 1 }
 * ```
 *
 * and input 1 was `{ "$kind": "Pure", "Pure": { "bytes": "2nhLbCDFmV9rcZogom7d7l7Jccjs7IkOYci0Y03RcV0=" } }`
 * — **base64**, which decodes to the 32 raw address bytes. A translator that read `.address`
 * directly would hand the recipient rule an object; the rule would refuse it as "not an address",
 * every transfer would be denied, and the allow-list would look strict while testing nothing.
 * So the reference is resolved against the input list here. A recipient that is a command
 * *result* rather than an input cannot be known before execution, and is reported as an explicit
 * unresolved marker that no allow-list can match — refusing, by construction.
 *
 * # FINDING 3 — the digest is on the effects, not on the transaction
 *
 * `Transaction.digest` was `undefined` in every measurement. `effects.transactionDigest` carried
 * `2Wm1kXwYxPjkjVqT1rvHi9oqmvSZY3md6eirK8WheHbR`. The audit entry records the digest, so this
 * reader asks for `effects` and reads it from there. When it is genuinely absent the entry gets an
 * empty string rather than a fabricated one.
 *
 * # FINDING 4 — an object input is a two-level enum, and only the inner level names the shape
 *
 * Read from the installed package rather than from documentation:
 * `@mysten/sui` 2.27.1 `src/transactions/data/internal.ts:309-325` defines a transaction input as
 * `CallArgSchema`, a five-variant enum — `Object`, `Pure`, `UnresolvedPure`, `UnresolvedObject`,
 * `FundsWithdrawal` — and `Object` wraps a **second** enum, `ObjectArgSchema` (`:270-279`), whose
 * three variants are `ImmOrOwnedObject`, `SharedObject` and `Receiving`. So a shared object
 * arrives as:
 *
 * ```json
 * { "$kind": "Object",
 *   "Object": { "$kind": "SharedObject",
 *               "SharedObject": { "objectId": "0x…", "initialSharedVersion": "…", "mutable": true } } }
 * ```
 *
 * The object id is two levels down and under a key whose name changes with the variant. A reader
 * that looked for `input.objectId` finds nothing, and finding nothing is not an error here — it is
 * an input that quietly does not appear in the list. Rule `object-input` would then have nothing
 * to refuse and would report a clean pass on a transaction paying a stranger's vault.
 *
 * So every input this reader cannot reduce to one of those three variants is emitted as
 * `ownership: 'unclassified'`, which the rule refuses on sight. **Nothing is ever skipped for
 * being unreadable.** `Pure` and `UnresolvedPure` are the only two inputs that are legitimately
 * not objects, and they are the only two omitted.
 *
 * The same applies to a command argument pointing at an input index that does not exist — a
 * response whose `inputs` was not an array, or was shorter than the commands expect. That
 * reference is emitted as an unclassified input at the index it named, rather than resolving to
 * nothing.
 *
 * # Absence is never emptiness
 *
 * `include: { balanceChanges: true }` is passed unconditionally, and whether the response actually
 * carried the array is recorded in `balanceChangesObserved`. The policy rule `balance-evidence`
 * refuses when it is false. A node that stops returning the field must produce a refusal, never a
 * transaction that appears to move no money.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import { classify, decodeAbort, fail, ok, type DecodedAbort, type Reading } from '@projectx-social/sdk';
import type { BalanceChange, CommandKind, MoveCallEffect, ObjectInput, ObjectOwnership, SimulatedEffects, TransferEffect } from '@projectx-social/policy';

/**
 * What one simulation observed: the verdict, and the effects the policy will judge.
 *
 * The verdict is carried alongside the effects rather than being a separate call, because they
 * must describe the *same* simulation. Two round trips can straddle a change in chain state, and a
 * policy decision made against effects from one observation and a verdict from another is a
 * decision about a transaction that never existed.
 */
export interface SimulationEvidence {
  readonly wouldSucceed: boolean;
  /** Raw status text, unmodified, whatever it was. */
  readonly status: string;
  /** Present only on failure. Decoded through the SDK's own `decodeAbort`. */
  readonly abort?: DecodedAbort;
  /** From `effects.transactionDigest`; empty string when the node reported none. See FINDING 3. */
  readonly txDigest: string;
  readonly effects: SimulatedEffects;
}

/**
 * The port `PolicySigner` simulates through.
 *
 * An interface rather than a direct call, so a test can supply a recorded mainnet response and
 * exercise the whole gate — build, verdict, policy, audit, sign — with no network. Property
 * functions, for the variance reason in `signer.ts`.
 */
export interface SimulationPort {
  readonly observe: (args: {
    readonly transactionBytes: Uint8Array;
    readonly sender: string;
  }) => Promise<Reading<SimulationEvidence>>;
}

/** The unresolvable-recipient marker. Deliberately not an address, so no allow-list can hold it. */
export const UNRESOLVED_RECIPIENT = 'unresolved-at-build-time';

/**
 * How deep the argument scan will walk one command before it stops looking.
 *
 * A command's arguments are two or three levels of plain JSON in every shape `@mysten/sui` 2.27.1
 * defines, so 8 is generous. The cap exists because the scan is recursive over data that arrives
 * from a node: an adversarial or looping structure must exhaust a counter rather than the stack.
 * Stopping early can only *lose* a reference, never invent one, and a lost reference costs a
 * command index in a refusal message — it never removes an input from the checked list, because
 * every input is checked whether a reference was found for it or not.
 */
const MAX_ARGUMENT_DEPTH = 8;

/**
 * A simulation port backed by a live gRPC client.
 *
 * `include` asks for all three of `balanceChanges`, `effects` and `transaction`, because each one
 * carries something a rule needs: the money, the digest, and the commands. Omitting any of them
 * does not weaken a rule — it makes the corresponding rule refuse.
 */
export function grpcSimulation(client: SuiGrpcClient): SimulationPort {
  return {
    observe: async ({ transactionBytes, sender }) => {
      const source = 'simulateTransaction';
      let response: unknown;
      try {
        response = await client.simulateTransaction({
          transaction: transactionBytes,
          include: { balanceChanges: true, effects: true, transaction: true },
        });
      } catch (error) {
        return fail('transport', source, classify(error, source).detail);
      }
      return readSimulation(response, sender);
    },
  };
}

/**
 * Translate a simulation response. Exported so tests can feed it captured mainnet JSON.
 *
 * Every level is checked for being an object before it is indexed. Optional chaining guards
 * `undefined` and not `null`, and a node that answered `{"Transaction": null}` would otherwise
 * throw a `TypeError` inside a `try` and be reported as a transport fault — a permanent condition
 * wearing a transient's name, which is the reasoning `packages/sdk/src/client.ts` already records.
 */
export function readSimulation(response: unknown, sender: string): Reading<SimulationEvidence> {
  const source = 'simulateTransaction';
  const envelope = asObject(response);
  if (envelope === null) {
    return fail('malformed', source, 'the simulation response was not an object.');
  }

  // FINDING 1: on failure the payload is under `FailedTransaction`, not `Transaction`.
  const succeeded = asObject(envelope['Transaction']);
  const failed = asObject(envelope['FailedTransaction']);
  const payload = succeeded ?? failed;

  if (payload === null) {
    return fail(
      'malformed',
      source,
      'the response carried neither a Transaction nor a FailedTransaction, so it could not be ' +
        'shown to have succeeded. Nothing was signed. This is a client/server shape mismatch.',
    );
  }

  const status = asObject(payload['status']);
  if (status === null) {
    return fail(
      'malformed',
      source,
      'the simulation carried no status field, so it could not be shown to have succeeded. ' +
        'Treating an unrecognised shape as permission to sign is how a library rename turns ' +
        'into money moving with no simulation behind it.',
    );
  }

  const wouldSucceed = status['success'] === true;
  if (wouldSucceed !== (succeeded !== null)) {
    // The envelope key and the status disagree. One of them is wrong and we cannot tell which.
    return fail(
      'malformed',
      source,
      `the response is a ${succeeded !== null ? 'Transaction' : 'FailedTransaction'} but its ` +
        `status reports success=${String(status['success'])}. Refusing on a contradiction.`,
    );
  }

  const rawStatus = wouldSucceed ? 'success' : stringifyError(status['error']);
  const effectsObject = asObject(payload['effects']);
  const txDigest = typeof effectsObject?.['transactionDigest'] === 'string'
    ? (effectsObject['transactionDigest'] as string)
    : ''; // FINDING 3: never fabricated.

  const effects = readEffects(payload, sender);
  if (!effects.ok) return effects;

  const evidence: SimulationEvidence = wouldSucceed
    ? { wouldSucceed: true, status: rawStatus, txDigest, effects: effects.value }
    : {
        wouldSucceed: false,
        status: rawStatus,
        abort: decodeAbort(rawStatus),
        txDigest,
        effects: effects.value,
      };

  return ok(evidence, effects.observedAtMs);
}

function readEffects(
  payload: Record<string, unknown>,
  sender: string,
): Reading<SimulatedEffects> {
  const source = 'simulateTransaction effects';
  const observedAtMs = Date.now();

  const rawChanges = payload['balanceChanges'];
  const balanceChangesObserved = Array.isArray(rawChanges);
  const balanceChanges: BalanceChange[] = [];
  if (balanceChangesObserved) {
    for (const item of rawChanges as unknown[]) {
      const change = asObject(item);
      if (change === null) {
        return fail('malformed', source, 'a balance change was not an object.');
      }
      const { coinType, address, amount } = change;
      if (
        typeof coinType !== 'string' ||
        typeof address !== 'string' ||
        typeof amount !== 'string'
      ) {
        // Not coerced. An amount that is a number has already lost precision above 2^53, and
        // `String(number)` would launder that loss into something the parser accepts.
        return fail(
          'malformed',
          source,
          'a balance change did not carry string coinType, address and amount. Amounts are not ' +
            'coerced from numbers: above 2^53 a number has already lost the value.',
        );
      }
      balanceChanges.push({ coinType, address, amount });
    }
  }

  const transactionData = asObject(payload['transaction']);
  if (transactionData === null) {
    return fail(
      'malformed',
      source,
      'the response carried no parsed transaction data, so the commands, the gas budget and the ' +
        'transfer recipients could not be read. Request it with include: { transaction: true }.',
    );
  }

  const gasData = asObject(transactionData['gasData']);
  const gasBudgetMist =
    typeof gasData?.['budget'] === 'string'
      ? (gasData['budget'] as string)
      : // A missing budget is reported as a string no rule can parse, so `gas-budget` refuses.
        'unreadable';

  const reportedSender =
    typeof transactionData['sender'] === 'string' ? (transactionData['sender'] as string) : sender;

  const inputs = Array.isArray(transactionData['inputs']) ? (transactionData['inputs'] as unknown[]) : [];
  const commands = Array.isArray(transactionData['commands'])
    ? (transactionData['commands'] as unknown[])
    : [];

  const commandKinds: CommandKind[] = [];
  const moveCalls: MoveCallEffect[] = [];
  const transfers: TransferEffect[] = [];
  /** Input index -> the commands that referenced it. Filled by the loop below. */
  const references = new Map<number, number[]>();

  for (let index = 0; index < commands.length; index += 1) {
    const command = asObject(commands[index]);
    if (command === null) {
      return fail('malformed', source, `command ${index} was not an object.`);
    }
    const kind = typeof command['$kind'] === 'string' ? (command['$kind'] as string) : 'Unknown';
    commandKinds.push(asCommandKind(kind));

    if (kind === 'MoveCall') {
      const call = asObject(command['MoveCall']);
      if (call === null) {
        return fail('malformed', source, `command ${index} is a MoveCall with no payload.`);
      }
      const packageId = call['package'];
      const moduleName = call['module'];
      const functionName = call['function'];
      if (
        typeof packageId !== 'string' ||
        typeof moduleName !== 'string' ||
        typeof functionName !== 'string'
      ) {
        return fail('malformed', source, `command ${index} has an unreadable MoveCall target.`);
      }
      const typeArguments = Array.isArray(call['typeArguments'])
        ? (call['typeArguments'] as unknown[]).map((t) => (typeof t === 'string' ? t : 'unreadable'))
        : [];
      moveCalls.push({
        index,
        target: `${packageId}::${moduleName}::${functionName}`,
        typeArguments,
      });
    }

    if (kind === 'TransferObjects') {
      const transfer = asObject(command['TransferObjects']);
      if (transfer === null) {
        return fail('malformed', source, `command ${index} is a TransferObjects with no payload.`);
      }
      // FINDING 2: this is an Argument reference, not an address.
      transfers.push({ index, recipient: resolveAddressArgument(transfer['address'], inputs) });
    }

    collectInputReferences(command, index, references);
  }

  return ok(
    {
      sender: reportedSender,
      gasBudgetMist,
      balanceChanges,
      balanceChangesObserved,
      moveCalls,
      transfers,
      commandKinds,
      // FINDING 4. Read after the command loop, because the command loop is what discovers which
      // input each command referenced.
      objectInputs: readObjectInputs(inputs, references),
      observedAtMs,
    },
    observedAtMs,
  );
}

/**
 * Record every `Input` reference a command makes, wherever in its payload it sits.
 *
 * # Why this walks the payload instead of reading the fields by name
 *
 * Each command kind puts its arguments somewhere different — `MoveCall.arguments`,
 * `TransferObjects.objects` and `.address`, `SplitCoins.coin` and `.amounts`,
 * `MergeCoins.destination` and `.sources`, `MakeMoveVec.elements`, `Upgrade.ticket`, and
 * `$Intent.inputs`, which is a record rather than an array. A field-by-field reader is a list that
 * has to be kept in step with a library, and the failure mode when it falls behind is silent: a
 * new command kind's arguments are simply not seen.
 *
 * This is reporting only — which command to name in a refusal — so a missed reference costs a
 * sentence, not a check. Rule `object-input` holds every input to the allow-list whether or not a
 * reference to it was found, precisely so that a gap here can never become a gap there.
 */
function collectInputReferences(
  value: unknown,
  commandIndex: number,
  into: Map<number, number[]>,
  depth = 0,
): void {
  if (depth > MAX_ARGUMENT_DEPTH) return;

  if (Array.isArray(value)) {
    for (const item of value) collectInputReferences(item, commandIndex, into, depth + 1);
    return;
  }

  const object = asObject(value);
  if (object === null) return;

  if (object['$kind'] === 'Input' && typeof object['Input'] === 'number') {
    const index = object['Input'];
    // `Number.isInteger` rather than a truthiness check: an `Input` of 1.5 or NaN indexes nothing,
    // and recording it would put a fictional entry in the refusal message.
    if (Number.isInteger(index)) {
      const seen = into.get(index);
      if (seen === undefined) into.set(index, [commandIndex]);
      else if (!seen.includes(commandIndex)) seen.push(commandIndex);
    }
    return;
  }

  for (const nested of Object.values(object)) {
    collectInputReferences(nested, commandIndex, into, depth + 1);
  }
}

/**
 * Turn the input list into the object inputs rule `object-input` will judge. FINDING 4.
 *
 * # What is omitted, and it is only ever two things
 *
 * `Pure` and `UnresolvedPure` are values, not objects: a split amount, a `vector<u8>` content key,
 * the 32 BCS bytes of a transfer recipient. They carry no object id and there is nothing for an
 * object allow-list to say about them. Everything else in the list comes out, classified where
 * that was possible and `'unclassified'` where it was not.
 *
 * **Nothing is dropped for being unreadable.** That is the whole discipline of this function. An
 * input the reader silently skipped would shorten the list, and a shorter list is a transaction
 * that appears to touch fewer objects — which is indistinguishable, to every rule, from a
 * transaction that is safe. The vault argument going missing is exactly the outcome the rule
 * exists to prevent.
 *
 * # References to inputs that are not there
 *
 * A command may name an input index the list does not contain — a response whose `inputs` was not
 * an array at all (this reader defaults that to `[]`), or one shorter than the commands expect.
 * Those become unclassified entries at the index they named. Resolving them to nothing would mean
 * a truncated input list reads as a transaction with fewer objects in it, which is the same defect
 * arriving by a different road.
 */
function readObjectInputs(
  inputs: readonly unknown[],
  references: Map<number, number[]>,
): ObjectInput[] {
  const out: ObjectInput[] = [];

  for (let index = 0; index < inputs.length; index += 1) {
    const commandIndexes = references.get(index) ?? [];
    const classified = classifyInput(index, inputs[index], commandIndexes);
    if (classified !== null) out.push(classified);
  }

  for (const [index, commandIndexes] of references) {
    if (index >= 0 && index < inputs.length) continue;
    out.push({ index, objectId: '', ownership: 'unclassified', commandIndexes: [...commandIndexes] });
  }

  return out;
}

/** One input, classified. `null` means it is a pure value and is not an object at all. */
function classifyInput(
  index: number,
  raw: unknown,
  commandIndexes: readonly number[],
): ObjectInput | null {
  const unclassified = (objectId: string): ObjectInput => ({
    index,
    objectId,
    ownership: 'unclassified',
    commandIndexes: [...commandIndexes],
  });

  const input = asObject(raw);
  if (input === null) return unclassified('');

  const kind = input['$kind'];
  if (kind === 'Pure' || kind === 'UnresolvedPure') return null;

  if (kind !== 'Object') {
    /*
      `UnresolvedObject` and `FundsWithdrawal` land here, and both are refused.

      An `UnresolvedObject` carries an id but no ownership shape; `Transaction.build()` is supposed
      to resolve it before the bytes are simulated, so one surviving into a simulation response
      means something upstream did not finish. Its id is carried through anyway — a refusal that
      names the object is worth more to whoever has to read it than one that does not — but the
      ownership stays `'unclassified'` and the rule refuses it either way.

      `FundsWithdrawal` is not an object at all: it withdraws from a balance. It has no id to
      allow-list, and a value movement this reader has never been shown is not one to wave past.
    */
    const objectId = input['UnresolvedObject'];
    const nested = asObject(objectId);
    return unclassified(typeof nested?.['objectId'] === 'string' ? nested['objectId'] : '');
  }

  const arg = asObject(input['Object']);
  if (arg === null) return unclassified('');

  const ownership = OBJECT_ARG_KINDS[String(arg['$kind'])];
  if (ownership === undefined) {
    // A fourth variant added to `ObjectArgSchema` after this was written. Refused until somebody
    // reads it and decides on purpose, which is the same rule `asCommandKind` follows.
    return unclassified('');
  }

  const payload = asObject(arg[String(arg['$kind'])]);
  const objectId = payload?.['objectId'];
  if (typeof objectId !== 'string') return unclassified('');

  return { index, objectId, ownership, commandIndexes: [...commandIndexes] };
}

/**
 * The three variants of `ObjectArgSchema`, mapped to what the policy package calls them.
 *
 * `ImmOrOwnedObject` becomes `'imm-or-owned'` and not `'owned'`: the wire shape is a bare object
 * reference with no ownership flag, so immutable and address-owned are genuinely indistinguishable
 * here. Naming it `'owned'` would be a claim this reader cannot support.
 */
const OBJECT_ARG_KINDS: Readonly<Record<string, ObjectOwnership | undefined>> = {
  SharedObject: 'shared',
  ImmOrOwnedObject: 'imm-or-owned',
  Receiving: 'receiving',
};

/**
 * Resolve a `TransferObjects` recipient argument to a concrete address.
 *
 * Only an `Input` pointing at a `Pure` value can be resolved before execution. A `Result`,
 * `NestedResult` or `GasCoin` recipient is computed by the transaction itself and is unknowable
 * here — so it becomes {@link UNRESOLVED_RECIPIENT}, which is not a Sui address and therefore
 * cannot appear in any allow-list. The transfer is refused. That is the correct answer: a
 * destination we cannot name before signing is a destination we cannot approve.
 */
function resolveAddressArgument(argument: unknown, inputs: readonly unknown[]): string {
  const arg = asObject(argument);
  if (arg === null) return UNRESOLVED_RECIPIENT;

  if (arg['$kind'] !== 'Input' || typeof arg['Input'] !== 'number') {
    return UNRESOLVED_RECIPIENT;
  }

  const input = asObject(inputs[arg['Input'] as number]);
  if (input === null || input['$kind'] !== 'Pure') return UNRESOLVED_RECIPIENT;

  const pure = asObject(input['Pure']);
  const bytes = pure?.['bytes'];

  // Measured live: base64. A `Uint8Array` is accepted too, because a different transport or a
  // future client version may hand back raw bytes and silently returning "unresolved" for a
  // recipient we could have read would deny every transfer for a reason nobody could find.
  let raw: Uint8Array;
  if (typeof bytes === 'string') {
    try {
      raw = Uint8Array.from(Buffer.from(bytes, 'base64'));
    } catch {
      return UNRESOLVED_RECIPIENT;
    }
  } else if (bytes instanceof Uint8Array) {
    raw = bytes;
  } else {
    return UNRESOLVED_RECIPIENT;
  }

  // A BCS `address` is exactly 32 bytes with no length prefix. Anything else is not an address
  // input, and padding or truncating it would invent a destination.
  if (raw.length !== 32) return UNRESOLVED_RECIPIENT;

  let hex = '';
  for (const byte of raw) hex += byte.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

function asCommandKind(kind: string): CommandKind {
  switch (kind) {
    case 'MoveCall':
    case 'TransferObjects':
    case 'SplitCoins':
    case 'MergeCoins':
    case 'MakeMoveVec':
    case 'Publish':
    case 'Upgrade':
      return kind;
    default:
      // An unrecognised kind — a newly added command, or a rename — becomes `Unknown`, which no
      // policy permits. A new command kind must be a refusal until somebody allows it on purpose.
      return 'Unknown';
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** The node's error is a structured object, not a string. Preserve it whole; never guess at it. */
function stringifyError(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error === null || error === undefined) return 'failed with no error detail';
  const object = asObject(error);
  // `message` is the human-readable field and is the one `decodeAbort` can parse. When it is
  // present it is used alone; otherwise the whole object is preserved rather than summarised.
  if (object !== null && typeof object['message'] === 'string') return object['message'] as string;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Build a transaction to bytes, reporting a build-time abort as what it is. */
export async function buildBytes(
  client: SuiGrpcClient,
  transaction: Transaction,
  sender: string,
): Promise<Reading<Uint8Array>> {
  const source = 'transaction build';
  try {
    transaction.setSenderIfNotSet(sender);
    return ok(await transaction.build({ client }));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    /*
      A build is a chain interaction, and it can abort.

      Measured live on mainnet 2026-08-31: for a sender whose gas payment is the empty list — the
      address-balance form, which is what an address with no `Coin<SUI>` objects gets —
      `tx.build({ client })` performs server-side gas selection that itself simulates. An aborting
      transaction therefore throws **here**, before `simulate()` is ever reached:

        Transaction resolution failed: MoveAbort in 1st command, abort code: 0,
        in '0x…::u64::div_ceil' (instruction 6)

      That is exactly the format `decodeAbort` parses, so the abort is decoded and reported rather
      than lost. `packages/sdk/src/client.ts` catches this same throw and returns
      `fail('transport', …)` — which tells an operator to retry a deterministic Move abort that
      will reproduce for ever. It is classified `malformed` here instead: permanent, and not the
      network's fault.
    */
    if (/MoveAbort|abort code:/i.test(detail)) {
      const abort = decodeAbort(detail);
      return fail(
        'malformed',
        source,
        `the transaction aborts and could not even be built: ${detail}` +
          (abort.explanation === null ? '' : ` — ${abort.explanation}`),
      );
    }
    return fail('transport', source, classify(error, source).detail);
  }
}
