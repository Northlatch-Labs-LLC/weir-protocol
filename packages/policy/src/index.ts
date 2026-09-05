// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `@projectx-social/policy` — the last thing that says no.
 *
 * A pure evaluator with zero dependencies and no I/O. It takes what a simulation observed, what an
 * operator wrote down, and what the agent has already spent, and returns allow or a reason.
 *
 * It signs nothing, reads nothing and remembers nothing. `@projectx-social/signer` is the only
 * caller that matters, and it is the only place in this repository where a signature is produced.
 */

export {
  type BalanceChange,
  type CommandKind,
  type MoveCallEffect,
  type ObjectInput,
  type ObjectOwnership,
  type SimulatedEffects,
  type TransferEffect,
} from './effects.js';

export { type OutflowCeiling, type PolicyDoc, canonicalPolicyJson } from './policy.js';

export { type LedgerEntry, type LedgerState, EMPTY_LEDGER } from './ledger.js';

export { type Rule, type RuleId, type RuleInput, RULES } from './rules.js';

export { type Decision, evaluate, evaluateWith, rulesWithout } from './evaluate.js';

export { normaliseAddress, normaliseTarget, normaliseType } from './names.js';

export { outflowMagnitude, parseSignedAmount, parseUnsignedAmount } from './amounts.js';
