// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The seam between `@projectx-social/agent` and the tools, crossed by a KEYED agent.
 *
 * Every defect this file guards sat between two green test suites: the agent's tests proved its
 * `Reading`s, the tools' tests proved their handling of a stub port, and nothing ever put a real
 * agent shape under a real tool. This harness does: a stub with the agent library's exact
 * signatures and envelopes, bound through `agentFromReading` (the production path), driven through
 * the registered tools over an in-memory MCP transport.
 *
 * Mutations, predicted before the first run:
 *   M1 `portFromAgent` passes `ceiling` through untouched → "buy carries maxPrice" goes red.
 *   M2 `unwrap` returns `reading.value` without checking `ok` → "a refused publish is a refusal"
 *      and "a refused buy is a refusal" go red (postId undefined, txDigest undefined).
 *   M3 `fromThrown` loses the `PortRefusal` branch → the two refusal tests go red on `reason`.
 *   M4 `agentFromReading` returns the agent itself (the old cast) → "quote is JSON" goes red:
 *      a bigint inside an envelope cannot be serialised.
 */
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import { agentFromReading, capabilitiesOf, type Signer, type WeirBinding } from '../src/transport.js';
import { PortRefusal, currencyOf, portFromAgent } from '../src/agent-port.js';

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
const USDC = `${hex('d')}::usdc::USDC`;
const ok = <T,>(value: T) => ({ ok: true as const, value });
const refused = (kind: string, source: string, detail: string) => ({ ok: false as const, failure: { kind, source, detail } });

/** The agent library's shapes, exactly: `Reading` envelopes, `bigint` prices, `Executed.digest`. */
class StubAgent {
  readonly address = hex('f');
  readonly manifest = { coinType: USDC };
  readonly calls: Array<{ method: string; input: unknown }> = [];
  refuseUnlock: ReturnType<typeof refused> | null = null;
  refusePost: ReturnType<typeof refused> | null = null;
  price = 250_000n;

  async quote(input: { vaultId: string; contentKey: string }) {
    this.calls.push({ method: 'quote', input });
    return ok({ ...input, coinType: USDC, priceMinorUnits: this.price, owner: hex('c'), accepting: true, observedAtMs: 1 });
  }
  async balance() {
    this.calls.push({ method: 'balance', input: null });
    return ok(9_000_000n);
  }
  async unlock(input: { vaultId: string; contentKey: string; priceMinorUnits: bigint; maxPrice: bigint }) {
    this.calls.push({ method: 'unlock', input });
    return this.refuseUnlock ?? ok({ digest: 'D-unlock', simulation: {} });
  }
  async subscribe(input: { vaultId: string; tierIndex: number; maxPrice: bigint }) {
    this.calls.push({ method: 'subscribe', input });
    return ok({ digest: 'D-sub', simulation: {} });
  }
  async post(input: Record<string, unknown>) {
    this.calls.push({ method: 'post', input });
    return this.refusePost ?? ok({ postId: 'p-1' });
  }
  async send(input: Record<string, unknown>) {
    this.calls.push({ method: 'send', input });
    return ok({ sent: true as const });
  }
  async priceContent(input: { vaultId: string; contentKey: string; edition?: string; price: bigint }) {
    this.calls.push({ method: 'priceContent', input });
    return ok({ digest: 'D-price', simulation: {} });
  }
  async machineBody() {
    return ok('no-post' as const);
  }
  async feed() {
    return ok({ posts: [], truncated: false, nextCursor: null });
  }
}

const signer: Signer = { address: hex('f'), scheme: 'ed25519', signPersonalMessage: async () => ({}), signTransaction: async () => ({}) };

async function connect(binding: WeirBinding): Promise<{ client: Client; registered: string[] }> {
  const server = new McpServer({ name: 'weir-mcp', version: '1.0.0', title: 'weir.social' });
  const registered = registerTools(server, binding);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'agent-port-harness', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, registered };
}

