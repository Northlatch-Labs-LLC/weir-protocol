// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  One decoder for every object read.

  The package carried three decoders: client/creator/stakevault accepted a Uint8Array, a byte
  array or an array-like object but NOT a base64 string; accounts/keyregistry accepted a Uint8Array
  or base64 but NOT an array. `objectbytes.ts` accepts all five and was used by none of them. A
  transport that answered the platform as base64 made `readPlatform` say "no decodable content"
  and every page fold it to "not measured" — a value the node had sent.

  Mutations predicted: put the array-only reader back in client.ts → "a base64 platform is read"
  red and the source pin red; drop the base64 branch from objectbytes → both readers red.
*/
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { readPlatform, PLATFORM_BCS_FIELDS } from '../src/client.js';

const show = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));

const hex = (c: string) => `0x${c.repeat(64)}`;
const config = {
  network: 'mainnet' as const,
  grpcUrl: 'https://fullnode.example.invalid:443',
  packageId: hex('1'),
  latestPackageId: hex('1'),
  platformId: hex('2'),
  registryId: hex('3'),
};

/** A Platform, byte for byte as the chain lays it out (the field list is the SDK's own). */
function platformBytes(): Uint8Array {
  const Platform = bcs.struct('Platform', {
    id: bcs.Address,
    version: bcs.u64(),
    fee_bps: bcs.u64(),
    referral_share_bps: bcs.u64(),
    creation_fee_mist: bcs.u64(),
    creation_paused: bcs.bool(),
    payments_paused: bcs.bool(),
    treasury: bcs.Address,
    accounts_created: bcs.u64(),
    vaults_created: bcs.u64(),
  });
  expect(Object.keys(Platform.serialize({
    id: hex('2'), version: 1n, fee_bps: 290n, referral_share_bps: 500n, creation_fee_mist: 0n,
    creation_paused: false, payments_paused: false, treasury: hex('9'), accounts_created: 7n, vaults_created: 3n,
  }).parse())).toEqual([...PLATFORM_BCS_FIELDS]);
  return Platform.serialize({
    id: hex('2'), version: 1n, fee_bps: 290n, referral_share_bps: 500n, creation_fee_mist: 0n,
    creation_paused: false, payments_paused: false, treasury: hex('9'), accounts_created: 7n, vaults_created: 3n,
  }).toBytes();
}

const clientAnswering = (content: unknown): SuiGrpcClient =>
  ({ getObject: async () => ({ object: { objectId: hex('2'), content } }) }) as unknown as SuiGrpcClient;

describe('readPlatform through the one decoder', () => {
  it('a base64 platform is read — the shape the old client.ts reader refused', async () => {
    const b64 = Buffer.from(platformBytes()).toString('base64');
    const r = await readPlatform(clientAnswering(b64), config);
    expect(r.ok, show(r)).toBe(true);
    if (r.ok) expect(r.value.feeBps).toBe(290n);
  });

  it('an array platform is read too', async () => {
    const r = await readPlatform(clientAnswering(Array.from(platformBytes())), config);
    expect(r.ok, show(r)).toBe(true);
  });

  it('bytes that are not base64 are malformed, not a platform', async () => {
    const r = await readPlatform(clientAnswering('not base64!!'), config);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed');
  });
});

describe('every object reader delegates to objectbytes.ts', () => {
  for (const file of ['client', 'creator', 'stakevault', 'accounts', 'keyregistry']) {
    it(`src/${file}.ts has no decoder of its own`, () => {
      const src = readFileSync(join(process.cwd(), 'src', `${file}.ts`), 'utf8');
      expect(src).toMatch(/decodeObjectBytes\(/);
      expect(src).not.toMatch(/Buffer\.from\(value, 'base64'\)/);
      expect(src).not.toMatch(/values\.every\(\(v\) => typeof v === 'number'\)/);
    });
  }
});
