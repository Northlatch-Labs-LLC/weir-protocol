// Built-by: @projectx.sui · Co-authored-by: Claude
import { describe, expect, it } from 'vitest';
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { ACC_SCALE, claimableRebateMist, listStakePositions } from '../src/stakevault.js';

/**
 * The members walk and the claimable formula.
 *
 * The layout is written out here rather than imported, so the test pins the wire shape the
 * contract actually emits and not whatever the module under test happens to believe.
 */
const Position = bcs.struct('Position', { principal: bcs.u64(), rebateDebt: bcs.u128(), pending: bcs.u64() });
const Field = bcs.struct('Field', { id: bcs.Address, name: bcs.Address, value: Position });

const A = '0x' + '1'.repeat(64);
const B = '0x' + '2'.repeat(64);
const TABLE = '0x' + 'f'.repeat(64);

function entry(depositor: string, principal: bigint, rebateDebt: bigint, pending: bigint, wrapped = false) {
  const value = wrapped
    ? Field.serialize({ id: TABLE, name: depositor, value: { principal, rebateDebt, pending } }).toBytes()
    : Position.serialize({ principal, rebateDebt, pending }).toBytes();
  return {
    $kind: 'DynamicField' as const,
    fieldId: TABLE,
    name: { type: 'address', bcs: bcs.Address.serialize(depositor).toBytes() },
    valueType: 'stake_vault::Position',
    type: 'Field',
    childId: undefined,
    value: { type: 'stake_vault::Position', bcs: value },
  };
}

function client(pages: Array<{ dynamicFields: unknown[]; cursor: string | null; hasNextPage: boolean }>) {
  const seen: Array<string | undefined> = [];
  let i = 0;
  const fake = {
    listDynamicFields: async (input: { cursor?: string }) => {
      seen.push(input.cursor);
      return pages[i++]!;
    },
  };
  return { client: fake as unknown as SuiGrpcClient, seen };
}

describe('claimableRebateMist', () => {
  it('is the contract\'s claimable_rebate: pending plus what the accumulator has added since', () => {
    // entitled = 1e9 * (2 * ACC_SCALE) / ACC_SCALE = 2e9; owed since last touch = 2e9 - 5e8.
    const position = { principalMist: 1_000_000_000n, pendingRebateMist: 100_000_000n, rebateDebt: 500_000_000n };
    expect(claimableRebateMist(position, 2n * ACC_SCALE)).toBe(100_000_000n + 1_500_000_000n);
  });

  it('is exactly pending when nothing has accrued since the last interaction', () => {
    const acc = 3n * ACC_SCALE;
    const position = { principalMist: 7n, pendingRebateMist: 11n, rebateDebt: (7n * acc) / ACC_SCALE };
    expect(claimableRebateMist(position, acc)).toBe(11n);
  });
});

describe('listStakePositions', () => {
  it('walks every page, passing the cursor back, and decodes both value shapes', async () => {
    const { client: c, seen } = client([
      { dynamicFields: [entry(A, 3_000_000_000n, 0n, 5n)], cursor: 'next', hasNextPage: true },
      { dynamicFields: [entry(B, 1n, 2n, 3n, true)], cursor: null, hasNextPage: false },
    ]);
    const reading = await listStakePositions(c, TABLE);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(seen).toEqual([undefined, 'next']);
    expect(reading.value.truncated).toBe(false);
    expect(reading.value.members).toEqual([
      { depositor: A, principalMist: 3_000_000_000n, pendingRebateMist: 5n, rebateDebt: 0n },
      { depositor: B, principalMist: 1n, pendingRebateMist: 3n, rebateDebt: 2n },
    ]);
  });

  it('says so when the page ceiling stops the walk', async () => {
    const endless = Array.from({ length: 60 }, () => ({
      dynamicFields: [entry(A, 1n, 0n, 0n)],
      cursor: 'more',
      hasNextPage: true,
    }));
    const reading = await listStakePositions(client(endless).client, TABLE);
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.truncated).toBe(true);
    expect(reading.value.members).toHaveLength(50);
  });

  it('refuses a value of the wrong size rather than decoding it into somebody\'s principal', async () => {
    const bad = { ...entry(A, 1n, 0n, 0n), value: { type: 'x', bcs: new Uint8Array(7) } };
    const reading = await listStakePositions(client([{ dynamicFields: [bad], cursor: null, hasNextPage: false }]).client, TABLE);
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.failure.kind).toBe('malformed');
  });
});
