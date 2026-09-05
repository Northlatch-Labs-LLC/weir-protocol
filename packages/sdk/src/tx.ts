// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Transaction builders.
 *
 * # Why every function here quotes its Move signature
 *
 * A programmable transaction is an untyped, positional boundary. `moveCall` takes an array of
 * arguments and no compiler checks that they are in the right order or of the right type. Swapping
 * two same-typed `u64`s produces something that builds, signs, and then does the wrong thing —
 * `set_fees(platform, cap, 290, 0, 0)` and `set_fees(platform, cap, 0, 290, 0)` are equally valid
 * to TypeScript, and one of them sets a 0% platform fee with a 2.9% referral share.
 *
 * So the authoritative Move signature is quoted verbatim above each call site. Review becomes a
 * comparison rather than a memory exercise, and `test/tx.test.ts` reads the constructed
 * transaction back and asserts the argument count, order and type parameters.
 *
 * # These functions build; they do not sign
 *
 * Nothing here executes. Every builder returns a `Transaction` for the caller to simulate first —
 * see `simulate()` in `client.ts`. The confirming action is never offered until a simulation has
 * passed, because on a chain an abort discovered after signing has already cost gas, and a
 * *success* discovered after signing may have moved money somewhere unintended.
 */

import { Transaction, type TransactionObjectArgument } from '@mysten/sui/transactions';
import type { ProjectXSocialConfig } from './config.js';

/** The Sui framework `Clock`. A fixed, well-known shared object. */
const CLOCK_ID = '0x6';

/** The Sui framework `SuiSystemState`. Required by every staking call. */
const SUI_SYSTEM_STATE_ID = '0x5';

export interface BuilderContext {
  config: ProjectXSocialConfig;
  /** Reuse an existing transaction to compose several calls; otherwise a fresh one is made. */
  tx?: Transaction;
}

function begin(ctx: BuilderContext): Transaction {
  return ctx.tx ?? new Transaction();
}

// === Identity ===

/**
 * Open a social account and claim a handle.
 *
 * ```move
 * public fun open(
 *     platform: &mut Platform,
 *     registry: &mut Registry,
 *     handle: String,
 *     referrer: Option<address>,
 *     clock: &Clock,
 *     ctx: &mut TxContext,
 * )
 * ```
 *
 * `handle` must be 3–30 bytes of `[a-z0-9_]`. The contract rejects anything else rather than
 * normalising it, so validate before asking a user to sign — a rejected transaction still costs
 * them gas and tells them nothing useful.
 */
export function openAccount(
  ctx: BuilderContext,
  args: { handle: string; referrer?: string | null },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::account::open`,
    arguments: [
      tx.object(ctx.config.platformId),
      tx.object(ctx.config.registryId),
      tx.pure.string(args.handle),
      tx.pure.option('address', args.referrer ?? null),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

// === Creator vault (the flow leg) ===

/**
 * Open a creator vault for coin type `T`.
 *
 * ```move
 * public fun open_vault<T>(
 *     platform: &mut Platform,
 *     creator_account: &SocialAccount,
 *     payment: Coin<SUI>,
 *     ctx: &mut TxContext,
 * ): (CreatorCap, Coin<SUI>)
 * ```
 *
 * Returns two values. The change coin **must** be dealt with or the transaction aborts on an
 * unused value, so it is transferred back to the sender here rather than left for the caller to
 * remember.
 */
export function openCreatorVault(
  ctx: BuilderContext,
  args: { coinType: string; accountId: string; paymentCoin: TransactionObjectArgument; sender: string },
): Transaction {
  const tx = begin(ctx);
  const [cap, change] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::open_vault`,
    typeArguments: [args.coinType],
    arguments: [tx.object(ctx.config.platformId), tx.object(args.accountId), args.paymentCoin],
  });
  tx.transferObjects([cap!, change!], args.sender);
  return tx;
}

