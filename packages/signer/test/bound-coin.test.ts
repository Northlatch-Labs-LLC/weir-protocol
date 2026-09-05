// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The chain-enforced bound.
 *
 * `creator.move`'s `take_price` asserts `payment.value() >= price` and then splits exactly the
 * price out, returning the change. So a payment coin funded at the ceiling is a ceiling the
 * contract itself enforces — and unlike the policy evaluator, it holds even when our policy file
 * is wrong, our ledger is stale, or the process signing is not the one we think it is.
 *
 * These tests assert the transaction is built the way that bound requires: a split of exactly the
 * ceiling, drawn from a source that is not consumed.
 */

import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import { MAX_U64, boundedPayment } from '../src/index.js';

const AGENT = `0x${'a'.repeat(64)}`;

function built(ceiling: bigint) {
  const tx = new Transaction();
  tx.setSender(AGENT);
  const payment = boundedPayment(tx, { source: tx.gas, ceiling });
  tx.transferObjects([payment], AGENT);
  return tx.getData();
}

describe('boundedPayment', () => {
  it('splits exactly the ceiling out of the source', () => {
    const data = built(2_500_000n);
    const split = data.commands.find((c) => c.$kind === 'SplitCoins');
    expect(split).toBeDefined();

    // The split amount is a pure input. Read it back rather than trusting the call: this value is
    // the whole bound, and an off-by-a-factor here is an agent with a thousand times its allowance.
    const amounts = split!.SplitCoins.amounts;
    expect(amounts).toHaveLength(1);
    const input = data.inputs[(amounts[0] as { Input: number }).Input]!;
    const bytes = Buffer.from((input as { Pure: { bytes: string } }).Pure.bytes, 'base64');
    expect(bytes.readBigUInt64LE(0)).toBe(2_500_000n);
  });

  it('draws from the gas coin without consuming it', () => {
    const data = built(1n);
    const split = data.commands.find((c) => c.$kind === 'SplitCoins');
    expect(split!.SplitCoins.coin.$kind).toBe('GasCoin');
  });

  it('produces exactly one payment coin the caller then spends', () => {
    const data = built(1n);
    expect(data.commands.filter((c) => c.$kind === 'SplitCoins')).toHaveLength(1);
  });

  it('refuses a zero ceiling, which would abort every priced call on EInsufficientPayment', () => {
    const tx = new Transaction();
    tx.setSender(AGENT);
    expect(() => boundedPayment(tx, { source: tx.gas, ceiling: 0n })).toThrow(
      /positive ceiling/,
    );
  });

  it('refuses a negative ceiling', () => {
    const tx = new Transaction();
    tx.setSender(AGENT);
    expect(() => boundedPayment(tx, { source: tx.gas, ceiling: -1n })).toThrow();
  });

  it('refuses a ceiling above u64, which the contract could never hold', () => {
    const tx = new Transaction();
    tx.setSender(AGENT);
    expect(() => boundedPayment(tx, { source: tx.gas, ceiling: MAX_U64 + 1n })).toThrow(
      /exceeds u64/,
    );
  });

  it('accepts exactly u64 max', () => {
    const tx = new Transaction();
    tx.setSender(AGENT);
    expect(() => boundedPayment(tx, { source: tx.gas, ceiling: MAX_U64 })).not.toThrow();
  });
});

describe('a ceiling that is not a bigint', () => {
  /*
   * Every check in `boundedPayment` is a comparison, and a comparison against `undefined` is
   * `false` in both directions — so the two guards were skipped entirely and the failure surfaced
   * inside `splitCoins`, naming neither this function nor the ceiling. `null` coerced to `0`,
   * entered the positive-ceiling branch, and then threw a TypeError while building that branch's
   * own error message. A plain number was accepted silently.
   *
   * None of these was a way to overspend — they all failed closed. They were ways to be handed a
   * fault that does not say what went wrong.
   */
  const tx = () => {
    const t = new Transaction();
    t.setSender(`0x${'9'.repeat(64)}`);
    return t;
  };

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 10_000],
    ['a numeric string', '10000'],
    ['NaN', Number.NaN],
  ])('refuses %s with a message naming the ceiling', (_label, ceiling) => {
    const t = tx();
    expect(() => boundedPayment(t, { source: t.gas, ceiling: ceiling as unknown as bigint }))
      .toThrow(/bigint ceiling/);
  });

  it('still accepts a well-formed bigint ceiling', () => {
    const t = tx();
    expect(() => boundedPayment(t, { source: t.gas, ceiling: 10_000n })).not.toThrow();
  });
});
