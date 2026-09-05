// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * What a simulation observed, in the only shape this evaluator will look at.
 *
 * # Why this package defines the shape instead of importing the node's
 *
 * `@projectx-social/policy` has no dependencies, so it cannot import `@mysten/sui`'s
 * `SimulateTransactionResult`. That is deliberate and it buys something: the evaluator is
 * insulated from a client-library rename. The SDK has already been bitten once by exactly that —
 * `packages/sdk/src/client.ts` carries a long comment about `transaction.effects.status` silently
 * becoming `Transaction.status`, which made every simulation report failure for weeks. A rename
 * on that boundary must break a **translation** in one file, loudly, rather than quietly empty an
 * array the ceiling rules iterate over.
 *
 * The translation lives in `@projectx-social/signer` (`src/evidence.ts`) and is tested against
 * shapes captured from a live mainnet simulation.
 *
 * # Absence and emptiness are different, and the type says so
 *
 * `balanceChanges: []` means the node was asked for balance changes and reported none. It does
 * **not** mean the node was not asked. Those two states must never share a representation, because
 * one is "this transaction moves no money" and the other is "we do not know what this transaction
 * moves", and only the first is safe to sign against a spending ceiling.
 *
 * So `balanceChangesObserved` is a required, separate boolean, and rule `balance-evidence` denies
 * whenever it is false. A caller cannot forget it: leaving it out is a type error.
 */

/** One address's net change in one coin type, exactly as a simulation reported it. */
export interface BalanceChange {
  /** Fully-qualified coin type. Not yet normalised — the evaluator normalises both sides. */
  readonly coinType: string;
  /** The address whose balance moves. */
  readonly address: string;
  /** Signed decimal string. Negative means the address loses value. Never a `number`. */
  readonly amount: string;
}

/** One `MoveCall` command, in the order it appears in the programmable transaction. */
export interface MoveCallEffect {
  /** Position in the command list, so a denial can name the offending command. */
  readonly index: number;
  /** `address::module::function`. Never carries generics; see `normaliseTarget`. */
  readonly target: string;
  /** The call's type arguments, in order. Empty for a non-generic call. */
  readonly typeArguments: readonly string[];
}

/** One `TransferObjects` command's recipient. */
export interface TransferEffect {
  readonly index: number;
  /** The address the objects go to. */
  readonly recipient: string;
}

/**
 * Every command kind the transaction contains, in order.
 *
 * Present as its own list rather than being inferred from `moveCalls` and `transfers`, because the
 * kinds this package has *no* rule for are the dangerous ones. A `Publish` or an `Upgrade` command
 * has no target to allow-list and no recipient to check, so a policy that only inspected move
 * calls and transfers would wave it through. Rule `command-kind` denies any kind not explicitly
 * permitted, which makes an unrecognised or newly-added command kind a refusal by default.
 */
export type CommandKind =
  | 'MoveCall'
  | 'TransferObjects'
  | 'SplitCoins'
  | 'MergeCoins'
  | 'MakeMoveVec'
  | 'Publish'
  | 'Upgrade'
  | 'Unknown';

/** The complete observation a policy decision is made from. */
export interface SimulatedEffects {
  /** The address that would sign. Compared against the policy's own agent address. */
  readonly sender: string;
  /** Gas budget in MIST, as an unsigned decimal string. */
  readonly gasBudgetMist: string;
  /** Every balance change the simulation reported, for every address. */
  readonly balanceChanges: readonly BalanceChange[];
  /** Whether balance changes were actually requested and returned. See this file's header. */
  readonly balanceChangesObserved: boolean;
  readonly moveCalls: readonly MoveCallEffect[];
  readonly transfers: readonly TransferEffect[];
  readonly commandKinds: readonly CommandKind[];
  /**
   * Every object the transaction takes as an input, classified. See {@link ObjectInput}.
   *
   * Required, and required for the same reason `balanceChangesObserved` is: a caller who could
   * leave it out would produce a transaction that appears to touch no objects, and "touches no
   * objects" is the shape rule `object-input` has nothing to refuse. Leaving it out is a type
   * error. An empty array is a claim — the transaction takes no object inputs — and it is a claim
   * only the translator is entitled to make.
   */
  readonly objectInputs: readonly ObjectInput[];
  /** When the simulation was observed. Recorded so an audit entry can be replayed. */
  readonly observedAtMs: number;
}