/**
 * ```move
 * public fun add_tier<T>(
 *     vault: &mut CreatorVault<T>, cap: &CreatorCap,
 *     name: String, price: u64, period_ms: u64,
 * )
 * ```
 *
 * `price` is in `T`'s smallest units and `period_ms` in milliseconds — two `u64`s in a row, which
 * is exactly the swap `test/tx.test.ts` guards against. The period must be at least THIRTY days
 * (`MIN_PERIOD_MS`, creator.move) and a whole number of 30-day Seal periods
 * (`EPeriodNotWholeSealPeriods`, code 18), up to about ten years; a caller who follows the old
 * "one day" sentence pays gas to be told no with code 9 or 18.
 */
export function addTier(
  ctx: BuilderContext,
  args: {
    coinType: string;
    vaultId: string;
    capId: string;
    name: string;
    price: bigint;
    periodMs: bigint;
  },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::add_tier`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.capId),
      tx.pure.string(args.name),
      tx.pure.u64(args.price),
      tx.pure.u64(args.periodMs),
    ],
  });
  return tx;
}

/**
 * ```move
 * public fun set_content_price<T>(
 *     vault: &mut CreatorVault<T>, cap: &CreatorCap,
 *     content_key: vector<u8>, price: u64,
 * )
 * ```
 *
 * Setting a price is what makes content purchasable. There is no "locked but unpriced" state —
 * absence of a price means not for sale, not free.
 */
export function setContentPrice(
  ctx: BuilderContext,
  args: {
    coinType: string;
    vaultId: string;
    capId: string;
    contentKey: Uint8Array;
    price: bigint;
  },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::set_content_price`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.capId),
      tx.pure.vector('u8', Array.from(args.contentKey)),
      tx.pure.u64(args.price),
    ],
  });
  return tx;
}

/**
 * Subscribe to a tier.
 *
 * ```move
 * public fun subscribe<T>(
 *     platform: &Platform, vault: &mut CreatorVault<T>, buyer: &SocialAccount,
 *     tier_index: u64, payment: Coin<T>, clock: &Clock, ctx: &mut TxContext,
 * ): Coin<T>
 * ```
 *
 * Returns change, which is transferred back to the buyer. Overpaying a subscription is not a
 * donation — a caller who wants to give more should call {@link tip}, which says so.
 */
export function subscribe(
  ctx: BuilderContext,
  args: {
    coinType: string;
    vaultId: string;
    accountId: string;
    tierIndex: bigint;
    paymentCoin: TransactionObjectArgument;
    sender: string;
  },
): Transaction {
  const tx = begin(ctx);
  const [change] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::subscribe`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(ctx.config.platformId),
      tx.object(args.vaultId),
      tx.object(args.accountId),
      tx.pure.u64(args.tierIndex),
      args.paymentCoin,
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([change!], args.sender);
  return tx;
}

/**
 * ```move
 * public fun tip<T>(
 *     platform: &Platform, vault: &mut CreatorVault<T>, buyer: &SocialAccount,
 *     payment: Coin<T>, ctx: &mut TxContext,
 * )
 * ```
 *
 * Takes the coin entire — a tip has no price to overpay — and returns nothing.
 */
export function tip(
  ctx: BuilderContext,
  args: {
    coinType: string;
    vaultId: string;
    accountId: string;
    paymentCoin: TransactionObjectArgument;
  },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::tip`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(ctx.config.platformId),
      tx.object(args.vaultId),
      tx.object(args.accountId),
      args.paymentCoin,
    ],
  });
  return tx;
}

/**
 * Buy permanent access to one piece of content.
 *
 * ```move
 * public fun unlock<T>(
 *     platform: &Platform, vault: &mut CreatorVault<T>, buyer: &SocialAccount,
 *     content_key: vector<u8>, payment: Coin<T>, clock: &Clock, ctx: &mut TxContext,
 * ): Coin<T>
 * ```
 *
 * The price comes from the vault, never from the caller — a client-supplied price would let a
 * buyer name their own.
 */
