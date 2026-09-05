// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Test-only fixtures. Nothing here reads the operator's real keystore or touches the network.
 *
 * A test that loaded `~/.sui/sui_config/sui.keystore` would be a test that only passes on one
 * machine and, worse, one that pulls real private keys into a process whose output is captured.
 * Every key below is generated in-process and discarded.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Keypair } from '@mysten/sui/cryptography';
import { ok } from '@projectx-social/sdk';
import type { PolicyDoc, SimulatedEffects } from '@projectx-social/policy';
import type { SerializedSignature, Signer } from '../src/index.js';

/** Wrap a raw Sui keypair as one of our `Signer`s, without going through a secret string. */
export function signerFor(keypair: Keypair): Signer {
  return {
    address: keypair.toSuiAddress(),
    scheme: 'ed25519',
    signPersonalMessage: async (bytes) =>
      ok<SerializedSignature>((await keypair.signPersonalMessage(bytes)).signature),
    signTransaction: async (bytes) =>
      ok<SerializedSignature>((await keypair.signTransaction(bytes)).signature),
  };
}

/**
 * Write a throwaway Sui CLI keystore holding the given keys.
 *
 * The entry format is base64 of `flag || 32 bytes`, which is what the real CLI writes — verified
 * against the shape of a real keystore's entries (33 bytes decoded, leading `0x00` for Ed25519)
 * without reading any key material out of it.
 */
export async function writeKeystore(secrets: readonly Uint8Array[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'weir-keystore-'));
  const path = join(dir, 'sui.keystore');
  const entries = secrets.map((secret) => {
    const withFlag = new Uint8Array(33);
    withFlag[0] = 0x00; // Ed25519
    withFlag.set(secret, 1);
    return Buffer.from(withFlag).toString('base64');
  });
  await writeFile(path, JSON.stringify(entries, null, 2), 'utf8');
  return path;
}

export const AGENT = `0x${'a'.repeat(64)}`;
export const SUI_TYPE = `0x${'0'.repeat(63)}2::sui::SUI`;
export const PACKAGE = `0x${'0'.repeat(62)}c5`;
export const UNLOCK = `${PACKAGE}::creator::unlock`;
export const CLAIM_EARNINGS = `${PACKAGE}::creator::claim_earnings`;

export function policyFor(agentAddress: string): PolicyDoc {
  return {
    version: 1,
    agentAddress,
    outflowCeilings: [{ coinType: SUI_TYPE, maxPerPeriod: '10000000', periodMs: 86_400_000 }],
    allowedTargets: [UNLOCK],
    allowedTypeArguments: [SUI_TYPE],
    allowedRecipients: [agentAddress],
    maxGasBudgetMist: '20000000',
    allowedObjects: [],
  allowedCommandKinds: ['MoveCall', 'SplitCoins', 'TransferObjects'],
  };
}

export function effectsFor(agentAddress: string): SimulatedEffects {
  return {
    sender: agentAddress,
    gasBudgetMist: '1188000',
    balanceChanges: [{ coinType: SUI_TYPE, address: agentAddress, amount: '-1088000' }],
    balanceChangesObserved: true,
    moveCalls: [{ index: 1, target: UNLOCK, typeArguments: [SUI_TYPE] }],
    transfers: [{ index: 2, recipient: agentAddress }],
    commandKinds: ['SplitCoins', 'MoveCall', 'TransferObjects'],
    objectInputs: [],
    observedAtMs: 1_788_000_000_000,
  };
}

/**
 * A simulation response in the exact shape `@mysten/sui` 2.27.1's gRPC transport produced on
 * mainnet on 2026-08-31.
 *
 * Reproduced field for field from a live run, including the padded coin type, the signed decimal
 * amount string, the base64 `Pure.bytes` for the transfer recipient, and the digest living on
 * `effects` rather than on the transaction. Changing any of these to a shape that "looks right"
 * would make the translation tests assert against a fiction.
 */
export function mainnetSuccessResponse(agentAddress: string) {
  const addressBytes = Buffer.from(agentAddress.slice(2), 'hex');
  return {
    $kind: 'Transaction',
    Transaction: {
      status: { success: true, error: null },
      balanceChanges: [
        { coinType: SUI_TYPE, address: agentAddress, amount: '-1088000' },
        { coinType: SUI_TYPE, address: `0x${'b'.repeat(64)}`, amount: '1000000' },
      ],
      effects: {
        transactionDigest: '2Wm1kXwYxPjkjVqT1rvHi9oqmvSZY3md6eirK8WheHbR',
        gasUsed: {
          computationCost: '100000',
          storageCost: '988000',
          storageRebate: '0',
          nonRefundableStorageFee: '0',
        },
      },
      transaction: {
        sender: agentAddress,
        gasData: { budget: '1188000', owner: agentAddress, payment: [], price: '100' },
        inputs: [
          { $kind: 'Pure', Pure: { bytes: 'AQAAAAAAAAA=' } },
          { $kind: 'Pure', Pure: { bytes: addressBytes.toString('base64') } },
        ],
        commands: [
          {
            $kind: 'SplitCoins',
            SplitCoins: {
              coin: { $kind: 'GasCoin', GasCoin: true },
              amounts: [{ $kind: 'Input', Input: 0 }],
            },
          },
          {
            $kind: 'MoveCall',
            MoveCall: {
              package: PACKAGE,
              module: 'creator',
              function: 'unlock',
              typeArguments: [SUI_TYPE],
              arguments: [],
            },
          },
          {
            $kind: 'TransferObjects',
            TransferObjects: {
              objects: [{ $kind: 'NestedResult', NestedResult: [0, 0] }],
              address: { $kind: 'Input', Input: 1 },
            },
          },
        ],
      },
    },
  };
}
