// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The tick engine, driven entirely by fixtures — no chain, no clock, no network.
 *
 * The cases worth having are the ones about *isolation*: a vault that cannot be read must not
 * stop the rest, and must not be reported as a vault with nothing to do.
 */

import { describe, expect, it } from 'vitest';
import { ok, fail, type Reading } from '@projectx-social/sdk';
import { tick, MAX_VAULTS_PER_TICK, type EnginePorts } from '../src/engine.js';
import { MIN_STAKE_MIST } from '../src/domain/harvest.js';
import type { StakeVaultState } from '../src/adapters/vault.js';

function vaultState(overrides: Partial<StakeVaultState> = {}): StakeVaultState {
  return {
    vaultId: '0x1',
    version: 1n,
    accRebatePerUnit: 0n,
    tranches: [],
    liquidMist: 0n,
    totalPrincipalMist: 0n,
    creator: '0xc',
    validator: '0xv',
    accepting: true,
    creatorYieldMist: 0n,
    platformYieldMist: 0n,
    rebatePoolMist: 0n,
    lifetimeYieldMist: 0n,
    harvests: 0n,
    // Present on the chain shape but irrelevant to the harvest decision, which is why the engine
    // takes the narrower `VaultSnapshot`: it cannot read a field it was never handed.
    feeBpsSnapshot: 290n,
    rebateBps: 0n,
    positionsTableId: '0xp',
    ...overrides,
  };
}

function ports(options: {
  epoch?: Reading<bigint>;
  vaults?: Record<string, Reading<StakeVaultState>>;
  submit?: (id: string) => Reading<string>;
  onSubmit?: (id: string) => void;
}): EnginePorts {
  return {
    readEpoch: async () => options.epoch ?? ok(1000n),
    readVault: async (id) =>
      options.vaults?.[id] ?? ok(vaultState({ vaultId: id })),
    simulateAndHarvest: async (id) => {
      options.onSubmit?.(id);
      return options.submit?.(id) ?? ok(`digest-${id}`);
    },
  };
}

describe('tick', () => {
  it('harvests a vault with idle principal', async () => {
    const submitted: string[] = [];
    const result = await tick(
      ports({
        vaults: {
          '0xa': ok(
            vaultState({
              vaultId: '0xa',
              liquidMist: MIN_STAKE_MIST,
              totalPrincipalMist: MIN_STAKE_MIST,
            }),
          ),
        },
        onSubmit: (id) => submitted.push(id),
      }),
      ['0xa'],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.harvested).toHaveLength(1);
    expect(result.value.harvested[0]!.digest).toBe('digest-0xa');
    expect(submitted).toEqual(['0xa']);
  });

  it('submits nothing for a vault with nothing to do', async () => {
    // The money-saving case. A harvest here would SUCCEED and change nothing.
    const submitted: string[] = [];
    const result = await tick(ports({ onSubmit: (id) => submitted.push(id) }), ['0xa']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toHaveLength(1);
    expect(result.value.skipped[0]!.decision.reason).toBe('empty-vault');
    expect(submitted).toEqual([]);
  });

  it('keeps going when one vault cannot be read', async () => {
    const result = await tick(
      ports({
        vaults: {
          '0xbad': fail('transport', 'StakeVault 0xbad', 'connection refused'),
          '0xgood': ok(
            vaultState({
              vaultId: '0xgood',
              liquidMist: MIN_STAKE_MIST,
              totalPrincipalMist: MIN_STAKE_MIST,
            }),
          ),
        },
      }),
      ['0xbad', '0xgood'],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed).toHaveLength(1);
    expect(result.value.harvested).toHaveLength(1);
  });

  it('records an unreadable vault as unreadable, not as empty', async () => {
    /*
      It used to record `empty-vault` — which `domain/harvest.ts` defines as "the vault holds no
      principal at all", a measured fact about a vault nobody measured.

      The two point opposite ways. An empty vault is the steady state and needs nobody; an
      unreadable one means the daemon is not seeing part of the estate. Anyone counting reasons to
      find out how much was being missed read those failures as vaults that were fine.
    */
    const result = await tick(
      ports({ vaults: { '0xbad': fail('transport', 'StakeVault 0xbad', 'connection refused') } }),
      ['0xbad'],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed[0]!.decision.reason).toBe('unreadable');
    expect(result.value.failed[0]!.decision.reason).not.toBe('empty-vault');
  });

  it('still carries the real error alongside the reason', async () => {
    // The reason says WHICH kind of nothing happened; the error says why. Replacing a fabricated
    // reason with an honest one must not cost the detail that was already correct.
    const result = await tick(
      ports({ vaults: { '0xbad': fail('transport', 'StakeVault 0xbad', 'connection refused') } }),
      ['0xbad'],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.failed[0]!.error).toContain('connection refused');
    expect(result.value.failed[0]!.error).toContain('transport');
  });

  it('still calls a genuinely empty vault empty', async () => {
    /*
      The converse, and the reason this is two tests rather than one. A fix that renamed every
      no-action outcome to `unreadable` would pass the assertion above and destroy the distinction
      it was written to protect.
    */
    const result = await tick(ports({}), ['0xa']);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped[0]!.decision.reason).toBe('empty-vault');
  });

  it('reports an unreadable vault as failed, never as skipped', async () => {
    // The distinction the whole Reading<T> design exists for. A vault we could not read is not a
    // vault with nothing to do, and collapsing the two hides an outage as healthy quiet.
    const result = await tick(
      ports({ vaults: { '0xbad': fail('timeout', 'StakeVault 0xbad', 'deadline exceeded') } }),
      ['0xbad'],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.skipped).toHaveLength(0);
    expect(result.value.failed).toHaveLength(1);
    expect(result.value.failed[0]!.error).toContain('timeout');
  });

  it('records a submission failure without losing the decision', async () => {
    const result = await tick(
      ports({
        vaults: {
          '0xa': ok(
            vaultState({
              vaultId: '0xa',
              liquidMist: MIN_STAKE_MIST,
              totalPrincipalMist: MIN_STAKE_MIST,
            }),
          ),
        },
        submit: () => fail('transport', 'harvest', 'simulation failed'),
      }),
      ['0xa'],
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.harvested).toHaveLength(0);
    expect(result.value.failed).toHaveLength(1);
    // The decision is preserved, so the log says what we were trying to do and why.
    expect(result.value.failed[0]!.decision.act).toBe(true);
  });

  it('fails the whole tick when the epoch cannot be read', async () => {
    // Without the epoch no decision is possible. Guessing it would mean harvesting against a
    // ladder position we invented, which is worse than doing nothing.
    const result = await tick(
      ports({ epoch: fail('transport', 'current epoch', 'node unreachable') }),
      ['0xa'],
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.source).toBe('current epoch');
  });
});

describe('bounds', () => {
  it('stops at the ceiling and flags the result as partial', async () => {
    // "That is all of them" and "we ran out of budget" imply opposite next actions.
    const ids = Array.from({ length: MAX_VAULTS_PER_TICK + 5 }, (_, i) => `0x${i}`);
    const seen: string[] = [];
    const result = await tick(ports({ onSubmit: (id) => seen.push(id) }), ids);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.skipped).toHaveLength(MAX_VAULTS_PER_TICK);
  });

  it('does not flag a complete pass as partial', async () => {
    const result = await tick(ports({}), ['0xa', '0xb']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.truncated).toBe(false);
  });
});
