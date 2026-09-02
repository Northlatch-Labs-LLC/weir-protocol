// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  The mind, end to end against a fake deployment and a fake registry.

  Mutations predicted: derive from the address instead of the signature → "two keys derive two
  minds" red; add a second envelope in sealMind → "one envelope, the agent's own" red; skip the
  registry read in remember → "an unpublished key is refused before anything is encrypted" red;
  drop the hash check in openMind → "bytes that are not the bytes are refused" red; sign the
  statement over the plaintext hash → the verify in "remember posts a signed remember statement" red.
*/
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { KEY_STATEMENT, fromB64, statementFor, toB64 } from '@projectx-social/sdk';
import { describe, expect, it } from 'vitest';
import { createAgent, deriveMindKey, generateAgentKey, MAINNET_RECORD, openMind, sealMind, sha256Hex } from '../src/index.js';

const REGISTRY = `0x${'7'.repeat(64)}`;
const TABLE = `0x${'8'.repeat(64)}`;
const ENV = {
  PROJECTX_SOCIAL_NETWORK: 'mainnet',
  PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
  PROJECTX_SOCIAL_PACKAGE_ID: MAINNET_RECORD.packageId,
  PROJECTX_SOCIAL_LATEST_PACKAGE_ID: MAINNET_RECORD.latestPackageId,
  PROJECTX_SOCIAL_PLATFORM_ID: MAINNET_RECORD.platformId,
  PROJECTX_SOCIAL_REGISTRY_ID: MAINNET_RECORD.registryId,
  PROJECTX_SOCIAL_AGENT_COIN_TYPE: '0x2::sui::SUI',
  PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social',
  PROJECTX_SOCIAL_KEY_REGISTRY_ID: REGISTRY,
};

/*
  The registry as gRPC serves it: raw BCS. The layouts mirror `key_registry.move`; the SDK's own
  `keyregistry-layout` test pins them against the Move source, so a drift fails there, not here.
*/
const KeyRegistryBcs = bcs.struct('KeyRegistry', { id: bcs.Address, keys: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }) });
const FieldBcs = bcs.struct('Field', {
  id: bcs.Address,
  name: bcs.Address,
  value: bcs.struct('PublishedKey', { x25519Public: bcs.vector(bcs.u8()), version: bcs.u64(), updatedAtMs: bcs.u64() }),
});

/** A chain that holds one registry entry (or none) and refuses to execute anything. */
function fakeChain(entry: { address: string; x25519Public: string; version?: number } | null) {
  const calls: string[] = [];
  const client = {
    async getObject({ objectId }: { objectId: string }) {
      calls.push(`get ${objectId}`);
      if (BigInt(objectId) === BigInt(REGISTRY)) {
        return { object: { content: KeyRegistryBcs.serialize({ id: REGISTRY, keys: { id: TABLE, size: 1n } }).toBytes() } };
      }
      if (entry === null) return { object: null };
      return {
        object: {
          content: FieldBcs.serialize({
            id: objectId,
            name: entry.address,
            value: { x25519Public: Array.from(fromB64(entry.x25519Public)), version: BigInt(entry.version ?? 1), updatedAtMs: 0n },
          }).toBytes(),
        },
      };
    },
    async simulateTransaction() {
      calls.push('simulate');
      throw new Error('this test must not reach the chain');
    },
    async executeTransaction() {
      calls.push('execute');
      throw new Error('this test must not reach the chain');
    },
  };
  return { client: client as unknown as SuiGrpcClient, calls };
}

/** A weir deployment: one record store and one aggregator. */
function fakeWeir() {
  const records = new Map<string, Record<string, unknown>>();
  const blobs = new Map<string, Uint8Array>();
  const posts: Array<Record<string, unknown>> = [];
  const doFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.pathname === '/api/agents/mind' && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      const payload = body['payload'] as { ciphertext: string; nonce: string; envelopes: Array<Record<string, string>> };
      const ciphertext = fromB64(payload.ciphertext);
      const blobId = `blob${toB64(ciphertext.subarray(0, 30)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`.slice(0, 43);
      blobs.set(blobId, ciphertext);
      const mind = {
        label: body['label'],
        blobId,
        endEpoch: 300,
        sha256: sha256Hex(ciphertext),
        bytes: ciphertext.length,
        createdAtMs: 1_788_000_000_000,
        nonce: payload.nonce,
        envelope: payload.envelopes[0],
      };
      records.set(`${body['address']}/${body['label']}`, mind);
      return Response.json({ mind }, { status: 201 });
    }
    if (u.pathname === '/api/agents/mind' && (init?.method ?? 'GET') === 'GET') {
      const mind = records.get(`${u.searchParams.get('address')}/${u.searchParams.get('label')}`);
      return mind === undefined ? Response.json({ error: 'no mind under that label' }, { status: 404 }) : Response.json({ mind });
    }
    const m = /^\/v1\/blobs\/(.+)$/.exec(u.pathname);
    if (m !== null) {
      const bytes = blobs.get(m[1]!);
      return bytes === undefined ? new Response('', { status: 404 }) : new Response(bytes, { status: 200 });
    }
    return Response.json({ error: `unexpected ${init?.method ?? 'GET'} ${u.pathname}` }, { status: 500 });
  };
  return { doFetch, records, blobs, posts };
}

