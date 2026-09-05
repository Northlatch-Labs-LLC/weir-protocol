// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * `weir_price` — the tool that makes an agent's paid post buyable — and the order it teaches.
 *
 * # What this pins
 *
 *   1. The gate. `weir_price` moves no coin and is gated like a spend anyway: absent with no signer,
 *      absent with a signer and no policy, present when both are bound and the port has the method.
 *   2. The refusals come BEFORE the port: an empty key, the reserved `#machine` marker, a price that
 *      is not a positive u64 — each answered with its named reason and ZERO calls on the stub port.
 *   3. The receipt runs under the idempotency ledger: the same JSON-RPC request id replayed reaches
 *      the port ONCE and both answers carry the same idempotencyKey. Driven over a raw transport,
 *      because the SDK client mints its own ids and a replay needs the same one twice.
 *   4. `weir_post` teaches the order. `paid` without a price is refused as `unpriced` with
 *      `next: weir_price`; the route's own 409 for an unpriced key, surfaced by the port as an error
 *      whose text says so, becomes the same refusal — not a generic `call_failed` the model would retry.
 *   5. The marker is the web's, read from its source — the same pin the agent's test uses — so
 *      the copies cannot drift.
 */

import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MACHINE_EDITION_MARKER, registerTools } from '../src/tools.js';
import type { Signer, WeirBinding, WeirPort } from '../src/transport.js';

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

const hex = (c: string) => `0x${c.repeat(64)}`;
const VAULT = hex('a');
const ROUTE_409 = '"chapter-1" has no price on this vault, so nothing could buy it. Set the content price on chain first, then publish.';

class StubCreator implements WeirPort {
  readonly priced: unknown[] = [];
  readonly posted: unknown[] = [];
  readonly asked: unknown[] = [];
  postRefusesUnpriced = false;
  /** What the deployment says about the machine edition; `undefined` removes the method entirely. */
  machineBodyAnswer: unknown = 'sealed';
  machineBody = async (input: { vaultId: string; contentKey: string }) => {
    this.asked.push(input);
    if (this.machineBodyAnswer instanceof Error) throw this.machineBodyAnswer;
    return this.machineBodyAnswer as 'sealed';
  };
  priceContent = async (input: { vaultId: string; contentKey: string; edition?: 'human' | 'machine'; price: string; currency: string; idempotencyKey: string }) => {
    this.priced.push(input);
    return { txDigest: `digest-${this.priced.length}` };
  };
  post = async (input: { access: string; idempotencyKey: string }) => {
    this.posted.push(input);
    if (this.postRefusesUnpriced) throw new Error(ROUTE_409);
    return { postId: 'p001' };
  };
}

const signer: Signer = { address: hex('f'), scheme: 'ed25519', signPersonalMessage: async () => ({}), signTransaction: async () => ({}) };

async function connect(binding: WeirBinding): Promise<{ client: Client; registered: string[] }> {
  const server = new McpServer({ name: 'weir-mcp', version: '1.0.0', title: 'weir.social' });
  const registered = registerTools(server, binding);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'price-tool-harness', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, registered };
}

const textOf = (r: unknown): string => ((r as { content?: { text?: string }[] }).content ?? []).map((b) => b.text ?? '').join('');

