// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  `readPreview` — the read the MCP's `weir_read` waited for. Maps `GET /api/posts/{id}` to a
  `PublicPost`, `null` for a gated post, and a Reading failure for anything else.

  Mutations predicted: return the body for a gated answer → "a gated post is null" red; treat a
  404 as null → "an unknown post is not-found, not null" red.
*/
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { describe, expect, it } from 'vitest';
import { createAgent, MAINNET_RECORD } from '../src/index.js';

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

function keyless(answer: (url: string) => { status: number; body: unknown }) {
  const fetchImpl = (async (url: string) => {
    const a = answer(url);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  }) as unknown as NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>;
  const made = createAgent({ keypair: null, config: ENV, client: {} as SuiGrpcClient, fetchImpl });
  if (!made.ok) throw new Error(made.failure.detail);
  return made.value;
}

const post = { id: 'p-1', handle: 'alice', title: 'Open', preview: 'a taste', access: { kind: 'public' }, createdAtMs: 1 };

describe('readPreview', () => {
  it('maps a public post to its body, entitled as public', async () => {
    const agent = keyless(() => ({ status: 200, body: { post, body: 'the words', entitledVia: 'public' } }));
    const r = await agent.readPreview({ postId: 'p-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ postId: 'p-1', handle: 'alice', title: 'Open', body: 'the words', entitledVia: 'public' });
  });

  it('a gated post is null: exists, not entitled', async () => {
    const agent = keyless(() => ({ status: 200, body: { post: { ...post, access: { kind: 'paid', price: '1', contentKey: 'k' } }, body: null, entitledVia: null } }));
    const r = await agent.readPreview({ postId: 'p-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeNull();
  });

  it('an unknown post is not-found, not null', async () => {
    const agent = keyless(() => ({ status: 404, body: { error: 'no such post' } }));
    const r = await agent.readPreview({ postId: 'nope' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('not-found');
  });

  it('refuses an id that is not a token before any request', async () => {
    let asked = false;
    const agent = keyless(() => { asked = true; return { status: 200, body: {} }; });
    const r = await agent.readPreview({ postId: '../admin' });
    expect(r.ok).toBe(false);
    expect(asked).toBe(false);
  });
});