export function unlockContent(
  ctx: BuilderContext,
  args: {
    coinType: string;
    vaultId: string;
    accountId: string;
    contentKey: Uint8Array;
    paymentCoin: TransactionObjectArgument;
    sender: string;
  },
): Transaction {
  const tx = begin(ctx);
  const [change] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::unlock`,
    typeArguments: [args.coinType],
    arguments: [
      tx.object(ctx.config.platformId),
      tx.object(args.vaultId),
      tx.object(args.accountId),
      tx.pure.vector('u8', Array.from(args.contentKey)),
      args.paymentCoin,
      tx.object(CLOCK_ID),
    ],
  });
  tx.transferObjects([change!], args.sender);
  return tx;
}

/**
 * Withdraw creator earnings.
 *
 * ```move
 * public fun claim_earnings<T>(
 *     vault: &mut CreatorVault<T>, cap: &CreatorCap, amount: u64, ctx: &mut TxContext,
 * ): Coin<T>
 * ```
 *
 * Consults no pause switch on chain. There is no approval queue and no processing delay.
 */
export function claimEarnings(
  ctx: BuilderContext,
  args: { coinType: string; vaultId: string; capId: string; amount: bigint; recipient: string },
): Transaction {
  const tx = begin(ctx);
  const [coin] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::claim_earnings`,
    typeArguments: [args.coinType],
    arguments: [tx.object(args.vaultId), tx.object(args.capId), tx.pure.u64(args.amount)],
  });
  tx.transferObjects([coin!], args.recipient);
  return tx;
}

/**
 * Open or close a vault to new payments.
 *
 * ```move
 * public fun set_accepting<T>(vault: &mut CreatorVault<T>, cap: &CreatorCap, accepting: bool)
 * ```
 *
 * # This is how a creator vault is retired, and it is the only way
 *
 * There is no destroy, no close and no delete in `creator.move`. A `CreatorVault` is a shared object
 * and it exists for as long as the chain does — which is correct, because subscriptions and unlocks
 * already sold point at it and would be orphaned by anything else. Retiring therefore means refusing
 * new money, not removing the vault.
 *
 * Reversible on purpose. Closing is a decision a creator makes on a bad week, and one that could not
 * be undone would be a trap rather than a control.
 *
 * What it does **not** touch: earnings already in the vault stay withdrawable, entitlements already
 * bought keep working, and posts stay readable. Closing takes nothing away from anybody who paid.
 */
export function setAccepting(
  ctx: BuilderContext,
  args: { coinType: string; vaultId: string; capId: string; accepting: boolean },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::set_accepting`,
    typeArguments: [args.coinType],
    arguments: [tx.object(args.vaultId), tx.object(args.capId), tx.pure.bool(args.accepting)],
  });
  return tx;
}

/**
 * Withdraw the platform's accrued commission from one vault.
 *
 * ```move
 * public fun claim_platform_fees<T>(
 *     vault: &mut CreatorVault<T>, cap: &PlatformCap, amount: u64, ctx: &mut TxContext,
 * ): Coin<T>
 * ```
 *
 * # One vault at a time, and why that is not a flaw to design around
 *
 * Commission accrues inside the vault that charged it, in that vault's coin, never pooled. The
 * contract's own note gives the reason: a creator's earnings and the platform's commission are
 * never in the same balance, so no arithmetic error can pay one out of the other. The cost is that
 * collecting is one transaction per vault, and there is no batching call that would remove it.
 *
 * # The coin is transferred explicitly
 *
 * `claim_platform_fees` **returns** a `Coin<T>`, and a returned coin that is never transferred
 * makes the transaction fail to build — Move cannot drop it. The recipient is a parameter rather
 * than a default, because anything else would be this code choosing where the platform's money
 * goes.
 */
export function claimPlatformFees(
  ctx: BuilderContext,
  args: { coinType: string; vaultId: string; capId: string; amount: bigint; recipient: string },
): Transaction {
  const tx = begin(ctx);
  const [coin] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::creator::claim_platform_fees`,
    typeArguments: [args.coinType],
    arguments: [tx.object(args.vaultId), tx.object(args.capId), tx.pure.u64(args.amount)],
  });
  tx.transferObjects([coin!], args.recipient);
  return tx;
}