async function main(): Promise<void> {
  console.log('=== the gate ===');
  const unarmed = new StubCreator();
  const none = await connect({ port: unarmed, signer: { kind: 'none' }, policyAvailable: false });
  check('absent with no signer', () => assert.ok(!none.registered.includes('weir_price'), none.registered.join(', ')));
  const noPolicy = await connect({ port: new StubCreator(), signer: { kind: 'signing', signer }, policyAvailable: false });
  check('absent with a signer and no policy', () => assert.ok(!noPolicy.registered.includes('weir_price')));
  const port = new StubCreator();
  const { client, registered } = await connect({ port, signer: { kind: 'signing', signer }, policyAvailable: true });
  check('present when a signing signer and a policy are both bound', () => assert.ok(registered.includes('weir_price')));

  console.log('=== refusals before the port ===');
  const base = { vaultId: VAULT, contentKey: 'chapter-1', price: '250000', currency: 'USDC' };
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['an empty key', { ...base, contentKey: '   ' }, 'empty_key'],
    [`the reserved ${MACHINE_EDITION_MARKER} marker`, { ...base, contentKey: `chapter-1${MACHINE_EDITION_MARKER}` }, 'reserved'],
    ['a zero price', { ...base, price: '0' }, 'malformed_price'],
    ['a decimal price', { ...base, price: '0.25' }, 'malformed_price'],
  ];
  for (const [what, args, reason] of cases) {
    const result = await client.callTool({ name: 'weir_price', arguments: args });
    check(`${what} → ${reason}, zero port calls`, () => {
      assert.equal(result.isError, true, textOf(result));
      assert.equal((JSON.parse(textOf(result)) as { reason: string }).reason, reason);
      assert.equal(port.priced.length, 0);
    });
  }

  console.log('=== the machine edition ===');
  /*
    `edition: 'machine'` prices `<key>#machine`, derived by the tool and never typed. Before the
    port is asked to price, the deployment is asked whether the edition can be delivered: `absent`
    (a post sealed before machine editions were) and not-knowing both refuse; `no-post` and
    `sealed` let it through. Mutation predicted: remove the guard → the `absent` case reaches the
    port and this section goes red on `port.priced.length`.
  */
  const machinePort = new StubCreator();
  const machine = await connect({ port: machinePort, signer: { kind: 'signing', signer }, policyAvailable: true });
  const machineArgs = { ...base, edition: 'machine' };
  const guardCases: Array<[string, unknown, string]> = [
    ['absent → no_machine_body, next: weir_post', 'absent', 'no_machine_body'],
    ['a Reading that failed → unreadable', { ok: false, failure: { kind: 'transport' } }, 'unreadable'],
    ['a throw from the port → unreadable', new Error('no route'), 'unreadable'],
    ['an unknown answer → unreadable', 'maybe', 'unreadable'],
  ];
  for (const [what, answer, reason] of guardCases) {
    machinePort.machineBodyAnswer = answer;
    const result = await machine.client.callTool({ name: 'weir_price', arguments: machineArgs });
    check(`${what}, zero port price calls`, () => {
      assert.equal(result.isError, true, textOf(result));
      const parsed = JSON.parse(textOf(result)) as { reason: string; next?: { tool: string } };
      assert.equal(parsed.reason, reason);
      if (reason === 'no_machine_body') assert.equal(parsed.next?.tool, 'weir_post');
      assert.equal(machinePort.priced.length, 0);
    });
  }
  check('the deployment is asked with the HUMAN key', () => {
    const asked = machinePort.asked[0] as { vaultId: string; contentKey: string };
    assert.equal(asked.contentKey, 'chapter-1');
    assert.equal(asked.vaultId, VAULT);
  });
  for (const [what, answer] of [['no-post', 'no-post'], ['sealed', 'sealed'], ['a Reading of sealed', { ok: true, value: 'sealed' }]] as const) {
    machinePort.machineBodyAnswer = answer;
    const before = machinePort.priced.length;
    const result = await machine.client.callTool({ name: 'weir_price', arguments: { ...machineArgs, contentKey: `chapter-${what.length}` } });
    check(`${what} → priced, with edition machine and the human key on the port, the derived key on the receipt`, () => {
      assert.equal(result.isError, undefined, textOf(result));
      assert.equal(machinePort.priced.length, before + 1);
      const sent = machinePort.priced[before] as { contentKey: string; edition?: string };
      assert.equal(sent.contentKey, `chapter-${what.length}`);
      assert.equal(sent.edition, 'machine');
      assert.equal((result.structuredContent as { contentKey: string }).contentKey, `chapter-${what.length}${MACHINE_EDITION_MARKER}`);
    });
  }
  const noMethod = new StubCreator();
  (noMethod as { machineBody?: unknown }).machineBody = undefined;
  const bare = await connect({ port: noMethod, signer: { kind: 'signing', signer }, policyAvailable: true });
  const bareResult = await bare.client.callTool({ name: 'weir_price', arguments: machineArgs });
  check('a port with no way to ask → unreadable, and the human edition still prices', async () => {
    assert.equal(bareResult.isError, true);
    assert.equal((JSON.parse(textOf(bareResult)) as { reason: string }).reason, 'unreadable');
    assert.equal(noMethod.priced.length, 0);
  });
  const humanOnBare = await bare.client.callTool({ name: 'weir_price', arguments: base });
  check('the human edition never asks the deployment', () => {
    assert.equal(humanOnBare.isError, undefined, textOf(humanOnBare));
    assert.equal(noMethod.priced.length, 1);
    assert.equal((noMethod.priced[0] as { edition?: string }).edition, 'human');
  });
  await machine.client.close();
  await bare.client.close();

  console.log('=== the receipt ===');
  const ok1 = await client.callTool({ name: 'weir_price', arguments: base });
  check('a good call reaches the port once with the key, the price as digits and a ledger key, and returns the digest', () => {
    assert.equal(ok1.isError, undefined);
    assert.equal(port.priced.length, 1);
    const sent = port.priced[0] as { contentKey: string; price: string; idempotencyKey: string; currency: string };
    assert.equal(sent.contentKey, 'chapter-1');
    assert.equal(sent.price, '250000');
    assert.equal(sent.currency, 'USDC');
    assert.ok(sent.idempotencyKey.length > 0);
    const value = ok1.structuredContent as { txDigest: string; idempotencyKey: string };
    assert.equal(value.txDigest, 'digest-1');
    assert.equal(value.idempotencyKey, sent.idempotencyKey);
  });

  // The replay, over a raw transport: the same request id, twice.
  const replayPort = new StubCreator();
  const rawServer = new McpServer({ name: 'weir-mcp', version: '1.0.0', title: 'weir.social' });
  registerTools(rawServer, { port: replayPort, signer: { kind: 'signing', signer }, policyAvailable: true });
  const [rawClient, rawServerSide] = InMemoryTransport.createLinkedPair();
  const answers = new Map<string | number, JSONRPCMessage>();
  const waiters = new Map<string | number, (m: JSONRPCMessage) => void>();
  rawClient.onmessage = (m) => {
    const id = (m as { id?: string | number }).id;
    if (id === undefined) return;
    answers.set(id, m);
    waiters.get(id)?.(m);
  };
  const ask = (id: number, method: string, params: unknown): Promise<JSONRPCMessage> =>
    new Promise((resolve) => {
      waiters.set(id, resolve);
      void rawClient.send({ jsonrpc: '2.0', id, method, params } as JSONRPCMessage);
    });
  await Promise.all([rawServer.connect(rawServerSide), rawClient.start()]);
  await ask(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '0' } });
  await rawClient.send({ jsonrpc: '2.0', method: 'notifications/initialized' } as JSONRPCMessage);
  const first = await ask(7, 'tools/call', { name: 'weir_price', arguments: base });
  const second = await ask(7, 'tools/call', { name: 'weir_price', arguments: base });
  check('the same request id replayed reaches the port once, and both answers carry one idempotencyKey', () => {
    assert.equal(replayPort.priced.length, 1, JSON.stringify(replayPort.priced));
    const keyOf = (m: JSONRPCMessage) => ((m as { result?: { structuredContent?: { idempotencyKey?: string } } }).result?.structuredContent?.idempotencyKey);
    assert.ok(keyOf(first));
    assert.equal(keyOf(first), keyOf(second));
  });
  await rawClient.close();

  console.log('=== weir_post teaches the order ===');
  const noPrice = await client.callTool({ name: 'weir_post', arguments: { handle: 'kaela', title: 'T', preview: 'p', text: 'body', access: 'paid' } });
  check('paid without a price → unpriced, next: weir_price, nothing posted', () => {
    assert.equal(noPrice.isError, true);
    const parsed = JSON.parse(textOf(noPrice)) as { reason: string; next?: { tool: string } };
    assert.equal(parsed.reason, 'unpriced');
    assert.equal(parsed.next?.tool, 'weir_price');
    assert.equal(port.posted.length, 0);
  });
  port.postRefusesUnpriced = true;
  const unpriced = await client.callTool({ name: 'weir_post', arguments: { handle: 'kaela', title: 'T', preview: 'p', text: 'body', access: 'paid', contentKey: 'chapter-1', price: '250000' } });
  check("the route's 409 for an unpriced key → unpriced with the route's sentence, next: weir_price", () => {
    assert.equal(unpriced.isError, true);
    const parsed = JSON.parse(textOf(unpriced)) as { reason: string; detail: string; next?: { tool: string } };
    assert.equal(parsed.reason, 'unpriced');
    assert.ok(parsed.detail.includes('has no price on this vault'), parsed.detail);
    assert.equal(parsed.next?.tool, 'weir_price');
  });

  console.log('=== the marker ===');
  // The web application is not part of the published tree. Absent, this pin is reported as not
  // verified here rather than failed: the monorepo runs it on every commit.
  const webPricing = join(import.meta.dirname, '..', '..', 'web', 'lib', 'machine-pricing.ts');
  if (existsSync(webPricing)) {
    check("is the web's, read from its source — the one source every copy is pinned to", () => {
      const src = readFileSync(webPricing, 'utf8');
      const m = /export const MACHINE_EDITION_MARKER = '([^']+)';/.exec(src);
      assert.equal(MACHINE_EDITION_MARKER, m?.[1]);
    });
  } else {
    console.log("  skip  the web's marker source is not in this tree — pin NOT verified here (the monorepo verifies it)");
  }

  console.log(`${checks - failures}/${checks} checks passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
  await client.close();
  await none.client.close();
  await noPolicy.client.close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