async function agentWith(chainEntry: Parameters<typeof fakeChain>[0] | 'same', weir = fakeWeir()) {
  const { key } = generateAgentKey();
  const pair = await deriveMindKey(async (m) => (await key.keypair.signPersonalMessage(m)).signature);
  if (!pair.ok) throw new Error(pair.failure.detail);
  const entry = chainEntry === 'same' ? { address: key.address, x25519Public: pair.value.x25519Public } : chainEntry;
  const chain = fakeChain(entry);
  const made = createAgent({ keypair: key, config: ENV, client: chain.client, fetchImpl: weir.doFetch, aggregators: ['https://agg.example'] });
  if (!made.ok) throw new Error(made.failure.detail);
  return { agent: made.value, key, pair: pair.value, chain, weir };
}

describe('deriveMindKey', () => {
  it('is deterministic for one key and two keys derive two minds', async () => {
    const a = Ed25519Keypair.generate();
    const b = Ed25519Keypair.generate();
    const signA = async (m: Uint8Array) => (await a.signPersonalMessage(m)).signature;
    const signB = async (m: Uint8Array) => (await b.signPersonalMessage(m)).signature;
    const one = await deriveMindKey(signA);
    const again = await deriveMindKey(signA);
    const other = await deriveMindKey(signB);
    expect(one.ok && again.ok && other.ok).toBe(true);
    if (!one.ok || !again.ok || !other.ok) return;
    expect(one.value.x25519Public).toBe(again.value.x25519Public);
    expect(one.value.x25519Public).not.toBe(other.value.x25519Public);
  });

  it('signs exactly KEY_STATEMENT, so the browser and the agent derive the same key from one wallet', async () => {
    let seen: string | null = null;
    const k = Ed25519Keypair.generate();
    await deriveMindKey(async (m) => {
      seen = new TextDecoder().decode(m);
      return (await k.signPersonalMessage(m)).signature;
    });
    expect(seen).toBe(KEY_STATEMENT);
  });

  it('a signer that refuses or returns nothing is a malformed reading, not a key', async () => {
    expect((await deriveMindKey(async () => { throw new Error('keystore locked'); })).ok).toBe(false);
    expect((await deriveMindKey(async () => '')).ok).toBe(false);
  });
});

describe('sealMind and openMind', () => {
  it('one envelope, the agent’s own; the hash and length are of the ciphertext', async () => {
    const { key, pair } = await agentWith('same');
    const plaintext = new TextEncoder().encode('the state of the desk');
    const sealed = sealMind({ address: key.address, x25519Public: pair.x25519Public, plaintext });
    expect(sealed.payload.envelopes).toHaveLength(1);
    expect(sealed.payload.envelopes[0]!.recipient).toBe(key.address);
    const ciphertext = fromB64(sealed.payload.ciphertext);
    expect(sealed.sha256).toBe(sha256Hex(ciphertext));
    expect(sealed.bytes).toBe(ciphertext.length);
    expect(sealed.sha256).not.toBe(sha256Hex(plaintext));
  });

  it('bytes that are not the bytes are refused with both hashes, and a wrong key cannot open it', async () => {
    const { key, pair } = await agentWith('same');
    const sealed = sealMind({ address: key.address, x25519Public: pair.x25519Public, plaintext: new Uint8Array([1, 2, 3]) });
    const ciphertext = fromB64(sealed.payload.ciphertext);
    const tampered = Uint8Array.from(ciphertext);
    tampered[0] = tampered[0]! ^ 0xff;
    const refused = openMind({ address: key.address, secret: pair.secret, ciphertext: tampered, expectedSha256: sealed.sha256, nonce: sealed.payload.nonce, envelope: sealed.payload.envelopes[0]! });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.failure.kind).toBe('malformed');
      expect(refused.failure.detail).toContain(sealed.sha256);
      expect(refused.failure.detail).toContain(sha256Hex(tampered));
    }
    const stranger = await deriveMindKey(async (m) => (await Ed25519Keypair.generate().signPersonalMessage(m)).signature);
    if (!stranger.ok) throw new Error('no key');
    const wrongKey = openMind({ address: key.address, secret: stranger.value.secret, ciphertext, expectedSha256: sealed.sha256, nonce: sealed.payload.nonce, envelope: sealed.payload.envelopes[0]! });
    expect(wrongKey.ok).toBe(false);
  });
});

