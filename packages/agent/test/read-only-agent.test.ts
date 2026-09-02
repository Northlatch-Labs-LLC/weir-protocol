// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The read-only construction path: an agent with no key, and nothing on it that needs one.
 *
 * # The defect
 *
 * `packages/mcp/src/transport.ts` `openWeir` passes `keypair: null` under `--http`, by design: a
 * hosted server holds no key. `createAgent` required one and read `key.address` at construction,
 * so the keyless deployment died with `TypeError: Cannot read properties of null (reading
 * 'address')` — reproduced at `src/index.ts:384` before this suite was written — before it could
 * serve a single read.
 *
 * # What is asserted, and how it would go red
 *
 * The surface is asserted by `Object.keys`, not by calling each spending method and expecting a
 * refusal. The MCP's `capabilitiesOf` registers a tool for every member that is a function, so a
 * spending method that was present-and-throwing would be registered as a tool that always fails.
 * Presence is the defect; only an assertion on presence catches it.
 *
 * The read methods run against a fake gRPC client built here. The vault bytes are encoded with the
 * same BCS layout `packages/sdk/src/creator.ts` decodes with, restated field for field; if that
 * layout moves, `decodeCreatorVault` misreads these bytes and the owner and price assertions below
 * fail. That is the pin.
 *
 * Nothing here touches a network.
 */

import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { describe, expect, it } from 'vitest';

import {
  MAINNET_RECORD,
  canSign,
  classificationOf,
  createAgent,
  generateAgentKey,
  preconditionOf,
  type Agent,
  type ReadOnlyAgent,
} from '../src/index.js';

const FULL_ENV = {
  PROJECTX_SOCIAL_NETWORK: 'mainnet',
  PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
  PROJECTX_SOCIAL_PACKAGE_ID: MAINNET_RECORD.packageId,
  PROJECTX_SOCIAL_LATEST_PACKAGE_ID: MAINNET_RECORD.latestPackageId,
  PROJECTX_SOCIAL_PLATFORM_ID: MAINNET_RECORD.platformId,
  PROJECTX_SOCIAL_REGISTRY_ID: MAINNET_RECORD.registryId,
  PROJECTX_SOCIAL_AGENT_COIN_TYPE: MAINNET_RECORD.usdcType,
  PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social/',
};

/**
 * Every member of `Agent` that is not on `ReadOnlyAgent`.
 *
 * Asserted in BOTH directions below — absent on the keyless agent, present on the keyed one — so
 * a renamed spending method cannot leave this list checking for a name nothing has.
 */
const NEEDS_A_KEY = [
  'address',
  'sign',
  'session',
  'openAccount',
  'unlock',
  'subscribe',
  'tip',
  'post',
  'send',
  'balance',
] as const;

/** The read set, in full. A new member here is a decision, not a drift. */
const READ_SET = ['balanceOf', 'client', 'feed', 'manifest', 'quote', 'readPreview', 'seal'] as const;

// === A vault and a price, as bytes ===

const OWNER = `0x${'a'.repeat(64)}`;
const VAULT = `0x${'b'.repeat(64)}`;
const TABLE = `0x${'c'.repeat(64)}`;
const KEY = 'chapter-1';
const PRICE = 100_000n;

const TierBcs = bcs.struct('Tier', {
  name: bcs.string(),
  price: bcs.u64(),
  periodMs: bcs.u64(),
  active: bcs.bool(),
});

/** `packages/sdk/src/creator.ts` `CreatorVaultBcs`, restated. See the header for why that is safe. */
const CreatorVaultBcs = bcs.struct('CreatorVault', {
  id: bcs.Address,
  version: bcs.u64(),
  platform: bcs.Address,
  owner: bcs.Address,
  account: bcs.Address,
  feeBpsSnapshot: bcs.u64(),
  referralShareBpsSnapshot: bcs.u64(),
  tiers: bcs.vector(TierBcs),
  contentPrices: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
  minTip: bcs.u64(),
  accepting: bcs.bool(),
  earnings: bcs.u64(),
  platformFees: bcs.u64(),
  grossVolume: bcs.u64(),
  subscriptionsSold: bcs.u64(),
  unlocksSold: bcs.u64(),
  tipsReceived: bcs.u64(),
});

const ContentPriceFieldBcs = bcs.struct('Field', {
  id: bcs.Address,
  name: bcs.vector(bcs.u8()),
  value: bcs.u64(),
});

function vaultBytes(accepting: boolean): Uint8Array {
  return CreatorVaultBcs.serialize({
    id: VAULT,
    version: 1n,
    platform: MAINNET_RECORD.platformId,
    owner: OWNER,
    account: `0x${'d'.repeat(64)}`,
    feeBpsSnapshot: 290n,
    referralShareBpsSnapshot: 0n,
    tiers: [{ name: 'monthly', price: 500_000n, periodMs: 2_592_000_000n, active: true }],
    contentPrices: { id: TABLE, size: 1n },
    minTip: 10_000n,
    accepting,
    earnings: 0n,
    platformFees: 0n,
    grossVolume: 0n,
    subscriptionsSold: 0n,
    unlocksSold: 0n,
    tipsReceived: 0n,
  }).toBytes();
}

