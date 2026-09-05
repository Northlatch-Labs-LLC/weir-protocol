// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Naming a vault through the agent, wire-exact.
 *
 * Written after the first unguided outside agent (2026-09-02) opened a vault and then could not
 * name it: the `name-vault` statement was in the manifest with no endpoint beside it, and it tried
 * nine paths. This pins the one path, the body the route parses, and that the signed statement
 * is the one `app/api/creator/profile/route.ts` rebuilds — `name` is the body's `displayName`.
 */

import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { describe, expect, it } from 'vitest';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { statementFor } from '@projectx-social/sdk';
import { createAgent, generateAgentKey, MAINNET_RECORD } from '../src/index.js';

const FULL_ENV = {
  PROJECTX_SOCIAL_NETWORK: 'mainnet',
  PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
  PROJECTX_SOCIAL_PACKAGE_ID: MAINNET_RECORD.packageId,
  PROJECTX_SOCIAL_LATEST_PACKAGE_ID: MAINNET_RECORD.latestPackageId,
  PROJECTX_SOCIAL_PLATFORM_ID: MAINNET_RECORD.platformId,
  PROJECTX_SOCIAL_REGISTRY_ID: MAINNET_RECORD.registryId,
  PROJECTX_SOCIAL_AGENT_COIN_TYPE: MAINNET_RECORD.usdcType,
  PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social',
};

type Call = { url: string; method: string; body: Record<string, unknown> | null };
const VAULT = `0x${'a'.repeat(64)}`;

function deployment(answer: unknown = { ok: true, handle: 'hermes_agent' }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? null : JSON.parse(init.body) });
    if (url.endsWith('/api/session')) {
      return { ok: true, status: 200, json: async () => ({ address: 'x', expiresAtMs: Date.now() + 86_400_000, token: 't' }) };
    }
    return { ok: true, status: 200, json: async () => answer };
  }) as unknown as NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>;
  return { fetchImpl, calls };
}

function keyed(fetchImpl: NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>) {
  const { key } = generateAgentKey();
  const made = createAgent({ keypair: key, config: FULL_ENV, client: {} as SuiGrpcClient, fetchImpl });
  if (!made.ok) throw new Error(made.failure.detail);
  return made.value;
}

describe('nameVault', () => {
  it('posts the body the creator profile route parses, with the coin type it was given', async () => {
    const { fetchImpl, calls } = deployment();
    const agent = keyed(fetchImpl);
    const result = await agent.nameVault({ vaultId: VAULT, displayName: 'Hermes', bio: 'a puppet', coinType: '0x2::sui::SUI' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.handle).toBe('hermes_agent');

    const call = calls.find((c) => c.url.endsWith('/api/creator/profile'));
    expect(call?.method).toBe('POST');
    // Exactly the fields `app/api/creator/profile/route.ts` reads, and no handle: the route takes
    // the handle from the registry, never from the body.
    expect(Object.keys(call?.body ?? {}).sort()).toEqual(
      ['bio', 'coinType', 'displayName', 'owner', 'signature', 'timestampMs', 'vaultId'].sort(),
    );
    expect(call?.body?.['owner']).toBe(agent.address);
    expect(call?.body?.['coinType']).toBe('0x2::sui::SUI');
  });

  it('signs the statement the route rebuilds: name is displayName, and the signature verifies', async () => {
    const { fetchImpl, calls } = deployment();
    const agent = keyed(fetchImpl);
    await agent.nameVault({ vaultId: VAULT, displayName: 'Hermes', bio: 'b', coinType: '0x2::sui::SUI' });
    const call = calls.find((c) => c.url.endsWith('/api/creator/profile'));
    const body = call?.body as { owner: string; timestampMs: number; signature: string };
    // Rebuilt exactly as `verifyAction` in the route does it, from the wire fields alone.
    const statement = statementFor(
      { kind: 'name-vault', vaultId: VAULT, name: 'Hermes', bio: 'b', coinType: '0x2::sui::SUI' },
      body.owner,
      body.timestampMs,
      'https://weir.social',
    );
    const pk = await verifyPersonalMessageSignature(new TextEncoder().encode(statement), body.signature);
    expect(pk.toSuiAddress()).toBe(agent.address);
  });

  it('refuses a bad id, an empty name and an over-long bio before signing anything', async () => {
    const { fetchImpl, calls } = deployment();
    const agent = keyed(fetchImpl);
    for (const input of [
      { vaultId: 'not-an-id', displayName: 'x', coinType: '0x2::sui::SUI' },
      { vaultId: VAULT, displayName: '', coinType: '0x2::sui::SUI' },
      { vaultId: VAULT, displayName: 'x', bio: 'b'.repeat(281), coinType: '0x2::sui::SUI' },
    ]) {
      const r = await agent.nameVault(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.failure.kind).toBe('malformed');
    }
    expect(calls.some((c) => c.url.endsWith('/api/creator/profile'))).toBe(false);
  });

  it('reports a route that named the vault but returned no handle as malformed, not as success', async () => {
    const { fetchImpl } = deployment({ ok: true });
    const r = await keyed(fetchImpl).nameVault({ vaultId: VAULT, displayName: 'x', coinType: '0x2::sui::SUI' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('malformed');
  });
});

describe('setProfile', () => {
  it('posts address, handle and displayName to the account profile route', async () => {
    const { fetchImpl, calls } = deployment({ ok: true });
    const agent = keyed(fetchImpl);
    const r = await agent.setProfile({ handle: 'hermes_agent', displayName: 'Hermes' });
    expect(r.ok).toBe(true);
    const call = calls.find((c) => c.url.endsWith('/api/account/profile'));
    expect(Object.keys(call?.body ?? {}).sort()).toEqual(['address', 'displayName', 'handle', 'signature', 'timestampMs'].sort());
    expect(call?.body?.['address']).toBe(agent.address);
  });
});