// === Stake vault (the stake leg) ===

/**
 * Open a stake vault.
 *
 * ```move
 * public fun open(
 *     platform: &mut Platform, creator_account: &SocialAccount,
 *     validator: address, ctx: &mut TxContext,
 * ): StakeCap
 * ```
 *
 * `validator` is stamped into the vault and cannot be changed afterwards. Verify it is an active
 * validator, and read its commission — commission comes off yield before the vault ever sees it,
 * so it reduces creator revenue invisibly from inside the contract's own accounting.
 */
export function openStakeVault(
  ctx: BuilderContext,
  args: { accountId: string; validator: string; sender: string },
): Transaction {
  const tx = begin(ctx);
  const [cap] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::stake_vault::open`,
    arguments: [
      tx.object(ctx.config.platformId),
      tx.object(args.accountId),
      tx.pure.address(args.validator),
    ],
  });
  tx.transferObjects([cap!], args.sender);
  return tx;
}

/**
 * Deposit SUI. Principal stays the depositor's and is redeemable at any time.
 *
 * ```move
 * public fun deposit(
 *     platform: &Platform, vault: &mut StakeVault, depositor_account: &SocialAccount,
 *     payment: Coin<SUI>, ctx: &mut TxContext,
 * )
 * ```
 */
export function depositStake(
  ctx: BuilderContext,
  args: { vaultId: string; accountId: string; paymentCoin: TransactionObjectArgument },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::stake_vault::deposit`,
    arguments: [
      tx.object(ctx.config.platformId),
      tx.object(args.vaultId),
      tx.object(args.accountId),
      args.paymentCoin,
    ],
  });
  return tx;
}

/**
 * Withdraw principal. Always available, in full, immediately.
 *
 * ```move
 * public fun withdraw(
 *     vault: &mut StakeVault, depositor_account: &SocialAccount, amount: u64,
 *     state: &mut SuiSystemState, ctx: &mut TxContext,
 * ): Coin<SUI>
 * ```
 *
 * If the vault's liquid buffer is short it unwinds staking tranches to cover this. That is why
 * `SuiSystemState` is required even for a withdrawal the buffer could have covered — the builder
 * cannot know in advance which case applies, and omitting it would make large withdrawals fail.
 */
export function withdrawStake(
  ctx: BuilderContext,
  args: { vaultId: string; accountId: string; amount: bigint; recipient: string },
): Transaction {
  const tx = begin(ctx);
  const [coin] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::stake_vault::withdraw`,
    arguments: [
      tx.object(args.vaultId),
      tx.object(args.accountId),
      tx.pure.u64(args.amount),
      tx.object(SUI_SYSTEM_STATE_ID),
    ],
  });
  tx.transferObjects([coin!], args.recipient);
  return tx;
}

/**
 * Harvest matured stake and restake one rung.
 *
 * ```move
 * public fun harvest(vault: &mut StakeVault, state: &mut SuiSystemState, ctx: &mut TxContext)
 * ```
 *
 * **Permissionless** — anyone may call it. That is the liveness guarantee: an absent creator
 * delays nothing, because the yield a harvest realises is not theirs to withhold. A daemon should
 * call this once per epoch per vault; calling it more often is harmless but stakes nothing extra,
 * because the contract permits at most one rung per epoch.
 */
export function harvest(ctx: BuilderContext, args: { vaultId: string }): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::stake_vault::harvest`,
    arguments: [tx.object(args.vaultId), tx.object(SUI_SYSTEM_STATE_ID)],
  });
  return tx;
}

/**
 * Claim accrued depositor rebate.
 *
 * ```move
 * public fun claim_rebate(
 *     vault: &mut StakeVault, depositor_account: &SocialAccount, ctx: &mut TxContext,
 * ): Coin<SUI>
 * ```
 */
