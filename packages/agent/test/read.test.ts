// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  `read` — an agent opens what it bought through its own Seal session.

  Mutations predicted: treat a null `sealed` as an empty body → "no entitlement is not-found" red;
  skip the decryptor → "a sealed post is opened by the bound decryptor" red; return the words
  without the hash check → the decryptor's own test covers it (SealHashMismatchError).
*/
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { describe, expect, it } from 'vitest';
import { createAgent, generateAgentKey, MAINNET_RECORD, type SealDecryptor } from '../src/index.js';

const ENV = {
  PROJECTX_SOCIAL_NETWORK: 'mainnet',
  PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
  PROJECTX_SOCIAL_PACKAGE_ID: MAINNET_RECORD.packageId,
  PROJECTX_SOCIAL_LATEST_PACKAGE_ID: MAINNET_RECORD.latestPackageId,
  PROJECTX_SOCIAL_PLATFORM_ID: MAINNET_RECORD.platformId,
  PROJECTX_SOCIAL_REGISTRY_ID: MAINNET_RECORD.registryId,
  PROJECTX_SOCIAL_AGENT_COIN_TYPE: '0x2::sui::SUI',
  PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social',
};
const hex = (c: string) => `0x${c.repeat(64)}`;
const post = { id: 'p-1', handle: 'kaela_ai', title: 'Notes', preview: 'a taste', access: { kind: 'paid', price: '1', contentKey: 'k' }, createdAtMs: 1 };
const sealed = { blobId: 'blob:machine', sealWrappedKey: 'w', nonce: 'n', sha256: 'x'.repeat(64), approval: { kind: 'unlock', vaultId: hex('a'), contentKey: 'k#machine', unlockId: hex('d') } };

function keyed(answer: (url: string) => { status: number; body: unknown }, seal?: SealDecryptor) {
  const fetchImpl = (async (url: string) => {
    if (url.endsWith('/api/session')) return { ok: true, status: 200, json: async () => ({ address: 'x', expiresAtMs: Date.now() + 86_400_000, token: 't' }) };
    const a = answer(url);
    return { ok: a.status < 300, status: a.status, json: async () => a.body };
  }) as unknown as NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>;
  const { key } = generateAgentKey();
  const made = createAgent({ keypair: key, config: ENV, client: {} as SuiGrpcClient, fetchImpl, ...(seal === undefined ? {} : { seal }) });
  if (!made.ok) throw new Error(made.failure.detail);
  return made.value;
}

describe('Agent.read', () => {
  it('a public post reads as it is', async () => {
    const agent = keyed(() => ({ status: 200, body: { post: { ...post, access: { kind: 'public' } }, body: 'the open words', entitledVia: 'public', sealed: null } }));
    const r = await agent.read({ postId: 'p-1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ body: 'the open words', entitledVia: 'public' });
  });

  it('no entitlement is not-found, never an empty body', async () => {
    const agent = keyed(() => ({ status: 200, body: { post, body: null, entitledVia: null, sealed: null } }));
    const r = await agent.read({ postId: 'p-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('not-found');
  });

  it('a sealed post is opened by the bound decryptor, which is handed the approval verbatim', async () => {
    let handed: unknown = null;
    const seal = { decrypt: async (ref: unknown) => { handed = ref; return new TextEncoder().encode('the machine words'); } } as unknown as SealDecryptor;
    const agent = keyed(() => ({ status: 200, body: { post, body: null, entitledVia: 'unlock', edition: 'machine', sealed } }), seal);
    const r = await agent.read({ postId: 'p-1' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (r.ok) expect(r.value).toMatchObject({ body: 'the machine words', entitledVia: 'unlock', edition: 'machine' });
    expect(handed).toMatchObject({ blobId: 'blob:machine', approval: { kind: 'unlock', unlockId: hex('d') } });
  });

  it('a sealed post with no decryptor bound is unconfigured, not an empty read', async () => {
    const agent = keyed(() => ({ status: 200, body: { post, body: null, entitledVia: 'unlock', sealed } }));
    const r = await agent.read({ postId: 'p-1' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.kind).toBe('unconfigured');
  });
});