const PRICE_FIELD_ID = deriveDynamicFieldID(
  TABLE,
  'vector<u8>',
  bcs.vector(bcs.u8()).serialize(new TextEncoder().encode(KEY)).toBytes(),
);

interface Seen {
  objects: string[];
  balances: Array<{ owner: string; coinType: string }>;
}

/** A node holding one vault and one priced key, recording what it was asked. */
function fakeClient(options: { accepting: boolean; balance: string }): { client: SuiGrpcClient; seen: Seen } {
  const seen: Seen = { objects: [], balances: [] };
  const objects = new Map<string, Uint8Array>([
    [VAULT, vaultBytes(options.accepting)],
    [
      PRICE_FIELD_ID,
      ContentPriceFieldBcs.serialize({
        id: PRICE_FIELD_ID,
        name: Array.from(new TextEncoder().encode(KEY)),
        value: PRICE,
      }).toBytes(),
    ],
  ]);
  const fake = {
    getObject: async (input: { objectId: string }) => {
      seen.objects.push(input.objectId);
      const content = objects.get(input.objectId);
      if (content === undefined) throw new Error(`no object ${input.objectId}`);
      return { object: { content } };
    },
    getBalance: async (input: { owner: string; coinType: string }) => {
      seen.balances.push(input);
      return { balance: { balance: options.balance } };
    },
  };
  return { client: fake as unknown as SuiGrpcClient, seen };
}

function readOnly(client?: SuiGrpcClient): ReadOnlyAgent {
  const made = createAgent({ keypair: null, config: FULL_ENV, ...(client === undefined ? {} : { client }) });
  if (!made.ok) throw new Error(made.failure.detail);
  return made.value;
}

// === (c) The failure that shipped cannot recur ===

describe('constructing without a key', () => {
  it("does not throw — the failure was `reading 'address'` on a null keypair", () => {
    expect(() => createAgent({ keypair: null, config: FULL_ENV })).not.toThrow();
  });

  it('succeeds', () => {
    expect(createAgent({ keypair: null, config: FULL_ENV }).ok).toBe(true);
  });

  it('refuses an undefined keypair with a Reading, never a throw', () => {
    // Not expressible through the types; a JavaScript caller reaches it in one keystroke, and it
    // is the same `key.address` line by another spelling.
    const made = createAgent({ keypair: undefined, config: FULL_ENV } as never);
    expect(made.ok).toBe(false);
    if (!made.ok) {
      expect(made.failure.kind).toBe('unconfigured');
      expect(made.failure.detail).toContain('null');
    }
  });

  it('still REFUSES an unconfigured environment rather than defaulting to mainnet', () => {
    expect(createAgent({ keypair: null, config: {} }).ok).toBe(false);
  });

  it('lets baseUrl override the manifest, normalised, as the keyed path does', () => {
    const made = createAgent({ keypair: null, config: FULL_ENV, baseUrl: 'https://staging.weir.social/' });
    expect(made.ok && made.value.manifest.baseUrl).toBe('https://staging.weir.social');
  });
});

// === (a) The surface, by presence ===

describe('the read-only surface', () => {
  const agent = readOnly();

  it('is exactly the read set, nothing more', () => {
    expect(Object.keys(agent).sort()).toEqual([...READ_SET]);
  });

  it('has no member that signs or spends — absent, not present-and-throwing', () => {
    for (const name of NEEDS_A_KEY) {
      expect(name in agent, `${name} is present on a read-only agent`).toBe(false);
      expect((agent as unknown as Record<string, unknown>)[name]).toBeUndefined();
    }
  });

  it('the keyed agent has every one of those, so the list above cannot go stale', () => {
    const made = createAgent({ keypair: generateAgentKey().key, config: FULL_ENV });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    for (const name of NEEDS_A_KEY) {
      expect(name in made.value, `${name} is missing from the keyed agent`).toBe(true);
    }
    // And the keyed agent carries the read set too: one builder, two surfaces.
    for (const name of READ_SET) {
      expect(name in made.value, `${name} is missing from the keyed agent`).toBe(true);
    }
  });

  it('canSign() reads presence, and answers for both', () => {
    expect(canSign(agent)).toBe(false);
    const made = createAgent({ keypair: generateAgentKey().key, config: FULL_ENV });
    expect(made.ok && canSign(made.value)).toBe(true);
  });

  it('holds no Seal implementation unless one is supplied', () => {
    expect(agent.seal).toBeNull();
  });
});

// === (b) Each read method, against the fake node ===

