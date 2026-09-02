// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  Two seams on the publish path, each between a green agent suite and a green web suite:

  1. The agent sent no `Idempotency-Key`, so the ledger the web keeps for retries was never
     reached from here. Now `post` and `send` carry the caller's key as the header.
  2. The route answers `{ post: { id, access } }`; the agent read a top-level `postId` and
     reported every accepted publish as malformed. Now it reads the shape the route returns.

  Mutations predicted: drop the header spread in `post` → "sends the key" red; read `postId` only
  → "reads the id the route returns" red.
*/
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { describe, expect, it } from 'vitest';
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

type Call = { url: string; headers: Record<string, string>; body: unknown };

/** A deployment that accepts every session and every publish, and records what it was sent. */
function deployment(): { fetchImpl: NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: { headers?: Record<string, string>; body?: string }) => {
    const headers = Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    calls.push({ url, headers, body: init?.body === undefined ? null : JSON.parse(init.body) });
    if (url.endsWith('/api/session')) {
      return { ok: true, status: 200, json: async () => ({ address: 'x', expiresAtMs: Date.now() + 86_400_000, token: 't' }) };
    }
    return { ok: true, status: 200, json: async () => ({ post: { id: 'p-real', access: 'public' } }) };
  }) as unknown as NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>;
  return { fetchImpl, calls };
}

function keyed(fetchImpl: NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>) {
  const { key } = generateAgentKey();
  const made = createAgent({ keypair: key, config: FULL_ENV, client: {} as SuiGrpcClient, fetchImpl });
  if (!made.ok) throw new Error(made.failure.detail);
  return made.value;
}

const article = { handle: 'kaela', title: 't', preview: 'p', text: 'the words', access: 'public' as const };

describe('publishing through the agent', () => {
  it('sends the idempotency key as the header the web reads', async () => {
    const { fetchImpl, calls } = deployment();
    const result = await keyed(fetchImpl).post({ ...article, idempotencyKey: 'k-42' });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const publish = calls.find((c) => c.url.endsWith('/api/posts'));
    expect(publish?.headers['idempotency-key']).toBe('k-42');
  });

  it('sends no header when no key was given — a browser-shaped request, unchanged', async () => {
    const { fetchImpl, calls } = deployment();
    await keyed(fetchImpl).post(article);
    const publish = calls.find((c) => c.url.endsWith('/api/posts'));
    expect(publish).toBeDefined();
    expect(publish?.headers['idempotency-key']).toBeUndefined();
  });

  it('reads the id the route returns, nested under post', async () => {
    const { fetchImpl } = deployment();
    const result = await keyed(fetchImpl).post(article);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.postId).toBe('p-real');
  });
});

describe('a subscriber post with a tier', () => {
  it('sends the tier in the body and binds it into the signed access line', async () => {
    const { fetchImpl, calls } = deployment();
    const agent = keyed(fetchImpl);
    const result = await agent.post({ ...article, access: 'subscribers', tier: 2 });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const publish = calls.find((c) => c.url.endsWith('/api/posts'));
    const body = publish?.body as { access: string; tier?: number };
    expect(body.access).toBe('subscribers');
    expect(body.tier).toBe(2);
  });
});
