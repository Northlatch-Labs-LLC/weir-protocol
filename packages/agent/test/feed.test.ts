// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `feed` reads the shop window, and reports what it could not read.
 *
 * # Against a real server
 *
 * A loopback `node:http` server plays `GET /api/browse`: two pages, the second reachable only by the
 * cursor the first handed out, and a switch that makes it answer 500. Real sockets, real status
 * codes, real JSON — so the failure mapping is exercised where it lives, in the response handling,
 * and not in a stub that returns what the test wanted.
 *
 * # The three claims
 *
 *   1. The request is exactly the endpoint's: `kind=posts`, `handle` when given, `cursor` verbatim
 *      when given, and NO `limit` — the page size is the server's, and this package does not offer
 *      a way to ask for another.
 *   2. `truncated` and `nextCursor` reach the caller as the server said them; a cursor walk covers
 *      both pages with no gap and no repeat.
 *   3. A 500, a body that is not a page, and a server that is not there are three failure kinds —
 *      `malformed`, `malformed`, `transport` — and never `ok` with an empty page.
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAINNET_RECORD, createAgent, type ReadOnlyAgent } from '../src/index.js';

const CURSOR = 'eyJrIjoicG9zdHMiLCJoIjpudWxsLCJ0IjoxNzU2NzAwMDAwMDAwLCJpZCI6InAwMTkifQ';

const PAGE_ONE = {
  kind: 'posts',
  items: [
    { id: 'p001', authorHandle: 'alice', vaultId: '0xv', createdAtMs: 2, title: 'One', preview: 'first', access: { kind: 'paid', price: '250000', contentKey: 'k1' } },
    { id: 'p002', authorHandle: 'bob', vaultId: '0xw', createdAtMs: 1, title: 'Two', preview: 'second', access: { kind: 'public' }, body: 'the words' },
  ],
  pageSize: 20,
  truncated: true,
  nextCursor: CURSOR,
};
const PAGE_TWO = {
  kind: 'posts',
  items: [{ id: 'p003', authorHandle: 'alice', vaultId: '0xv', createdAtMs: 0, title: 'Three', preview: 'third', access: { kind: 'subscribers' } }],
  pageSize: 20,
  truncated: false,
  nextCursor: null,
};

/** What the server was asked, in order, so the request shape is asserted and not assumed. */
const requests: URL[] = [];
let mode: 'pages' | 'fail500' | 'notapage' = 'pages';
let server: Server;
let baseUrl = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url);
    if (mode === 'fail500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'the store did not answer' }));
      return;
    }
    if (mode === 'notapage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ kind: 'posts', items: 'nope', truncated: 'yes' }));
      return;
    }
    if (url.pathname !== '/api/browse' || url.searchParams.get('kind') !== 'posts') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not here' }));
      return;
    }
    const cursor = url.searchParams.get('cursor');
    const page = cursor === null ? PAGE_ONE : cursor === CURSOR ? PAGE_TWO : null;
    if (page === null) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'cursor is not one this endpoint issued for this listing' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(page));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

function reader(base = baseUrl): ReadOnlyAgent {
  const made = createAgent({
    keypair: null,
    config: {
      PROJECTX_SOCIAL_NETWORK: 'mainnet',
      PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
      PROJECTX_SOCIAL_PACKAGE_ID: MAINNET_RECORD.packageId,
      PROJECTX_SOCIAL_LATEST_PACKAGE_ID: MAINNET_RECORD.latestPackageId,
      PROJECTX_SOCIAL_PLATFORM_ID: MAINNET_RECORD.platformId,
      PROJECTX_SOCIAL_REGISTRY_ID: MAINNET_RECORD.registryId,
      PROJECTX_SOCIAL_AGENT_COIN_TYPE: MAINNET_RECORD.usdcType,
      PROJECTX_SOCIAL_AGENT_BASE_URL: base,
    },
  });
  if (!made.ok) throw new Error(made.failure.detail);
  return made.value;
}

describe('the request is the endpoint’s', () => {
  it('asks for kind=posts and nothing about page size', async () => {
    requests.length = 0;
    mode = 'pages';
    const page = await reader().feed({});
    expect(page.ok).toBe(true);
    const asked = requests[0]!;
    expect(asked.pathname).toBe('/api/browse');
    expect([...asked.searchParams.keys()].sort()).toEqual(['kind']);
    expect(asked.searchParams.get('kind')).toBe('posts');
  });

  it('passes the handle, and the cursor verbatim', async () => {
    requests.length = 0;
    await reader().feed({ handle: 'alice', cursor: CURSOR });
    const asked = requests[0]!;
    expect([...asked.searchParams.keys()].sort()).toEqual(['cursor', 'handle', 'kind']);
    expect(asked.searchParams.get('handle')).toBe('alice');
    expect(asked.searchParams.get('cursor')).toBe(CURSOR);
  });
});

describe('the page is the server’s', () => {
  it('walks both pages by cursor with no gap and no repeat, truncated as the server said', async () => {
    mode = 'pages';
    const agent = reader();
    const first = await agent.feed({});
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.truncated).toBe(true);
    expect(first.value.nextCursor).toBe(CURSOR);
    expect(first.value.posts.map((p) => p.postId)).toEqual(['p001', 'p002']);

    const second = await agent.feed({ cursor: first.value.nextCursor! });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.truncated).toBe(false);
    expect(second.value.nextCursor).toBeNull();
    expect(second.value.posts.map((p) => p.postId)).toEqual(['p003']);
  });

  it('maps each post: id, handle, access, price with the manifest coin’s symbol, and nothing from the body', async () => {
    mode = 'pages';
    const first = await reader().feed({});
    if (!first.ok) throw new Error(first.failure.detail);
    expect(first.value.posts[0]).toEqual({ postId: 'p001', handle: 'alice', title: 'One', preview: 'first', access: 'paid', price: '250000', currency: 'USDC' });
    expect(first.value.posts[1]).toEqual({ postId: 'p002', handle: 'bob', title: 'Two', preview: 'second', access: 'public', price: null, currency: null });
    expect(JSON.stringify(first.value)).not.toContain('the words');
  });
});

describe('a failed read is a failure, never an empty page', () => {
  it('a 500 is malformed, carrying the server’s own error text', async () => {
    mode = 'fail500';
    const page = await reader().feed({});
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.failure.kind).toBe('malformed');
    expect(page.failure.detail).toContain('the store did not answer');
  });

  it('a 200 that is not a page is malformed', async () => {
    mode = 'notapage';
    const page = await reader().feed({});
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.failure.kind).toBe('malformed');
  });

  it('a refused cursor is the server’s 400, as malformed with its reason', async () => {
    mode = 'pages';
    const page = await reader().feed({ cursor: 'not-issued' });
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.failure.kind).toBe('malformed');
    expect(page.failure.detail).toContain('cursor is not one this endpoint issued');
  });

  it('a server that is not there is transport', async () => {
    const page = await reader('http://127.0.0.1:9').feed({});
    expect(page.ok).toBe(false);
    if (page.ok) return;
    expect(page.failure.kind).toBe('transport');
  });

  it('none of those is ok with zero posts', async () => {
    const outcomes: unknown[] = [];
    mode = 'fail500';
    outcomes.push(await reader().feed({}));
    mode = 'notapage';
    outcomes.push(await reader().feed({}));
    outcomes.push(await reader('http://127.0.0.1:9').feed({}));
    for (const o of outcomes) expect((o as { ok: boolean }).ok).toBe(false);
  });
});
