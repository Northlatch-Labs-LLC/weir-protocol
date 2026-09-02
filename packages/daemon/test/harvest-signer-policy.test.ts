// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  The harvest key signs only through the policy, and every decision lands in one chain.

  Mutations predicted: drop `allowedObjects` from harvestPolicy → "a harvest of the named vault is
  signed" red (the vault input is refused); widen `allowedTargets` → "a transaction to another
  function is refused" red; give each call its own AuditLog → "one chain across vaults" red;
  execute before the gate → "nothing is executed when the gate refuses" red.
*/
import { describe, expect, it } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { ok, type Reading } from '@projectx-social/sdk';
import { GENESIS_HASH, readSimulation, type SerializedSignature, type Signer, type SimulationPort } from '@projectx-social/signer';
import { harvestPolicy, harvestSignerOver } from '../src/adapters/signer.js';

const KEY = Ed25519Keypair.generate();
const ADDRESS = KEY.toSuiAddress();
const PACKAGE = `0x${'0'.repeat(62)}c5`;
const VAULT = `0x${'ee'.repeat(32)}`;
const OTHER_VAULT = `0x${'dd'.repeat(32)}`;
const SYSTEM = `0x${'0'.repeat(63)}5`;
const SUI_TYPE = `0x${'0'.repeat(63)}2::sui::SUI`;
const BUDGET = 50_000_000n;
const DIGEST = '2Wm1kXwYxPjkjVqT1rvHi9oqmvSZY3md6eirK8WheHbR';

function signerFor(keypair: Ed25519Keypair): Signer {
  return {
    address: keypair.toSuiAddress(),
    scheme: 'ed25519',
    signPersonalMessage: async (bytes) => ok<SerializedSignature>((await keypair.signPersonalMessage(bytes)).signature),
    signTransaction: async (bytes) => ok<SerializedSignature>((await keypair.signTransaction(bytes)).signature),
  };
}

/** A mainnet-shaped successful simulation of `harvest(vault, system)` with gas as the only outflow. */
function harvestResponse(input: { vault: string; fn?: string; gasMist?: string }) {
  const gas = input.gasMist ?? '1088000';
  return {
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      balanceChanges: [{ coinType: SUI_TYPE, address: ADDRESS, amount: `-${gas}` }],
      effects: {
        transactionDigest: DIGEST,
        gasUsed: { computationCost: '100000', storageCost: '988000', storageRebate: '0', nonRefundableStorageFee: '0' },
      },
      transaction: {
        sender: ADDRESS,
        gasData: { budget: BUDGET.toString(), owner: ADDRESS, payment: [], price: '1000' },
        inputs: [
          { $kind: 'Object', Object: { $kind: 'SharedObject', SharedObject: { objectId: input.vault, initialSharedVersion: '1', mutable: true } } },
          { $kind: 'Object', Object: { $kind: 'SharedObject', SharedObject: { objectId: SYSTEM, initialSharedVersion: '1', mutable: true } } },
        ],
        commands: [
          {
            $kind: 'MoveCall',
            MoveCall: {
              package: PACKAGE,
              module: 'stake_vault',
              function: input.fn ?? 'harvest',
              typeArguments: [],
              arguments: [{ $kind: 'Input', Input: 0 }, { $kind: 'Input', Input: 1 }],
            },
          },
        ],
      },
    },
  };
}

/**
 * The harvest transaction with every reference already resolved, so `build` touches no network:
 * shared-object references with their initial versions, the gas price and the gas payment. The
 * real adapter leaves these to be resolved against the chain; the policy judges the same bytes
 * either way.
 */
function resolvedHarvest(vaultId: string): Transaction {
  const tx = new Transaction();
  tx.setGasPrice(1000n);
  tx.setGasPayment([{ objectId: `0x${'7'.repeat(64)}`, version: '1', digest: '11111111111111111111111111111111' }]);
  tx.moveCall({
    target: `${PACKAGE}::stake_vault::harvest`,
    arguments: [
      tx.sharedObjectRef({ objectId: vaultId, initialSharedVersion: '1', mutable: true }),
      tx.sharedObjectRef({ objectId: SYSTEM, initialSharedVersion: '1', mutable: true }),
    ],
  });
  return tx;
}

