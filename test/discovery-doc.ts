// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * The discovery document at `/.well-known/mcp.json`, driven over a real socket.
 *
 * # Why this exists
 *
 * On 2026-09-02 the hosted endpoint's request log showed a client asking for this exact path and
 * receiving a 404 with nothing in it. There is no ratified standard behind the filename; it is
 * simply the path clients try, so we answer it and the document says that about itself.
 *
 * # What is checked, and why each one is here rather than assumed
 *
 *  1. **The tools listed are the tools the process registered.** The document takes them as an
 *     argument; a hand-written list is the one way this file could start lying, and it is the way
 *     a discovery document usually does.
 *  2. **`readOnly` is derived from those tools, not from the mode.** Mode is intent. The tool list
 *     is a fact, and a keyless deployment that somehow registered a spending tool must not be able
 *     to describe itself as read-only.
 *  3. **Host is still enforced.** The discovery path is served before the Origin check but after
 *     the Host check; a rebinding request must not find an unguarded door here.
 *  4. **Origin is deliberately NOT enforced**, so a browser can read a constant public document.
 *  5. **Anything but a read is refused**, so a client that POSTs here is told it is at the wrong
 *     path rather than handed a document it did not ask for.
 */

import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DISCOVERY_PATH, canonicalOrigin, describeTools, discoveryDocument, resolveOptions, serveHttp } from '../src/transport.js';
import type { WeirBinding, WeirPort } from '../src/transport.js';
import { registerTools } from '../src/tools.js';

const PORT = 8497;
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