export function claimRebate(
  ctx: BuilderContext,
  args: { vaultId: string; accountId: string; recipient: string },
): Transaction {
  const tx = begin(ctx);
  const [coin] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::stake_vault::claim_rebate`,
    arguments: [tx.object(args.vaultId), tx.object(args.accountId)],
  });
  tx.transferObjects([coin!], args.recipient);
  return tx;
}

/**
 * Withdraw the creator's share of realised yield.
 *
 * ```move
 * public fun claim_creator_yield(
 *     vault: &mut StakeVault, cap: &StakeCap, amount: u64, ctx: &mut TxContext,
 * ): Coin<SUI>
 * ```
 */
export function claimCreatorYield(
  ctx: BuilderContext,
  args: { vaultId: string; capId: string; amount: bigint; recipient: string },
): Transaction {
  const tx = begin(ctx);
  const [coin] = tx.moveCall({
    target: `${ctx.config.latestPackageId}::stake_vault::claim_creator_yield`,
    arguments: [tx.object(args.vaultId), tx.object(args.capId), tx.pure.u64(args.amount)],
  });
  tx.transferObjects([coin!], args.recipient);
  return tx;
}

/**
 * Set the depositors' share of yield.
 *
 * ```move
 * public fun set_rebate_bps(vault: &mut StakeVault, cap: &StakeCap, rebate_bps: u64)
 * ```
 *
 * Basis points of the yield, out of the CREATOR's share — a creator choosing to give some of their
 * revenue back to the people funding it. It starts at zero, because a rebate nobody configured
 * should not quietly redirect somebody's income.
 *
 * The contract's ceiling is 10000, which is all of it. That is a legitimate choice and not a
 * mistake to guard against: a creator may run a vault purely as a savings product for their
 * audience.
 */
export function setRebateBps(
  ctx: BuilderContext,
  args: { vaultId: string; capId: string; rebateBps: bigint },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::stake_vault::set_rebate_bps`,
    arguments: [tx.object(args.vaultId), tx.object(args.capId), tx.pure.u64(args.rebateBps)],
  });
  return tx;
}

// === Encryption keys ===

/**
 * Publish or rotate the sender's X25519 encryption key.
 *
 * ```move
 * public fun publish(
 *     registry: &mut KeyRegistry,
 *     x25519_public: vector<u8>,
 *     clock: &Clock,
 *     ctx: &TxContext,
 * )
 * ```
 *
 * There is no address argument, in the contract or here. The sender is the only address this can
 * write, so publishing a key on someone else's behalf is not a call anyone can make — which is the
 * property that makes the on-chain registry worth the gas over a database one.
 *
 * The key must be exactly 32 bytes and not all zeros; the contract aborts otherwise. Check before
 * asking a user to sign, because a rejected transaction still costs them gas.
 */
export function publishEncryptionKey(
  ctx: BuilderContext,
  args: { keyRegistryId: string; x25519Public: Uint8Array },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::key_registry::publish`,
    arguments: [
      tx.object(args.keyRegistryId),
      tx.pure.vector('u8', Array.from(args.x25519Public)),
      tx.object(CLOCK_ID),
    ],
  });
  return tx;
}

/**
 * Withdraw the sender's published key.
 *
 * ```move
 * public fun revoke(registry: &mut KeyRegistry, ctx: &TxContext)
 * ```
 *
 * Aborts if the sender has published none. It does not make already-sent messages unreadable —
 * those were readable before the call and nothing on chain can retract them.
 */
export function revokeEncryptionKey(
  ctx: BuilderContext,
  args: { keyRegistryId: string },
): Transaction {
  const tx = begin(ctx);
  tx.moveCall({
    target: `${ctx.config.latestPackageId}::key_registry::revoke`,
    arguments: [tx.object(args.keyRegistryId)],
  });
  return tx;
}

/** Framework object ids, exported so tests can assert them rather than restate the literals. */
export const FRAMEWORK = { CLOCK_ID, SUI_SYSTEM_STATE_ID } as const;