/**
 * How an object arrived in the transaction, as far as the translator could tell.
 *
 * # The three shapes are not interchangeable, and the fourth is the important one
 *
 * `@mysten/sui` 2.27.1 models an object input as `CallArg.Object`, whose inner enum is exactly
 * three variants — read from `src/transactions/data/internal.ts:270-279` in the installed package,
 * not from documentation:
 *
 * ```ts
 * export const ObjectArgSchema = safeEnum({
 *   ImmOrOwnedObject: ObjectRefSchema,                                   // { objectId, version, digest }
 *   SharedObject: object({ objectId, initialSharedVersion, mutable }),
 *   Receiving: ObjectRefSchema,
 * });
 * ```
 *
 * `'unclassified'` is not one of theirs. It is what this package uses for an input the translator
 * could not reduce to one of those three — a variant added after this was written, an
 * `UnresolvedObject` that never got resolved, a `FundsWithdrawal`, a malformed entry, or a command
 * argument pointing at an input index that does not exist. Rule `object-input` refuses it on
 * sight.
 *
 * That refusal is the whole reason this field exists rather than a bare id string. **A translator
 * that skipped what it could not parse would produce a shorter list, and a shorter list reads as a
 * cleaner transaction.** The one argument that decides who gets paid would go missing and every
 * rule would report allow.
 *
 * `ImmOrOwnedObject` deliberately does not distinguish immutable from owned: the wire shape is a
 * plain object reference and carries no ownership flag, so neither can this. Both are held to the
 * same allow-list, which is the safe direction — an immutable third-party object substituted for
 * an expected one is refused rather than assumed harmless.
 */
export type ObjectOwnership = 'shared' | 'imm-or-owned' | 'receiving' | 'unclassified';

/**
 * One object the transaction takes as an input.
 *
 * # Why the object id is bounded at all, when nothing else needed it
 *
 * The other rules bound the *verb* and the *amount*: which function, at which coin type, to which
 * recipient, for how much. None of them bound the *noun*. On this protocol `creator::unlock` takes
 * `vault: &mut CreatorVault<T>` (`sui-contracts/sources/creator.move:661`), and that argument is
 * the entire answer to whose earnings the payment lands in.
 *
 * So a transaction can call the permitted `creator::unlock`, at the permitted coin type, inside
 * the outflow ceiling, transferring the resulting `Unlock` back to the agent's own address — and
 * pay a **stranger's** vault. Every one of the other eleven rules passes. The loss is capped by
 * the ceiling and by nothing else, and since anyone may open a vault for 29 SUI
 * (`UPDATE.md`, 2026-08-30, read live from mainnet), the destination is attacker-supplied,
 * repeatable and funded. That is the hole `allowedObjects` closes.
 */
export interface ObjectInput {
  /** Position in the transaction's input list, so a refusal can point at one entry. */
  readonly index: number;
  /**
   * The object id as the node reported it. Not normalised here — the evaluator normalises both
   * sides, for the reason `names.ts` gives. Empty string when the translator had no id to report,
   * which pairs with `ownership: 'unclassified'` and is refused.
   */
  readonly objectId: string;
  readonly ownership: ObjectOwnership;
  /**
   * Every command that referenced this input, in order. Plural because one shared object is
   * routinely passed to several commands, and a refusal that named only the first would send the
   * reader to the wrong line.
   *
   * **This is reporting, not scope.** Rule `object-input` checks every entry in the list whether
   * or not a command was seen to reference it. An input nothing appears to reference is far more
   * likely to be a reference shape the translator failed to recognise than a genuinely unused
   * input — and if unreferenced inputs were skipped, failing to recognise one reference form would
   * be enough to walk an attacker's vault straight through the allow-list.
   */
  readonly commandIndexes: readonly number[];
}
