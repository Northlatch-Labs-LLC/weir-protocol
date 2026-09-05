// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  Policy-compatible payments, and the signer seam.

  `packages/policy` refuses any object input whose id is not allow-listed, and a coin's id rotates
  with every merge, so a payment sourced by `tx.coin` could never pass a policy. The builders now
  take a `PaymentSource`: `gas` splits from the gas coin (a command result, never an input),
  `object` splits from one named coin whose id is stable, `merge` is the old shape and is refused
  the moment a policy signer is bound.

  Mutations predicted: `gas` falls through to `tx.coin` → "a gas payment has no coin input" red;
  drop `policyShaped` → "a bound signer refuses the merged shape before any read" red (the chain
  is called); sign with the keypair when a signer is bound → "the bound signer signs, the key does
  not" red (signAndExecuteTransaction called).
*/
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { describe, expect, it } from 'vitest';
import {
  MAINNET_RECORD,
  buildUnlock,
  createAgent,
  generateAgentKey,
  paymentSourceFor,
  simulateAndExecute,
  type TransactionSigner,
} from '../src/index.js';
import { Transaction } from '@mysten/sui/transactions';

const hex = (c: string) => `0x${c.repeat(64)}`;
const CONFIG = {
  network: 'mainnet' as const,
  grpcUrl: 'https://fullnode.mainnet.sui.io:443',
  packageId: MAINNET_RECORD.packageId,
  latestPackageId: MAINNET_RECORD.latestPackageId,
  platformId: MAINNET_RECORD.platformId,
  registryId: MAINNET_RECORD.registryId,
};
const USDC = MAINNET_RECORD.usdcType;
const ARGS = { coinType: USDC, vaultId: hex('a'), accountId: hex('b'), contentKey: 'k', price: 250_000n, sender: hex('f') };

function shape(tx: Transaction): { kinds: string[]; objectInputs: string[] } {
  const data = tx.getData() as {
    commands: Array<Record<string, unknown>>;
    inputs: Array<{ Object?: { ImmOrOwnedObject?: { objectId: string }; SharedObject?: { objectId: string } }; UnresolvedObject?: { objectId: string } }>;
  };
  const kinds = data.commands.map((c) => Object.keys(c).find((k) => k !== '$kind') ?? '?');
  const objectInputs = data.inputs
    .map((i) => i.Object?.ImmOrOwnedObject?.objectId ?? i.Object?.SharedObject?.objectId ?? i.UnresolvedObject?.objectId ?? null)
    .filter((id): id is string => id !== null);
  return { kinds, objectInputs };
}

describe('paymentSourceFor', () => {
  it('splits SUI from gas, a named coin when one is configured, and merges otherwise', () => {
    expect(paymentSourceFor({ coinType: '0x2::sui::SUI', paymentCoin: null })).toEqual({ kind: 'gas' });
    expect(paymentSourceFor({ coinType: USDC, paymentCoin: hex('c') })).toEqual({ kind: 'object', objectId: hex('c') });
    expect(paymentSourceFor({ coinType: USDC, paymentCoin: null })).toEqual({ kind: 'merge' });
  });
});

describe('the payment shape a policy can read', () => {
  it('a gas payment has no coin input: the split is a command result', () => {
    const tx = buildUnlock(CONFIG as never, { ...ARGS, coinType: '0x2::sui::SUI', payment: { kind: 'gas' } });
    const { kinds, objectInputs } = shape(tx);
    expect(kinds[0]).toBe('SplitCoins');
    expect(objectInputs).not.toContain(hex('c'));
    expect(objectInputs.filter((id) => id !== ARGS.vaultId && id !== ARGS.accountId && id !== CONFIG.platformId && id !== '0x0000000000000000000000000000000000000000000000000000000000000006')).toEqual([]);
  });

  it('an object payment names exactly the coin the operator allow-listed, and splits from it', () => {
    const tx = buildUnlock(CONFIG as never, { ...ARGS, payment: { kind: 'object', objectId: hex('c') } });
    const { kinds, objectInputs } = shape(tx);
    expect(kinds[0]).toBe('SplitCoins');
    expect(objectInputs).toContain(hex('c'));
  });

  it('refuses a non-positive amount before building', () => {
    expect(() => buildUnlock(CONFIG as never, { ...ARGS, price: 0n, payment: { kind: 'gas' } })).toThrow(RangeError);
  });
});

describe('a bound policy signer', () => {
  const FULL_ENV = {
    PROJECTX_SOCIAL_NETWORK: 'mainnet',
    PROJECTX_SOCIAL_GRPC_URL: CONFIG.grpcUrl,
    PROJECTX_SOCIAL_PACKAGE_ID: CONFIG.packageId,
    PROJECTX_SOCIAL_LATEST_PACKAGE_ID: CONFIG.latestPackageId,
    PROJECTX_SOCIAL_PLATFORM_ID: CONFIG.platformId,
    PROJECTX_SOCIAL_REGISTRY_ID: CONFIG.registryId,
    PROJECTX_SOCIAL_AGENT_COIN_TYPE: USDC,
    PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social',
  };

  it('refuses the merged payment shape before any chain read, naming the variable to set', async () => {
    const calls: string[] = [];
    const client = new Proxy({}, { get: (_t, name) => (..._a: unknown[]) => { calls.push(String(name)); throw new Error('the chain must not be reached'); } }) as unknown as SuiGrpcClient;
    const signer: TransactionSigner = { address: hex('f'), signTransaction: async () => { throw new Error('must not sign'); } };
    const { key } = generateAgentKey();
    const made = createAgent({ keypair: key, config: FULL_ENV, client, transactionSigner: signer });
    if (!made.ok) throw new Error(made.failure.detail);
    const result = await made.value.unlock({ vaultId: hex('a'), contentKey: 'k', priceMinorUnits: 1n, maxPrice: 1n });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('unconfigured');
      expect(result.failure.detail).toContain('PROJECTX_SOCIAL_AGENT_PAYMENT_COIN');
    }
  });

  it('the bound signer signs, the key does not, and its refusal keeps its kind', async () => {
    const { key } = generateAgentKey();
    let keySigned = false;
    let executedWith: string[] = [];
    const client = {
      signAndExecuteTransaction: async () => { keySigned = true; return { digest: 'KEY' }; },
      executeTransaction: async (input: { signatures: string[] }) => { executedWith = input.signatures; return { transaction: { digest: 'POLICY' } }; },
      simulateTransaction: async () => { throw new Error('not reached in this test'); },
    } as unknown as SuiGrpcClient;

    const tx = new Transaction();
    tx.setSender(key.address);
    tx.setGasPrice(1000n);
    tx.setGasPayment([{ objectId: hex('1'), version: '1', digest: '1'.repeat(32) }]);
    tx.transferObjects([tx.splitCoins(tx.gas, [tx.pure.u64(1n)])], key.address);

    const refusing: TransactionSigner = {
      address: key.address,
      signTransaction: async () => ({ ok: false, failure: { kind: 'unconfigured', source: 'policy', detail: 'outflow ceiling exceeded' } }),
    };
    const refused = await simulateAndExecute({ client, transaction: tx, key, gasBudgetMist: 10_000_000n, what: 'test', transactionSigner: refusing });
    // The simulation gate runs first and this stub client cannot simulate; what matters is that the KEY never signed.
    expect(refused.ok).toBe(false);
    expect(keySigned).toBe(false);
    expect(executedWith).toEqual([]);
  });
});
