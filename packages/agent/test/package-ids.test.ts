// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The two package ids, checked at every site that uses one — not merely shown to be different.
 *
 * # The rule
 *
 * Sui does not resolve a package address to its newest version. After an upgrade there are two
 * addresses and each has exactly one correct use:
 *
 *   - `latestPackageId` (`0xfa7eb18b…3694`, version 3) — **every `moveCall` target, and nothing
 *     else.** A call at the original address runs the ORIGINAL bytecode, and it does not error in a
 *     way that names the cause: a module added after publication is simply absent, and a function
 *     whose behaviour changed quietly does the old thing.
 *   - `packageId` (`0xc5c83399…404d`, the original publication) — **struct type tags, event
 *     filters, and the Seal identity namespace.** A struct's type identity is bound to the address
 *     it was first published at and does not move on upgrade, so filtering owned objects by the
 *     latest id matches nothing at all.
 *
 * # Why this is a test and not a paragraph
 *
 * The estate has already paid for this once. `UPDATE.md`, 2026-08-30: the harvest daemon was
 * pinned to package v2 against a v3 deployment, so every harvest it built executed v2 bytecode.
 * Nothing was at risk only because that daemon holds no capability. **An agent that spends does.**
 *
 * "The two ids are distinct" proves nothing about which one reaches which call. So each assertion
 * below builds the real transaction or intercepts the real read, and inspects the address that
 * actually went out.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { describe, expect, it } from 'vitest';

import {
  MAINNET_RECORD,
  buildOpenAccount,
  buildSubscribe,
  buildTip,
  buildUnlock,
  findAgentAccount,
  loadAgentManifest,
} from '../src/index.js';

const ENV = {
  PROJECTX_SOCIAL_NETWORK: 'mainnet',
  PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
  PROJECTX_SOCIAL_PACKAGE_ID: MAINNET_RECORD.packageId,
  PROJECTX_SOCIAL_LATEST_PACKAGE_ID: MAINNET_RECORD.latestPackageId,
  PROJECTX_SOCIAL_PLATFORM_ID: MAINNET_RECORD.platformId,
  PROJECTX_SOCIAL_REGISTRY_ID: MAINNET_RECORD.registryId,
  PROJECTX_SOCIAL_AGENT_COIN_TYPE: MAINNET_RECORD.usdcType,
  PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social',
};

const loaded = loadAgentManifest(ENV);
if (!loaded.ok) throw new Error('the fixture environment must load');
const CONFIG = loaded.value.config;

const OBJ = (n: string) => `0x${n.repeat(64)}`;
const SENDER = OBJ('9');

/** Every `moveCall` package address in a built transaction, in command order. */
function moveCallPackages(tx: { getData: () => unknown }): string[] {
  const data = tx.getData() as {
    commands: Array<{ MoveCall?: { package: string; module: string; function: string } }>;
  };
  return data.commands
    .map((c) => c.MoveCall)
    .filter((c): c is { package: string; module: string; function: string } => c !== undefined)
    .map((c) => `${c.package}::${c.module}::${c.function}`);
}

describe('every moveCall target is the LATEST package', () => {
  const cases: Array<[string, () => { getData: () => unknown }]> = [
    ['buildOpenAccount', () => buildOpenAccount(CONFIG, { handle: 'atlas', referrer: null })],
    [
      'buildUnlock',
      () =>
        buildUnlock(CONFIG, {
          coinType: MAINNET_RECORD.usdcType,
          vaultId: OBJ('1'),
          accountId: OBJ('2'),
          contentKey: 'k',
          price: 10_000n,
          sender: SENDER,
        }),
    ],
    [
      'buildSubscribe',
      () =>
        buildSubscribe(CONFIG, {
          coinType: MAINNET_RECORD.usdcType,
          vaultId: OBJ('1'),
          accountId: OBJ('2'),
          tierIndex: 0,
          price: 1_000_000n,
          sender: SENDER,
        }),
    ],
    [
      'buildTip',
      () =>
        buildTip(CONFIG, {
          coinType: MAINNET_RECORD.usdcType,
          vaultId: OBJ('1'),
          accountId: OBJ('2'),
          amount: 5_000n,
        }),
    ],
  ];

  it.each(cases)('%s', (name, build) => {
    const targets = moveCallPackages(build());
    expect(targets.length, `${name} built no moveCall at all`).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target.startsWith(`${MAINNET_RECORD.latestPackageId}::`), target).toBe(true);
      // Stated the other way round as well, because "starts with the latest id" would also be
      // satisfied if the two ids ever shared a prefix.
      expect(target.startsWith(`${MAINNET_RECORD.packageId}::`), target).toBe(false);
    }
  });

  it('names the functions being called, so a rename is visible in the diff', () => {
    const L = MAINNET_RECORD.latestPackageId;
    expect(moveCallPackages(buildOpenAccount(CONFIG, { handle: 'a', referrer: null }))).toContain(
      `${L}::account::open`,
    );
    expect(
      moveCallPackages(
        buildUnlock(CONFIG, {
          coinType: MAINNET_RECORD.usdcType,
          vaultId: OBJ('1'),
          accountId: OBJ('2'),
          contentKey: 'k',
          price: 1n,
          sender: SENDER,
        }),
      ),
    ).toContain(`${L}::creator::unlock`);
  });
});

describe('every struct type tag is the ORIGINAL package', () => {
  it('findAgentAccount filters owned objects on the original id', async () => {
    /*
      The opposite choice from a moveCall target, and it is not a preference. A `SocialAccount`
      minted before the upgrade and one minted after both carry the ORIGINAL address in their type
      tag, because a struct's identity is bound to where the package was first published. Filtering
      on the latest id matches nothing — and `ok(null)` from this function means "we looked and
      there is none", which is the prompt to open an account. So the wrong id here does not error;
      it tells a funded agent it has no account and sends it to open a second one.
    */
    let asked: string | undefined;
    const client = {
      listOwnedObjects: async (args: { type: string }) => {
        asked = args.type;
        return { objects: [] };
      },
    } as unknown as SuiGrpcClient;

    await findAgentAccount(client, CONFIG, SENDER);
    expect(asked).toBe(`${MAINNET_RECORD.packageId}::account::SocialAccount`);
    expect(asked).not.toContain(MAINNET_RECORD.latestPackageId);
  });
});

describe('the ids themselves', () => {
  it('are two different addresses', () => {
    expect(MAINNET_RECORD.packageId).not.toBe(MAINNET_RECORD.latestPackageId);
  });

  it('are carried separately through the loader, not collapsed', () => {
    expect(CONFIG.packageId).toBe(MAINNET_RECORD.packageId);
    expect(CONFIG.latestPackageId).toBe(MAINNET_RECORD.latestPackageId);
  });

  it('match the recorded mainnet deployment', () => {
    // Pinned so an accidental edit to MAINNET_RECORD is a failing test rather than a silent
    // re-pointing of every agent that loads it.
    expect(MAINNET_RECORD.packageId).toBe(
      '0xc5c833991ed1123d70b1001c0bcdb01ec5728b09f25dfc42a0edaf16005d404d',
    );
    expect(MAINNET_RECORD.latestPackageId).toBe(
      '0xfa7eb18bbb29b047ec86434e8a8f4cfba35615bde9680eebd781a187ca3a3694',
    );
  });
});