describe('quote() without a key', () => {
  it('prices a content key from the vault and the price entry', async () => {
    const { client, seen } = fakeClient({ accepting: true, balance: '0' });
    const quote = await readOnly(client).quote({ vaultId: VAULT, contentKey: KEY });
    expect(quote.ok).toBe(true);
    if (quote.ok) {
      expect(quote.value.priceMinorUnits).toBe(PRICE);
      expect(quote.value.owner).toBe(OWNER);
      expect(quote.value.accepting).toBe(true);
      expect(quote.value.coinType).toBe(MAINNET_RECORD.usdcType);
    }
    // The vault, then the derived price entry. Two reads, both of the chain, none of any HTTP API.
    expect(seen.objects).toEqual([VAULT, PRICE_FIELD_ID]);
  });

  it('keeps the refusal that is about the vault: not accepting is a precondition', async () => {
    const { client } = fakeClient({ accepting: false, balance: '0' });
    const quote = await readOnly(client).quote({ vaultId: VAULT, contentKey: KEY });
    expect(quote.ok).toBe(false);
    if (!quote.ok) {
      expect(classificationOf(quote.failure)).toBe('precondition');
      expect(preconditionOf(quote.failure)?.name).toBe('vault-not-accepting');
    }
  });

  it('skips only the refusal that is about the payer: a keyed OWNER is refused, a keyless reader is not', async () => {
    /*
      The one documented difference between the two surfaces. `readPayableVault` refuses a payer
      who owns the vault (ESelfPayment, code 13). A read-only agent has no address, so the check
      has no subject; the keyed agent whose address IS the owner still gets the refusal.
    */
    const { client } = fakeClient({ accepting: true, balance: '0' });
    const ownerKey = generateAgentKey();
    const keyed = createAgent({
      keypair: ownerKey.key,
      config: FULL_ENV,
      client: fakeClientOwnedBy(ownerKey.key.address),
    });
    expect(keyed.ok).toBe(true);
    if (!keyed.ok) return;

    const asOwner = await keyed.value.quote({ vaultId: VAULT, contentKey: KEY });
    expect(asOwner.ok).toBe(false);
    if (!asOwner.ok) expect(asOwner.failure.detail).toContain('ESelfPayment');

    const asReader = await readOnly(client).quote({ vaultId: VAULT, contentKey: KEY });
    expect(asReader.ok).toBe(true);
  });

  it('reports a node failure as a Reading, never a throw or a default', async () => {
    const tripped = { getObject: async () => { throw new Error('ECONNREFUSED'); } };
    const quote = await readOnly(tripped as unknown as SuiGrpcClient).quote({ vaultId: VAULT, contentKey: KEY });
    expect(quote.ok).toBe(false);
  });
});

describe('balanceOf() without a key', () => {
  it('reads the named address in the manifest coin type', async () => {
    const { client, seen } = fakeClient({ accepting: true, balance: '123456' });
    const balance = await readOnly(client).balanceOf(OWNER);
    expect(balance.ok && balance.value).toBe(123_456n);
    expect(seen.balances).toEqual([{ owner: OWNER, coinType: MAINNET_RECORD.usdcType }]);
  });

  it('takes another coin type when one is named', async () => {
    const { client, seen } = fakeClient({ accepting: true, balance: '7' });
    const balance = await readOnly(client).balanceOf(OWNER, '0x2::sui::SUI');
    expect(balance.ok && balance.value).toBe(7n);
    expect(seen.balances[0]?.coinType).toBe('0x2::sui::SUI');
  });

  it('is the same reader the keyed agent uses for balance(), pointed at a named address', async () => {
    const { client, seen } = fakeClient({ accepting: true, balance: '9' });
    const made = createAgent({ keypair: generateAgentKey().key, config: FULL_ENV, client });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const agent: Agent = made.value;
    await agent.balance();
    await agent.balanceOf(OWNER);
    expect(seen.balances.map((b) => b.owner)).toEqual([agent.address, OWNER]);
  });
});

/** A node whose one vault is owned by `owner` — for the self-payment half of the quote test. */
function fakeClientOwnedBy(owner: string): SuiGrpcClient {
  const bytes = CreatorVaultBcs.serialize({
    id: VAULT,
    version: 1n,
    platform: MAINNET_RECORD.platformId,
    owner,
    account: `0x${'d'.repeat(64)}`,
    feeBpsSnapshot: 290n,
    referralShareBpsSnapshot: 0n,
    tiers: [],
    contentPrices: { id: TABLE, size: 0n },
    minTip: 0n,
    accepting: true,
    earnings: 0n,
    platformFees: 0n,
    grossVolume: 0n,
    subscriptionsSold: 0n,
    unlocksSold: 0n,
    tipsReceived: 0n,
  }).toBytes();
  return {
    getObject: async (input: { objectId: string }) => {
      if (input.objectId !== VAULT) throw new Error(`no object ${input.objectId}`);
      return { object: { content: bytes } };
    },
  } as unknown as SuiGrpcClient;
}