function world(response: unknown) {
  const executed: unknown[] = [];
  const client = {
    simulateTransaction: async () => response,
    executeTransaction: async (args: unknown) => {
      executed.push(args);
      return { $kind: 'Transaction', Transaction: { digest: DIGEST } };
    },
  } as unknown as SuiGrpcClient;
  const simulation: SimulationPort = {
    observe: async ({ transactionBytes, sender }) => {
      expect(transactionBytes.byteLength).toBeGreaterThan(0);
      return readSimulation(response, sender) as Reading<Awaited<ReturnType<SimulationPort['observe']>> extends Reading<infer T> ? T : never>;
    },
  };
  return { client, simulation, executed };
}

describe('harvestPolicy', () => {
  it('names exactly one target, the two objects a harvest touches, and the gas budget as the only outflow', () => {
    const policy = harvestPolicy({ address: ADDRESS, latestPackageId: PACKAGE, vaultId: VAULT, gasBudgetMist: BUDGET });
    expect(policy.allowedTargets).toEqual([`${PACKAGE}::stake_vault::harvest`]);
    expect(policy.allowedObjects).toEqual([VAULT, '0x5']);
    expect(policy.allowedCommandKinds).toEqual(['MoveCall']);
    expect(policy.allowedRecipients).toEqual([]);
    expect(policy.maxGasBudgetMist).toBe(BUDGET.toString());
    expect(policy.outflowCeilings).toEqual([{ coinType: '0x2::sui::SUI', maxPerPeriod: BUDGET.toString(), periodMs: 60_000 }]);
  });
});

describe('the harvest signer behind the policy', () => {
  it('a harvest of the named vault is signed, executed, and recorded as one allow', async () => {
    const { client, simulation, executed } = world(harvestResponse({ vault: VAULT }));
    const signer = harvestSignerOver(signerFor(KEY), client, BUDGET, PACKAGE, { simulation, transaction: resolvedHarvest });
    expect(signer.auditHead()).toEqual({ headHash: GENESIS_HASH, entries: 0, intact: true });

    const r = await signer.simulateAndHarvest(VAULT);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value).toBe(DIGEST);
    expect(executed).toHaveLength(1);
    const head = signer.auditHead();
    expect(head.entries).toBe(1);
    expect(head.headHash).not.toBe(GENESIS_HASH);
    expect(head.intact).toBe(true);
  });

  it('a transaction to another function is refused, nothing is executed, and the refusal is on the chain', async () => {
    const { client, simulation, executed } = world(harvestResponse({ vault: VAULT, fn: 'withdraw' }));
    const signer = harvestSignerOver(signerFor(KEY), client, BUDGET, PACKAGE, { simulation, transaction: resolvedHarvest });
    const r = await signer.simulateAndHarvest(VAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toMatch(/withdraw|allowedTargets/);
    expect(executed).toHaveLength(0);
    expect(signer.auditHead().entries).toBe(1);
  });

  it('a harvest whose simulation touches a vault other than the one asked for is refused', async () => {
    // The policy is built for VAULT; the chain answered with OTHER_VAULT as the object input.
    const { client, simulation, executed } = world(harvestResponse({ vault: OTHER_VAULT }));
    const signer = harvestSignerOver(signerFor(KEY), client, BUDGET, PACKAGE, { simulation, transaction: resolvedHarvest });
    const r = await signer.simulateAndHarvest(VAULT);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toMatch(/allowedObjects/);
    expect(executed).toHaveLength(0);
  });

  it('gas above the budget is refused before anything is signed', async () => {
    const { client, simulation, executed } = world(harvestResponse({ vault: VAULT, gasMist: (BUDGET + 1n).toString() }));
    const signer = harvestSignerOver(signerFor(KEY), client, BUDGET, PACKAGE, { simulation, transaction: resolvedHarvest });
    const r = await signer.simulateAndHarvest(VAULT);
    expect(r.ok).toBe(false);
    expect(executed).toHaveLength(0);
  });

  it('one chain across vaults: three decisions, one head, verifying end to end', async () => {
    const { client, simulation } = world(harvestResponse({ vault: VAULT }));
    const signer = harvestSignerOver(signerFor(KEY), client, BUDGET, PACKAGE, { simulation, transaction: resolvedHarvest });
    await signer.simulateAndHarvest(VAULT);
    await signer.simulateAndHarvest(OTHER_VAULT); // refused: the simulation names VAULT, the policy names OTHER_VAULT
    await signer.simulateAndHarvest(VAULT);
    const head = signer.auditHead();
    expect(head.entries).toBe(3);
    expect(head.intact).toBe(true);
  });
});
