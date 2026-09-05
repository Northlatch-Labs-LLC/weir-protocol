// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * The hosted endpoint's four refusals, driven over a real socket.
 *
 * # Why a real socket and not a mocked request object
 *
 * Every control here reads a header, and headers are the one part of an HTTP server that a mock
 * makes convincingly wrong. `Host` in particular is synthesised by the client from the URL it was
 * given rather than set by the caller, which is exactly the property that makes it the
 * DNS-rebinding control — and a mock that lets the test set `Host` freely would be testing a
 * different mechanism from the one that ships. So this opens a listener on a real port and speaks
 * real HTTP to it.
 *
 * # What is checked
 *
 *  1. **Host** — a request naming a host this endpoint does not answer to is refused. This is the
 *     DNS-rebinding control, and it is the one that still works when `Origin` is absent, which is
 *     precisely the rebinding case.
 *  2. **Origin** — a browser origin that is not on the allowlist is refused, with the default empty
 *     allowlist refusing every origin and serving every request that sends none.
 *  3. **Cookie** — a request carrying one is refused outright rather than having it ignored, and no
 *     response ever carries `Set-Cookie`.
 *  4. **Statelessness** — `initialize` returns no `mcp-session-id`, so there is no session to
 *     steal, resume, or fix.
 *
 * Nothing here binds a real agent: `serveHttp` takes a server factory, so the harness supplies one
 * with no tools at all. The controls under test run before any tool is reachable, which is the
 * whole point of where they sit in `handleHttpRequest`.
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultAllowedHosts, hostAllowed, originAllowed, resolveOptions, serveHttp } from '../src/transport.js';

const PORT = 8499;
const HOST = '127.0.0.1';

let checks = 0;
let failures = 0;

function check(what: string, fn: () => void): void {
  checks += 1;
  try {
    fn();
    console.log(`  ok  ${what}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${what}`);
    console.log(`      ${error instanceof Error ? error.message : String(error)}`);
  }
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'transport-harness', version: '1.0.0' },
  },
});

async function post(headers: Record<string, string>): Promise<Response> {
  return fetch(`http://${HOST}:${PORT}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: INITIALIZE,
  });
}

/**
 * Send a request with an arbitrary `Host`, which `fetch` will not do.
 *
 * `Host` is a forbidden header name in the Fetch standard: a browser sets it from the URL and
 * silently drops any attempt to override it, and Node's `fetch` implements that rule. That is
 * correct behaviour and it is also exactly why `Host` is trustworthy as the rebinding control — but
 * it means the attack cannot be reproduced through `fetch`, which would quietly send the real host
 * and pass. A rebound browser connects to this address while still calling it by the attacker's
 * name, so the wire carries `Host: rebind.example`; `node:http` is the client that can put that on
 * the wire here.
 */
async function postWithHost(host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: HOST,
        port: PORT,
        path: '/mcp',
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          host,
          'content-length': Buffer.byteLength(INITIALIZE),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          body += chunk;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on('error', reject);
    req.end(INITIALIZE);
  });
}

async function main(): Promise<void> {
  console.log('\n=== pure functions ===');
  check('the default Host allowlist names the bound address and both spellings of loopback', () => {
    assert.deepEqual(defaultAllowedHosts('127.0.0.1', 8402), ['127.0.0.1:8402', 'localhost:8402', '[::1]:8402']);
  });
  check('a non-loopback bind produces exactly one entry — no accidental loopback grant', () => {
    assert.deepEqual(defaultAllowedHosts('10.0.0.5', 8402), ['10.0.0.5:8402']);
  });
  check('a missing Host is refused, unlike a missing Origin', () => {
    assert.equal(hostAllowed(undefined, ['127.0.0.1:8402']), false);
    assert.equal(originAllowed(undefined, []), true);
  });
  check('Host matching is exact — a suffix lookalike does not match', () => {
    assert.equal(hostAllowed('evil-127.0.0.1:8402', ['127.0.0.1:8402']), false);
    assert.equal(hostAllowed('127.0.0.1.evil.example:8402', ['127.0.0.1:8402']), false);
  });
  check('Host matching is case-insensitive, because DNS is', () => {
    assert.equal(hostAllowed('LOCALHOST:8402', ['localhost:8402']), true);
  });

  const options = resolveOptions(['--http'], {
    WEIR_MCP_HTTP_HOST: HOST,
    WEIR_MCP_HTTP_PORT: String(PORT),
  });
  check('http mode with no key resolves to secretKey null', () => {
    assert.equal(options.secretKey, null);
  });
  check('WEIR_AGENT_KEY under --http is fatal', () => {
    assert.throws(
      () => resolveOptions(['--http'], { WEIR_AGENT_KEY: 'suiprivkey1qqq' }),
      /signs nothing in HTTP mode/,
    );
  });

  const server = await serveHttp(
    async () => new McpServer({ name: 'weir-mcp', version: '1.0.0', title: 'weir.social' }),
    options,
  );

  try {
    console.log('\n=== over a real socket ===');

    const ok = await post({});
    check('a plain request with no Origin and no Cookie is served', () => {
      assert.equal(ok.status, 200, `status ${ok.status}`);
    });
    check('no session id is issued — there is no session to steal or resume', () => {
      assert.equal(ok.headers.get('mcp-session-id'), null);
    });
    check('no Set-Cookie on a served response', () => {
      assert.equal(ok.headers.get('set-cookie'), null);
    });

    const badHost = await postWithHost('rebind.example');
    check('a request naming another host is refused (DNS rebinding)', () => {
      assert.equal(badHost.status, 403, badHost.body);
      assert.ok(badHost.body.includes('host_refused'), badHost.body);
    });
    const goodHost = await postWithHost(`localhost:${PORT}`);
    check('the other spelling of loopback is served — the allowlist is not accidentally narrow', () => {
      assert.equal(goodHost.status, 200, goodHost.body);
    });

    const browser = await post({ origin: 'https://evil.example' });
    check('a browser Origin is refused when the allowlist is empty', () => {
      assert.equal(browser.status, 403);
    });
    check('the origin refusal grants the page nothing — no CORS header on it', () => {
      assert.equal(browser.headers.get('access-control-allow-origin'), null);
    });

    const withCookie = await post({ cookie: 'session=abc123' });
    check('a request carrying a Cookie is REFUSED, not merely ignored', () => {
      assert.equal(withCookie.status, 400);
    });
    const cookieBody = (await withCookie.json()) as { error?: string; detail?: string };
    check('the cookie refusal is machine-readable', () => {
      assert.equal(cookieBody.error, 'cookie_refused');
      assert.ok((cookieBody.detail ?? '').includes('single-use signature'), cookieBody.detail ?? '(no detail)');
    });

    const wrongPath = await fetch(`http://${HOST}:${PORT}/nope`, { method: 'POST', body: '{}' });
    check('an unknown path 404s and names where MCP is served', () => {
      assert.equal(wrongPath.status, 404);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  console.log(`\n${checks - failures}/${checks} checks passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