/** `Host` cannot be set through `fetch`; see transport-http.ts for the full reasoning. */
async function getWithHost(path: string, host: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: HOST, port: PORT, path, method: 'GET', headers: { host } }, (res) => {
      let body = '';
      res.on('data', (c) => (body += String(c)));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

/* ---- the pure document, before any socket is involved ---------------------------------------- */

const options = { ...resolveOptions(['--http'], { WEIR_MCP_HTTP_PORT: String(PORT) }), discoveryTools: [] as string[] };

check('the tools listed are exactly the tools handed in', () => {
  const d = discoveryDocument(options, ['weir_search', 'weir_quote'], 'https://mcp.example');
  assert.deepEqual(d.tools, ['weir_search', 'weir_quote']);
  assert.equal(d.endpoint, 'https://mcp.example/mcp');
});

check('the description names only what was registered — no balance on a keyless build', () => {
  const keyless = ['weir_search', 'weir_quote', 'weir_read', 'weir_authorship', 'weir_agents', 'weir_seeking'];
  const d = discoveryDocument(options, keyless, 'https://mcp.example');
  assert.doesNotMatch(d.description, /balance/);
  assert.match(d.description, /read what a creator published/);
  assert.match(d.description, /price it from the chain/);
  assert.match(d.description, /check who signed it/);
  assert.match(d.description, /see the other agents/);
  // With a signer the balance tool is registered, and only then is it mentioned.
  assert.match(describeTools([...keyless, 'weir_balance']), /check a balance/);
  assert.match(describeTools(['weir_search', 'weir_buy']), /buy, subscribe, price and publish/);
  assert.equal(describeTools([]), 'weir.social as a tool: this process registered no tools.');
});

check('a process that registered nothing advertises nothing', () => {
  assert.deepEqual(discoveryDocument(options, [], 'https://mcp.example').tools, []);
});

check('read-only is derived from the tools, not from the mode', () => {
  const read = discoveryDocument(options, ['weir_search', 'weir_read'], 'https://mcp.example');
  assert.equal(read.readOnly, true);
  assert.match(read.note, /holds no key/);
  // The same options, the same mode: only the tool list differs, and the document must follow it.
  const spends = discoveryDocument(options, ['weir_search', 'weir_buy'], 'https://mcp.example');
  assert.equal(spends.readOnly, false);
  assert.doesNotMatch(spends.note, /holds no key/);
});

check('the hosted discovery document never lists weir_declare, and a build that has it is not read-only', () => {
  /*
    Derived, not typed: the keyless read set is what `registerTools` returns over a port offering
    every read with no signer bound. `weir_declare` cannot be in it — declaring signs a statement
    naming a human as answerable for the agent, and this endpoint has no key. Asserted here as well
    as in hosting-artifacts.ts because THIS is the document a client fetches.
  */
  const keylessPort = {
    feed: async () => ({}), quote: async () => ({}), readPreview: async () => ({}),
    authorship: async () => ({}), commentAuthorship: async () => ({}),
    agents: async () => ({}), seeking: async () => ({}), balance: async () => ({}),
    requestDeclaration: async () => ({}),
  } as unknown as WeirPort;
  const hosted = registerTools(new McpServer({ name: 'weir-mcp', version: '0.0.0' }), {
    port: keylessPort,
    signer: { kind: 'none' },
    policyAvailable: false,
  } as unknown as WeirBinding);
  assert.ok(!hosted.includes('weir_declare'), hosted.join(', '));
  const d = discoveryDocument(options, hosted, 'https://mcp.example');
  assert.ok(!d.tools.includes('weir_declare'), d.tools.join(', '));
  assert.equal(d.readOnly, true);
  assert.doesNotMatch(d.description, /declare/);

  /*
    And the other direction: `weir_declare` WRITES. A document listing it while claiming
    `readOnly: true` would contradict the note printed beside it — "registers no tool that spends or
    writes" — on the one field a client is most likely to branch on.
  */
  const keyed = discoveryDocument(options, ['weir_quote', 'weir_declare'], 'https://mcp.example');
  assert.equal(keyed.readOnly, false);
  assert.doesNotMatch(keyed.note, /holds no key/);
  assert.match(keyed.description, /declare itself to the register/);
  // It is not a SPENDING tool, so it must not drag in the buy-and-publish clause on its own.
  assert.doesNotMatch(keyed.description, /buy, subscribe, price and publish/);
});

check('the document points at the guide and the signed manifest, from the configured base', () => {
  const d = discoveryDocument(options, [], 'https://mcp.example');
  assert.equal(d.documentation, `${options.baseUrl}/llms.txt`);
  assert.equal(d.manifest, `${options.baseUrl}/.well-known/weir-agent.json`);
});

check('it never claims a standard it does not have', () => {
  assert.match(discoveryDocument(options, [], 'https://mcp.example').note, /no ratified standard/);
});

/* ---- and over a real socket ------------------------------------------------------------------ */

const http = await serveHttp(async () => new McpServer({ name: 'harness', version: '0.0.0' }, {}), {
  ...options,
  discoveryTools: ['weir_search', 'weir_quote', 'weir_read'],
});

check('the advertised address comes from the allowlist, never from the request Host', () => {
  /*
    The defect this pins, found in production on 2026-09-02 minutes after the first deploy: behind
    Cloud Run the container sees the platform hostname, so a document built from req.headers.host
    published the raw run.app address — which this endpoint's own Host allowlist refuses with 403.
  */
  const hosted = { ...options, allowedHosts: ['mcp.weir.social'] };
  assert.equal(canonicalOrigin(hosted, 'weir-mcp-k5aija3d6q-ew.a.run.app'), 'https://mcp.weir.social');
  assert.equal(discoveryDocument(hosted, [], canonicalOrigin(hosted, 'weir-mcp-k5aija3d6q-ew.a.run.app')).endpoint,
    'https://mcp.weir.social/mcp');
});

check('a loopback allowlist is plain HTTP, so a developer gets a URL that works', () => {
  assert.equal(canonicalOrigin({ ...options, allowedHosts: ['127.0.0.1:8497'] }, undefined), 'http://127.0.0.1:8497');
});

const served = await fetch(`http://${HOST}:${PORT}${DISCOVERY_PATH}`);
const body = (await served.json()) as Record<string, unknown>;

check('a plain GET is answered with the document', () => {
  assert.equal(served.status, 200);
  assert.deepEqual(body.tools, ['weir_search', 'weir_quote', 'weir_read']);
  assert.equal(body.readOnly, true);
  assert.equal(body.transport, 'streamable-http');
  assert.equal(body.authentication, 'none');
});

check('it is readable cross-origin, because it is a constant and drives nothing', () => {
  assert.equal(served.headers.get('access-control-allow-origin'), '*');
});

/*
  Awaited out here, not inside `check`. `check` is synchronous: an async callback handed to it
  returns a promise it never awaits, so every assertion inside would run after the check had
  already printed "ok" and a failure would surface as an unhandled rejection instead of a failed
  test. Two of these were written that way and passed without asserting anything.
*/
const browser = await fetch(`http://${HOST}:${PORT}${DISCOVERY_PATH}`, { headers: { origin: 'https://evil.example' } });
check('a browser Origin is served here, unlike the protocol path', () => {
  assert.equal(browser.status, 200);
});

const posted = await fetch(`http://${HOST}:${PORT}${DISCOVERY_PATH}`, { method: 'POST', body: '{}' });
check('POST is refused and names the right path', () => {
  assert.equal(posted.status, 405);
});

const rebound = await getWithHost(DISCOVERY_PATH, 'rebind.example');
check('the Host control still runs in front of it', () => {
  assert.equal(rebound.status, 403);
  assert.match(rebound.body, /host_refused/);
});

const missing = await fetch(`http://${HOST}:${PORT}/.well-known/anything-else.json`);
check('an unknown well-known path is still a 404', () => {
  assert.equal(missing.status, 404);
});

http.close();
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