const textOf = (r: unknown): string => ((r as { content?: { text?: string }[] }).content ?? []).map((b) => b.text ?? '').join('');
const parsed = (r: unknown): Record<string, unknown> => JSON.parse(textOf(r)) as Record<string, unknown>;

async function main(): Promise<void> {
  console.log('=== the shape, without a transport ===');
  check('currencyOf names the two coins and refuses a third', () => {
    assert.equal(currencyOf('0x2::sui::SUI'), 'SUI');
    assert.equal(currencyOf(USDC), 'USDC');
    assert.throws(() => currencyOf(`${hex('e')}::usdt::USDT`), (e: unknown) => e instanceof PortRefusal && e.kind === 'unconfigured');
  });
  check('a keyless agent (quote + feed only) binds a port with no spending method', () => {
    const port = portFromAgent({ quote: async () => ok({}), feed: async () => ok({}) });
    assert.equal(typeof port.quote, 'function');
    assert.equal(typeof port.feed, 'function');
    assert.equal(port.unlock, undefined);
    assert.equal(port.post, undefined);
    const caps = capabilitiesOf({ port, signer: { kind: 'none' }, policyAvailable: false } as never);
    assert.ok(caps.has('quote') && !caps.has('buy'));
  });

  console.log('=== a keyed agent through the production binding and the real tools ===');
  const agent = new StubAgent();
  const port = agentFromReading(ok(agent));
  const { client, registered } = await connect({ port, signer: { kind: 'signing', signer }, policyAvailable: true });
  check('readPreview binds as read-preview and passes null (exists, not entitled) through untouched', () => {
    const bound = portFromAgent({ readPreview: async () => ok(null) });
    assert.equal(typeof bound.readPreview, 'function');
    const caps = capabilitiesOf({ port: bound, signer: { kind: 'none' }, policyAvailable: false } as never);
    assert.ok(caps.has('read-preview'));
  });
  {
    const bound = portFromAgent({ readPreview: async () => refused('not-found', 'readPreview', 'no such post') });
    let thrown: unknown = null;
    try {
      await bound.readPreview!({ postId: 'p' });
    } catch (error) {
      thrown = error;
    }
    check('a refused readPreview crosses the seam as a PortRefusal with its kind', () => {
      assert.ok(thrown instanceof PortRefusal && thrown.kind === 'not-found', String(thrown));
    });
  }
  check('the spending tools register for a keyed agent', () =>
    assert.ok(['weir_buy', 'weir_subscribe', 'weir_post', 'weir_send', 'weir_price'].every((t) => registered.includes(t)), registered.join(', ')));

  const quote = await client.callTool({ name: 'weir_quote', arguments: { vaultId: VAULT, contentKey: 'k' } });
  check('quote is JSON: the bigint became a decimal string and the coin became a currency', () => {
    assert.equal(quote.isError, undefined, textOf(quote));
    const q = parsed(quote);
    assert.equal(q['price'], '250000');
    assert.equal(q['currency'], 'USDC');
    assert.equal(q['ok'], undefined, 'an envelope leaked through');
  });

  const balance = await client.callTool({ name: 'weir_balance', arguments: {} });
  check('balance names the address, the amount as a string, the currency', () => {
    const b = parsed(balance);
    assert.equal(b['address'], hex('f'));
    assert.equal(b['spendable'], '9000000');
    assert.equal(b['currency'], 'USDC');
  });

  const buy = await client.callTool({ name: 'weir_buy', arguments: { vaultId: VAULT, contentKey: 'k', maxPrice: '300000', currency: 'USDC' } });
  check('buy carries maxPrice to the agent and the quoted price as its expectation', () => {
    assert.equal(buy.isError, undefined, textOf(buy));
    const call = agent.calls.find((c) => c.method === 'unlock')?.input as { maxPrice: bigint; priceMinorUnits: bigint };
    assert.equal(call.maxPrice, 300_000n);
    assert.equal(call.priceMinorUnits, 250_000n);
    const r = parsed(buy);
    assert.equal(r['txDigest'], 'D-unlock');
    assert.equal(r['pricePaid'], '250000');
    assert.equal(r['unlockObjectId'], null);
  });

  const wrongCoin = await client.callTool({ name: 'weir_buy', arguments: { vaultId: VAULT, contentKey: 'k', maxPrice: '300000', currency: 'SUI' } });
  check('a ceiling in the wrong coin is refused before the agent is asked to buy', () => {
    assert.equal(wrongCoin.isError, true);
    const r = parsed(wrongCoin) as { reason: string; failure: { kind: string } };
    assert.equal(r.reason, 'refused');
    assert.equal(r.failure.kind, 'precondition');
    assert.equal(agent.calls.filter((c) => c.method === 'unlock').length, 1, 'the agent was asked to buy in the wrong coin');
  });

  agent.refuseUnlock = refused('precondition', 'guardPrice', 'live price 400000 is above maxPrice 300000');
  const over = await client.callTool({ name: 'weir_buy', arguments: { vaultId: VAULT, contentKey: 'k', maxPrice: '300000', currency: 'USDC' } });
  check('a refused buy is a refusal carrying the agent\'s own kind, never a receipt', () => {
    assert.equal(over.isError, true, textOf(over));
    const r = parsed(over) as { reason: string; failure: { kind: string; source: string }; txDigest?: unknown };
    assert.equal(r.reason, 'refused');
    assert.equal(r.failure.kind, 'precondition');
    assert.equal(r.failure.source, 'guardPrice');
    assert.equal(r.txDigest, undefined);
  });
  agent.refuseUnlock = null;

  const article = { handle: 'kaela', title: 't', preview: 'p', text: 'body', access: 'public' };
  const posted = await client.callTool({ name: 'weir_post', arguments: article });
  check('a publish that succeeded reports the postId the agent returned', () => {
    assert.equal(posted.isError, undefined, textOf(posted));
    assert.equal(parsed(posted)['postId'], 'p-1');
  });
  check('the tool\'s idempotency key reaches the agent, which sends it as the header', () => {
    const call = agent.calls.find((c) => c.method === 'post')?.input as { idempotencyKey?: string };
    assert.equal(typeof call.idempotencyKey, 'string');
    assert.ok(call.idempotencyKey!.length > 0);
    assert.equal(call.idempotencyKey, parsed(posted)['idempotencyKey']);
  });
  agent.refusePost = refused('permanent', 'publish', 'the vault refuses this handle');
  const notPosted = await client.callTool({ name: 'weir_post', arguments: article });
  check('a refused publish is a refusal — the false success is dead', () => {
    assert.equal(notPosted.isError, true, textOf(notPosted));
    const r = parsed(notPosted) as { reason: string; postId?: unknown; failure: { kind: string } };
    assert.equal(r.reason, 'refused');
    assert.equal(r.postId, undefined);
    assert.equal(r.failure.kind, 'permanent');
  });
  agent.refusePost = null;

  const priced = await client.callTool({ name: 'weir_price', arguments: { vaultId: VAULT, contentKey: 'k', price: '1000', currency: 'USDC' } });
  check('price reports the digest and hands the agent a bigint', () => {
    assert.equal(priced.isError, undefined, textOf(priced));
    assert.equal(parsed(priced)['txDigest'], 'D-price');
    const call = agent.calls.find((c) => c.method === 'priceContent')?.input as { price: bigint };
    assert.equal(call.price, 1000n);
  });

  const sent = await client.callTool({ name: 'weir_send', arguments: { to: 'bob', text: 'hello', preview: 'hi' } });
  check('send reports sent:true, which is all the agent can say', () => {
    assert.equal(sent.isError, undefined, textOf(sent));
    assert.equal(parsed(sent)['sent'], true);
  });

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
