// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The first bound, and the only one the chain enforces for us.
 *
 * # The contract fact this is built on
 *
 * `sui-contracts/sources/creator.move:568-572`:
 *
 * ```move
 * /// Take exactly `price` from `payment`, returning the change.
 * fun take_price<T>(payment: &mut Coin<T>, price: u64, ctx: &mut TxContext): Coin<T> {
 *     assert!(payment.value() >= price, EInsufficientPayment);
 *     payment.split(price, ctx)
 * }
 * ```
 *
 * The contract takes **exactly the price** and hands back the change. It never absorbs the coin.
 * So the coin handed in is a hard ceiling on what that call can cost: fund it at the ceiling and
 * the contract *cannot* take more, whatever the vault says the price is, whatever a manipulated
 * feed reports, and whatever an injected instruction talked the agent into.
 *
 * `subscribe`, `renew` and `unlock` all route through `take_price`. **`tip` does not** — it takes
 * the coin entire, which is correct behaviour for a tip and is exactly why the bound is expressed
 * as "the coin holds no more than the ceiling" rather than "the contract takes no more than the
 * ceiling". Funded at the ceiling, a tip can cost the ceiling and not one MIST more.
 *
 * # Two bounds, and they must stay independent
 *
 * This is bound one. `PolicySigner` is bound two. They are independent on purpose:
 *
 *  - This one is enforced by the chain. It holds even if our policy file is wrong, our ledger is
 *    stale, our evaluator has a bug, or the process signing is not the one we think it is.
 *  - The policy bound is enforced by us. It holds even if the coin was funded wrongly, and it can
 *    see things the chain cannot — a call target, a transfer recipient, a rolling window.
 *
 * A ceiling enforced by the chain beats one enforced by our own code. Having both means a single
 * failure on either side is not a loss. Do not collapse them into one.
 *
 * # What this does not bound
 *
 * **Gas.** Gas comes from the gas coin, not from the payment coin, and no split here touches it.
 * That is what the policy's `maxGasBudgetMist` is for, and it is why a SUI outflow ceiling must be
 * set high enough to cover gas — the node reports gas as an ordinary outflow, measured live:
 * a one-MIST self-transfer produced a balance change of `-1088000`, essentially all of it gas.
 */

import type { Transaction, TransactionObjectArgument } from '@mysten/sui/transactions';

export interface BoundedPaymentArgs {
  /**
   * The coin to draw from: `tx.gas` for SUI, or a coin object argument for any other type.
   *
   * The source is **not** consumed. `splitCoins` takes the ceiling out of it and leaves the rest
   * where it was, so an over-funded source is not at risk from this call.
   */
  readonly source: TransactionObjectArgument;
  /** The ceiling, in the coin's smallest unit. The payment coin will hold exactly this. */
  readonly ceiling: bigint;
}

/**
 * Split a payment coin funded at exactly the ceiling.
 *
 * Pass the returned argument as the `payment` of `subscribe`, `unlock`, `renew` or `tip`. The
 * change those functions return is a separate object the caller must still transfer somewhere —
 * a returned coin that is never transferred makes the transaction fail to build, because Move
 * cannot drop it, and `packages/sdk/src/tx.ts`'s builders already transfer it back to the sender.
 *
 * Throws — rather than returning a `Reading` — on a non-positive ceiling. This is a programming
 * error at transaction-construction time, in the caller's own code, with no user input involved:
 * a zero ceiling would build a transaction that aborts on `EInsufficientPayment` for every priced
 * item, and a negative one is not representable on chain at all. It is the one place in these two
 * packages that throws, and it does so because there is no unattended runtime path to it.
 */
export function boundedPayment(
  tx: Transaction,
  args: BoundedPaymentArgs,
): TransactionObjectArgument {
  /*
    The type is checked before the value, because every check below is a comparison.

    Measured on the three shapes a caller without a compiler reaches. `undefined` fell through both
    comparisons — `undefined <= 0n` and `undefined > MAX_U64` are each `false` — and died inside
    `splitCoins` with "Invalid type: Expected Object but received undefined", which names neither
    this function nor the ceiling. `null` coerced to `0` and entered the first branch, then threw a
    TypeError building its own error message on `null.toString()`. A plain `number` or a numeric
    string was accepted silently: it happens to work, and it quietly leaves the bigint discipline
    that keeps minor units exact above 2^53.

    All three failed closed, so none was a way to overspend. They were ways to be handed a fault
    that does not say what went wrong, which is its own cost at three in the morning.
  */
  if (typeof args.ceiling !== 'bigint') {
    throw new Error(
      `boundedPayment needs a bigint ceiling in the coin's smallest unit; got ` +
        `${typeof args.ceiling} (${String(args.ceiling)}). A number loses precision above 2^53 ` +
        `and a missing value would reach splitCoins as an error naming neither this function nor ` +
        `the ceiling.`,
    );
  }
  if (args.ceiling <= 0n) {
    throw new Error(
      `boundedPayment needs a positive ceiling; got ${args.ceiling.toString()}. A zero-funded ` +
        `payment coin aborts every priced call on EInsufficientPayment, which is a failure that ` +
        `looks like a pricing bug rather than a configuration one.`,
    );
  }
  if (args.ceiling > MAX_U64) {
    throw new Error(
      `boundedPayment ceiling ${args.ceiling.toString()} exceeds u64. It cannot be represented ` +
        `on chain, so the split would be built from a value the contract could never hold.`,
    );
  }

  const [payment] = tx.splitCoins(args.source, [args.ceiling]);
  return payment!;
}

/** 2^64 - 1. A Move `u64` cannot hold more, and a ceiling above it is a typo, not a large ceiling. */
export const MAX_U64 = 18_446_744_073_709_551_615n;
