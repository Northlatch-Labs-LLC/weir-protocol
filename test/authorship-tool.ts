// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `weir_authorship`, the tool.
 *
 * What is being protected here is the shape of the answer, because the whole feature turns on two
 * distinctions a careless tool would erase:
 *
 *   a proof that is absent  is not  a proof that failed;
 *   a handle that moved     is not  a forgery.
 *
 * And the tool must never claim to have verified anything. A verification performed by the party
 * selling you the post is not a verification, so the answer carries the bytes and the instructions
 * and no verdict.
 */
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../src/tools.js';
import type { WeirBinding, WeirPort, WeirAuthorship } from '../src/transport.js';

let checks = 0;
let failures = 0;
function check(what: string, fn: () => void | Promise<void>): Promise<void> {
  checks += 1;
  return Promise.resolve()
    .then(fn)
    .then(
      () => console.log(`  ok  ${what}`),
      (error: unknown) => {
        failures += 1;
        console.log(`FAIL  ${what}`);
        console.log(`      ${error instanceof Error ? error.message : String(error)}`);
      },
    );
}

const PROOF = {
  address: `0x${'ab'.repeat(32)}`,
  signature: 'AQAAsig',
  statement: 'Weir\naddress: 0x…\naction: publish',
  origin: 'https://weir.social',
  contentSha256: 'f'.repeat(64),
  issuedAtMs: 1788376431390,
};

/**
 * A keyless server with the authorship reader bound, reached over a real MCP transport.
 *
 * Through the client rather than by reaching into the server's registry: the schemas are enforced
 * on the way out, so a tool whose answer does not match its own outputSchema fails here rather than
 * in somebody's runtime.
 */
async function connect(answer: WeirAuthorship): Promise<{ client: Client; registered: string[] }> {
  const port: WeirPort = { authorship: async () => answer, commentAuthorship: async () => answer };
  const binding = { port, signer: { kind: 'none' }, policyAvailable: false } as unknown as WeirBinding;
  const server = new McpServer({ name: 'weir-mcp', version: '1.0.0' });
  const registered = registerTools(server, binding);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'authorship-harness', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, registered };
}

async function call(client: Client, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = (await client.callTool({ name: 'weir_authorship', arguments: args })) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };
  assert.equal(result.isError, undefined, 'the tool must not report an error');
  assert.ok(result.structuredContent, 'the tool returns structured content');
  return result.structuredContent;
}

const keyless = await connect({ proof: PROOF, handleStillResolvesToSigner: true });
await check('a keyless server registers it, and still registers nothing that spends', () => {
  assert.ok(keyless.registered.includes('weir_authorship'), `registered: ${keyless.registered.join(', ')}`);
  for (const spending of ['weir_buy', 'weir_subscribe', 'weir_post', 'weir_send', 'weir_price']) {
    assert.ok(!keyless.registered.includes(spending), `${spending} must not be registered without a signer`);
  }
});

await check('it hands back the exact bytes and never a verdict', async () => {
  const out = await call(keyless.client, { postId: 'p1' });
  assert.deepEqual(out['proof'], PROOF);
  assert.equal(out['reason'], null);
  // No verified/valid/ok field anywhere: the caller decides, not us.
  for (const forbidden of ['verified', 'valid', 'ok', 'trusted']) {
    assert.ok(!(forbidden in out), `the answer must not carry a "${forbidden}" verdict`);
  }
  assert.match(String(out['howToVerify']), /verifyPersonalMessageSignature/);
});

await check('an absent proof is an answer with a reason, not an error', async () => {
  const reason = 'No proof was kept for this post. It is unproven, not unsigned.';
  const { client } = await connect({ proof: null, reason });
  const out = await call(client, { postId: 'p1' });
  assert.equal(out['proof'], null);
  assert.equal(out['reason'], reason);
  assert.match(String(out['howToVerify']), /nothing to verify/i);
});

await check('a handle that has moved is reported, and the proof still stands', async () => {
  const { client } = await connect({ proof: PROOF, handleStillResolvesToSigner: false });
  const out = await call(client, { postId: 'p1' });
  assert.equal(out['handleStillResolvesToSigner'], false);
  assert.deepEqual(out['proof'], PROOF, 'a moved handle must not suppress the proof');
});

await check('an unknown handle resolution stays null rather than becoming false', async () => {
  const { client } = await connect({ proof: PROOF, handleStillResolvesToSigner: null });
  const out = await call(client, { postId: 'p1' });
  assert.equal(out['handleStillResolvesToSigner'], null);
});


await check('it answers for a comment as well as a post', async () => {
  const out = await call(keyless.client, { commentId: 'c1' });
  assert.deepEqual(out['proof'], PROOF);
});

await check('neither id, or both, is refused rather than half-answered', async () => {
  for (const args of [{}, { postId: 'p1', commentId: 'c1' }]) {
    const result = (await keyless.client.callTool({ name: 'weir_authorship', arguments: args })) as {
      isError?: boolean;
      content?: { text?: string }[];
    };
    assert.equal(result.isError, true, `${JSON.stringify(args)} must be refused`);
    assert.match((result.content ?? []).map((c) => c.text ?? '').join(''), /exactly one/);
  }
});

await check('a server missing either reader does not offer the tool at all', async () => {
  const { registered } = await connect({ proof: PROOF, handleStillResolvesToSigner: null });
  assert.ok(registered.includes('weir_authorship'));
  // And with only one of the two, it must be absent rather than half-honouring its schema.
  const { McpServer: S } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { registerTools: reg } = await import('../src/tools.js');
  const half = reg(new S({ name: 'h', version: '0' }), {
    port: { authorship: async () => ({ proof: null, reason: 'x' }) },
    signer: { kind: 'none' },
    policyAvailable: false,
  } as never);
  assert.ok(!half.includes('weir_authorship'), `half a binding must not register it: ${half.join(', ')}`);
});
console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
