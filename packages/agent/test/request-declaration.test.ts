// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  `requestDeclaration` — the agent hands its half to the site so its operator can sign in a browser.

  Mutations predicted: send the half to /api/agents/declare instead of the waiting room → "posts
  the agent half to the waiting room" red; sign a statement naming a different operator → the
  verify in the test red; treat a 4xx as success → "a refusal is a failure with the server's
  sentence" red.
*/
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { statementFor } from '@projectx-social/sdk';
import { describe, expect, it } from 'vitest';
import { createAgent, generateAgentKey, MAINNET_RECORD } from '../src/index.js';

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
const OPERATOR = `0x${'9'.repeat(64)}`;

function keyed(answer: (url: string, init: RequestInit | undefined) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const a = answer(url, init);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
  }) as unknown as NonNullable<Parameters<typeof createAgent>[0]['fetchImpl']>;
  const { key } = generateAgentKey();
  const made = createAgent({ keypair: key, config: ENV, client: {} as SuiGrpcClient, fetchImpl });
  if (!made.ok) throw new Error(made.failure.detail);
  return { agent: made.value, calls, address: key.address };
}

describe('Agent.requestDeclaration', () => {
  it('posts the agent half to the waiting room, signed over the declare-agent statement, and returns the window', async () => {
    const { agent, calls, address } = keyed(() => ({ status: 201, body: { expiresAtMs: 1_788_000_600_000, operatorPage: '/agents/declare' } }));
    const r = await agent.requestDeclaration({ operatorAddress: OPERATOR, model: 'claude', purpose: 'audits' });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.operatorPage).toBe('https://weir.social/agents/declare');
    expect(r.value.expiresAtMs).toBe(1_788_000_600_000);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://weir.social/api/agents/declare/pending');
    const body = JSON.parse(String(calls[0]!.init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ address, operatorAddress: OPERATOR, model: 'claude', purpose: 'audits' });
    expect(body['operatorSignature']).toBeUndefined();
    expect(body['timestampMs']).toBe(r.value.issuedAtMs);

    // The signature is over exactly the statement the server will rebuild, by exactly this key.
    const text = statementFor({ kind: 'declare-agent', operator: OPERATOR, model: 'claude', purpose: 'audits' }, address, r.value.issuedAtMs, 'https://weir.social');
    const key = await verifyPersonalMessageSignature(new TextEncoder().encode(text), String(body['agentSignature']), { address });
    expect(key.toSuiAddress()).toBe(address);
  });

  it('a refusal is a failure with the server’s sentence, never a request that looks filed', async () => {
    const { agent } = keyed(() => ({ status: 401, body: { error: "the agent's signature does not stand: expired" } }));
    const r = await agent.requestDeclaration({ operatorAddress: OPERATOR, model: 'claude', purpose: 'audits' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain('does not stand');
  });

  it('refuses an operator that is not an address, and a self-operated request, before signing anything', async () => {
    const { agent, calls, address } = keyed(() => ({ status: 201, body: {} }));
    expect((await agent.requestDeclaration({ operatorAddress: 'nope', model: 'claude', purpose: 'audits' })).ok).toBe(false);
    expect((await agent.requestDeclaration({ operatorAddress: address, model: 'claude', purpose: 'audits' })).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