describe('Agent.remember and Agent.recall', () => {
  it('remember posts a signed remember statement over the ciphertext, and recall returns the bytes', async () => {
    const { agent, key, weir } = await agentWith('same');
    const plaintext = new Uint8Array(3000).map((_, i) => (i * 31) & 0xff);
    const r = await agent.remember({ label: 'desk', plaintext });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value.label).toBe('desk');
    expect(r.value.endEpoch).toBe(300);

    expect(weir.posts).toHaveLength(1);
    const body = weir.posts[0]!;
    const payload = body['payload'] as { ciphertext: string; envelopes: unknown[] };
    expect(payload.envelopes).toHaveLength(1);
    const ciphertext = fromB64(payload.ciphertext);
    // The signature is over exactly the statement the server rebuilds from the bytes it received.
    const text = statementFor({ kind: 'remember', label: 'desk', sha256: sha256Hex(ciphertext), bytes: String(ciphertext.length) }, key.address, Number(body['timestampMs']), 'https://weir.social');
    const pk = await verifyPersonalMessageSignature(new TextEncoder().encode(text), String(body['signature']), { address: key.address });
    expect(pk.toSuiAddress()).toBe(key.address);
    // The plaintext never left the agent.
    expect(JSON.stringify(body)).not.toContain(toB64(plaintext));

    const back = await agent.recall({ label: 'desk' });
    expect(back.ok, JSON.stringify(back)).toBe(true);
    if (!back.ok) return;
    expect(Array.from(back.value.plaintext)).toEqual(Array.from(plaintext));
    expect(back.value.blobId).toBe(r.value.blobId);
  });

  it('an unpublished key is refused before anything is encrypted or sent', async () => {
    const { agent, weir, chain } = await agentWith(null);
    const r = await agent.remember({ label: 'desk', plaintext: new Uint8Array([1]) });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failure.kind).toBe('unconfigured');
      expect(r.failure.detail).toContain('publishMindKey');
    }
    expect(weir.posts).toHaveLength(0);
    expect(chain.calls.some((c) => c.startsWith('get '))).toBe(true);
  });

  it('a registry holding a different key is refused as a rotation, naming the version', async () => {
    const other = await deriveMindKey(async (m) => (await Ed25519Keypair.generate().signPersonalMessage(m)).signature);
    if (!other.ok) throw new Error('no key');
    const { key } = generateAgentKey();
    const chain = fakeChain({ address: key.address, x25519Public: other.value.x25519Public, version: 3 });
    const weir = fakeWeir();
    const made = createAgent({ keypair: key, config: ENV, client: chain.client, fetchImpl: weir.doFetch });
    if (!made.ok) throw new Error(made.failure.detail);
    const r = await made.value.remember({ label: 'desk', plaintext: new Uint8Array([1]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain('version 3');
    expect(weir.posts).toHaveLength(0);
  });

  it('recall refuses bytes the aggregator altered, and a label nobody remembered is not-found', async () => {
    const { agent, weir } = await agentWith('same');
    const r = await agent.remember({ label: 'desk', plaintext: new TextEncoder().encode('notes') });
    if (!r.ok) throw new Error(r.failure.detail);
    const stored = weir.blobs.get(r.value.blobId)!;
    const altered = Uint8Array.from(stored);
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 0x01;
    weir.blobs.set(r.value.blobId, altered);
    const back = await agent.recall({ label: 'desk' });
    expect(back.ok).toBe(false);
    if (!back.ok) expect(back.failure.kind).toBe('malformed');

    const none = await agent.recall({ label: 'never' });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.failure.kind).toBe('not-found');
  });

  it('publishMindKey leaves a registry that already holds the key alone: no simulation, no signature', async () => {
    const { agent, chain, pair } = await agentWith('same');
    const p = await agent.publishMindKey();
    expect(p.ok, JSON.stringify(p)).toBe(true);
    if (!p.ok) return;
    expect(p.value).toEqual({ x25519Public: pair.x25519Public, alreadyPublished: true, digest: null });
    expect(chain.calls).not.toContain('simulate');
    expect(chain.calls).not.toContain('execute');
  });

  it('mindKey returns the public half only', async () => {
    const { agent, pair } = await agentWith('same');
    const k = await agent.mindKey();
    expect(k.ok && Object.keys(k.value)).toEqual(['x25519Public']);
    if (k.ok) expect(k.value.x25519Public).toBe(pair.x25519Public);
  });

  it('without PROJECTX_SOCIAL_KEY_REGISTRY_ID, remember and publish are unconfigured and nothing is sent', async () => {
    const { key } = generateAgentKey();
    const weir = fakeWeir();
    const { PROJECTX_SOCIAL_KEY_REGISTRY_ID: _, ...noRegistry } = ENV;
    const made = createAgent({ keypair: key, config: noRegistry, client: fakeChain(null).client, fetchImpl: weir.doFetch });
    if (!made.ok) throw new Error(made.failure.detail);
    const r = await made.value.remember({ label: 'desk', plaintext: new Uint8Array([1]) });
    expect(!r.ok && r.failure.kind).toBe('unconfigured');
    const p = await made.value.publishMindKey();
    expect(!p.ok && p.failure.kind).toBe('unconfigured');
    expect(weir.posts).toHaveLength(0);
  });
});
