// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `createAgent` — wiring, refusals, and the two methods that are no longer exported.
 *
 * Ported from the unrerunnable scratchpad harness, with the surface assertions added.
 */

import { verifyPersonalMessageSignature } from '@mysten/sui/verify';
import { describe, expect, it } from 'vitest';

import { MAINNET_RECORD, createAgent, generateAgentKey } from '../src/index.js';

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

const { key } = generateAgentKey();

describe('createAgent', () => {
  const made = createAgent({ keypair: key, config: FULL_ENV });

  it('builds an agent from an environment', () => {
    expect(made.ok).toBe(true);
  });

  it('reports a padded address', () => {
    expect(made.ok && /^0x[0-9a-f]{64}$/.test(made.value.address)).toBe(true);
  });

  it('holds no Seal implementation unless one is supplied', () => {
    // `null` rather than a stub: sealed content stays sealed and says so, instead of being
    // silently skipped as though the agent had looked and found nothing.
    expect(made.ok && made.value.seal).toBeNull();
  });

  it('carries the LATEST package id for moveCall targets', () => {
    expect(made.ok && made.value.manifest.config.latestPackageId).toBe(
      MAINNET_RECORD.latestPackageId,
    );
  });

  it('signs as the agent address', async () => {
    expect(made.ok).toBe(true);
    if (made.ok) {
      const signed = await made.value.sign({ kind: 'read-content' });
      const pk = await verifyPersonalMessageSignature(
        new TextEncoder().encode(signed.statement),
        signed.signature,
        { address: made.value.address },
      );
      expect(pk.toSuiAddress()).toBe(made.value.address);
    }
  });

  it('accepts a bech32 secret as well as a loaded key', () => {
    const { secret } = generateAgentKey();
    expect(createAgent({ keypair: secret, config: FULL_ENV }).ok).toBe(true);
  });

  it('lets baseUrl override the manifest, normalised', () => {
    const overridden = createAgent({
      keypair: key,
      config: FULL_ENV,
      baseUrl: 'https://staging.weir.social/',
    });
    expect(overridden.ok && overridden.value.manifest.baseUrl).toBe('https://staging.weir.social');
  });

  it('REFUSES an unconfigured environment rather than defaulting to mainnet', () => {
    expect(createAgent({ keypair: key, config: {} }).ok).toBe(false);
  });

  it('REFUSES a bad key', () => {
    expect(createAgent({ keypair: 'nope', config: FULL_ENV }).ok).toBe(false);
  });
});

describe('the surface exports nothing that cannot work', () => {
  const made = createAgent({ keypair: key, config: FULL_ENV });

  /*
    `feed()` and `quote(postId)` are gone. Both went through `GET /api/posts`, and
    `packages/web/app/api/posts/route.ts` exports `dynamic` at :18 and `POST` at :47 and nothing
    else. There is no `GET`. Every call returned a refusal on every deployment, always.

    An honest error message does not make an exported method honest: a public surface that cannot
    succeed is a promise, and a caller reading the type has no way to learn from it that the answer
    is always no.

    They were not rebuilt from chain events either, and that was measured rather than assumed:
    `creator.move` emits `ContentPriced { vault, content_key, price }` and `ContentUnpriced`, and
    no event anywhere carries a title, a preview, a body or an author. A post lives in Postgres.
    A "feed" built from those events would be a list of opaque byte strings with numbers beside
    them, which is a worse answer than a 405.

    `feed()` is back, and it is back because the endpoint it needed now exists: `GET /api/browse`,
    the shop window (weir #102) — a fixed page, `truncated` measured by the server, an opaque
    cursor. It never names `/api/posts`. `test/feed.test.ts` runs it against a loopback server;
    this pin only says the member exists and the old path does not come back with it.
  */
  it('exports feed(), over the endpoint that exists', () => {
    expect(made.ok && typeof made.value.feed).toBe('function');
  });

  it('quote() takes the vault and content key, which DO exist on chain', () => {
    // The half that always worked. It is also the half a spending decision depends on, because the
    // price it returns is read from the vault and not from any HTTP response.
    expect(made.ok && typeof made.value.quote).toBe('function');
  });

  it('every callable member is a plain function on the object', () => {
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const agent = made.value;
    for (const name of [
      'sign',
      'session',
      'openAccount',
      'quote',
      'unlock',
      'subscribe',
      'tip',
      'post',
      'send',
      'balance',
    ] as const) {
      expect(typeof agent[name], `${name} is missing from the agent`).toBe('function');
    }
  });
});

describe('two agents in one process do not share a session', () => {
  it('each holds its own credential in its own closure', async () => {
    /*
      The session is held in a closure rather than a module-level variable. Two agents with two
      keys sharing one variable would take turns overwriting each other's session and each would
      intermittently read as the other — a data leak between agents, and a closure is the cheapest
      way to make it impossible.
    */
    const a = generateAgentKey();
    const b = generateAgentKey();
    const seen: string[] = [];

    const agentA = createAgent({
      keypair: a.key,
      config: FULL_ENV,
      fetchImpl: async (_url, init) => {
        seen.push(String(JSON.parse(String(init?.body)).address));
        return new Response(JSON.stringify({ address: a.key.address, token: 'A' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const agentB = createAgent({
      keypair: b.key,
      config: FULL_ENV,
      fetchImpl: async (_url, init) => {
        seen.push(String(JSON.parse(String(init?.body)).address));
        return new Response(JSON.stringify({ address: b.key.address, token: 'B' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });

    expect(agentA.ok && agentB.ok).toBe(true);
    if (!agentA.ok || !agentB.ok) return;

    const sa = await agentA.value.session();
    const sb = await agentB.value.session();
    expect(sa.ok && sa.value.headers()['Authorization']).toBe('Bearer A');
    expect(sb.ok && sb.value.headers()['Authorization']).toBe('Bearer B');

    // And the second call reuses, rather than re-minting — the signature it would spend is the
    // single-use kind, and a chatty agent re-signing every read writes a replay-ledger row per poll.
    await agentA.value.session();
    expect(seen).toEqual([agentA.value.address, agentB.value.address]);
  });
});
