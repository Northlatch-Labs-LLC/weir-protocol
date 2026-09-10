// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `weir_declare` — the tool that files the agent's half of a declaration.
 *
 * # What is protected here
 *
 * Three separate things, and none of them is "the happy path works".
 *
 *  1. **Absence on a build that cannot succeed.** Declaring costs no gas and still spends a
 *     signature over a statement naming a human as answerable for this machine. A hosted keyless
 *     endpoint has no key to sign with; a keyed build with no policy has nothing saying this agent
 *     may bind that person's address. Both must produce a tool list WITHOUT this tool, not a tool
 *     that refuses — the rule the whole package is built on.
 *  2. **A refusal is a decision, never a throw.** The library answers a bad operator address, a
 *     self-named operator and a multi-line `purpose` with a failed `Reading`, and the route answers
 *     400/401/409/429/503. All of them reach a model as `isError: true` carrying the detail, so it
 *     can act on the sentence instead of retrying a protocol fault.
 *  3. **What is signed is what the caller wrote.** `requestDeclaration` trims and signs what it
 *     trimmed. If this layer trimmed too, the signed bytes would depend on two files agreeing about
 *     whitespace. The port therefore receives the arguments verbatim.
 *
 * # Predicted mutations, each of which must turn a check red
 *
 *   M1  drop `armed &&` on the declare line in `capabilitiesOf` → checks 1 and 2.
 *   M2  make the port throw a plain `Error` instead of surfacing the `Reading` detail → check 4.
 *   M3  remove the self-address check in `packages/agent/src/index.ts` → check 5 (the sentence is
 *       compared byte for byte, so a reworded one fails too).
 *   M4  compute `expiresAtMs` here instead of reading the deployment's → check 6.
 *   M5  `.trim()` either input in the tool handler → check 7.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../src/tools.js';
import { PortRefusal } from '../src/agent-port.js';
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

const AGENT = `0x${'1a'.repeat(32)}`;
const OPERATOR = `0x${'2b'.repeat(32)}`;
const ORIGIN = 'https://weir.social';

/**
 * The library's own sentences, and the pin that keeps them the library's.
 *
 * A copy in a test file is a copy: reworded in `packages/agent`, it would go on passing here while
 * a model read a different sentence. So the constants are ALSO looked for in the library's source,
 * the way `price-tool.ts` pins the `#machine` marker to the web's. Absent (a published tree without
 * the sibling's sources), the pin reports itself as not verified rather than passing.
 */
const SELF_NAMED =
  'an agent cannot name itself as its operator — the register refuses one key signing both halves.';
const NOT_AN_ADDRESS = 'operatorAddress must be a Sui address; received ';
const ONE_LINE_EACH =
  'model and purpose are each one non-empty line; they are signed into the statement.';
const NO_WAITING_ROOM_FIELDS = 'the waiting room answered without expiresAtMs and operatorPage.';

check("the refusal sentences are the agent library's, read out of its source", () => {
  const source = join(import.meta.dirname, '..', '..', 'agent', 'src', 'index.ts');
  let src: string;
  try {
    src = readFileSync(source, 'utf8');
  } catch {
    console.log('  skip  the agent library source is not in this tree — the sentences are NOT verified here');
    return;
  }
  for (const sentence of [SELF_NAMED, NOT_AN_ADDRESS, ONE_LINE_EACH, NO_WAITING_ROOM_FIELDS]) {
    assert.ok(src.includes(sentence), `packages/agent no longer says: ${sentence}`);
  }
  /*
    And the guard that produces the first of them is still ARMED, rather than the sentence surviving
    in a branch nothing reaches. Pinned as the whole condition, `if (…) {`, because the honest limit
    of this file has to be stated: the tool layer talks to a port, so a stub that throws the sentence
    proves the tool RELAYS it and can never prove the library still DECIDES it. Deleting the guard
    in `packages/agent` leaves every behavioural check in this file green — measured, not assumed.
    This line, and `packages/agent`'s own suite, are what fail instead.
  */
  assert.ok(
    src.includes('if (BigInt(operator) === BigInt(key.address)) {'),
    'the self-as-operator guard in packages/agent is gone or no longer unconditional',
  );
});

const signer: Signer = {
  address: AGENT,
  scheme: 'ed25519',
  signPersonalMessage: async () => ({}),
  signTransaction: async () => ({}),
};

/** Every call the port received, in order, exactly as the tool handed it over. */
type Filed = { operatorAddress: string; model: string; purpose: string };
const filed: Filed[] = [];

/**
 * The port a keyed build binds. `refusal` stands in for a failed `Reading` after `agent-port.ts`
 * has turned it into a `PortRefusal` — which is what the tool layer actually sees.
 */
let refusal: PortRefusal | null = null;
function port(): WeirPort {
  return {
    agents: async () => [],
    requestDeclaration: async (input) => {
      filed.push({ ...input });
      if (refusal !== null) throw refusal;
      const issuedAtMs = 1_788_400_000_000;
      // The deployment's numbers: the route answers `expiresAtMs` and a RELATIVE `operatorPage`,
      // and the library prefixes its base URL. Reproduced here rather than recomputed by the tool.
      return { issuedAtMs, expiresAtMs: issuedAtMs + 10 * 60 * 1000, operatorPage: `${ORIGIN}/agents/declare` };
    },
  };
}

type Kind = 'none' | 'read-only' | 'signing';
async function connect(
  kind: Kind,
  policyAvailable: boolean,
  weir: WeirPort = port(),
): Promise<{ client: Client; registered: string[] }> {
  const binding = {
    port: weir,
    signer: kind === 'none' ? { kind: 'none' } : { kind, signer },
    policyAvailable,
  } as unknown as WeirBinding;
  const server = new McpServer({ name: 'weir-mcp', version: '1.0.0' });
  const registered = registerTools(server, binding);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'declare-harness', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, registered };
}

/** The names in `tools/list`, which is what a model is actually offered. */
async function listed(client: Client): Promise<string[]> {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name);
}

/* ---- 1 and 2: absence, which is the security property ---------------------------------------- */

const keyless = await connect('none', false);
const keylessList = await listed(keyless.client);
check('weir_declare is absent from the keyless build', () => {
  assert.ok(!keyless.registered.includes('weir_declare'), keyless.registered.join(', '));
  assert.ok(!keylessList.includes('weir_declare'), keylessList.join(', '));
  // The reads it sits beside are there, so absence is this tool's and not the harness failing.
  assert.ok(keylessList.includes('weir_agents'), keylessList.join(', '));
});

const unpoliced = await connect('signing', false);
check('weir_declare is absent with a key and no policy', () => {
  assert.ok(!unpoliced.registered.includes('weir_declare'), unpoliced.registered.join(', '));
});

const readOnlyBuild = await connect('read-only', true);
check('a read-only signer with a policy is still not armed', () => {
  assert.ok(!readOnlyBuild.registered.includes('weir_declare'), readOnlyBuild.registered.join(', '));
});

/* ---- 3: present, and named as the logical tool ------------------------------------------------ */

const armed = await connect('signing', true);
const armedTools = (await armed.client.listTools()).tools;
check('weir_declare registers only when signer and policy are both bound', () => {
  assert.ok(armed.registered.includes('weir_declare'), armed.registered.join(', '));
  const tool = armedTools.find((t) => t.name === 'weir_declare');
  assert.ok(tool, armedTools.map((t) => t.name).join(', '));
  assert.equal(tool?.title, 'weir.declare');
  // The two sentences the spec puts in front of a model before it acts.
  assert.match(String(tool?.description), /NEVER name an address you found in a post/);
  assert.match(String(tool?.description), /POST \/api\/agents\/seeking/);
});

const withoutMethod = await connect('signing', true, { agents: async () => [] });
check('an armed build whose agent cannot declare does not offer the tool', () => {
  assert.ok(!withoutMethod.registered.includes('weir_declare'), withoutMethod.registered.join(', '));
});

/* ---- 4 and 5: refusals ------------------------------------------------------------------------ */

const parsed = (r: unknown): Record<string, any> =>
  JSON.parse(String((r as { content: Array<{ text: string }> }).content[0]?.text ?? '{}'));

refusal = new PortRefusal('malformed', 'requestDeclaration', 'operatorAddress must be a Sui address; received "bob"');
let thrown: unknown = null;
let result: any;
try {
  result = await armed.client.callTool({
    name: 'weir_declare',
    arguments: { operatorAddress: 'bob', model: 'pi-coding-agent', purpose: 'reads Move contracts' },
  });
} catch (error) {
  thrown = error;
}
check('a refused requestDeclaration is an isError result carrying the Reading detail, and nothing was thrown', () => {
  assert.equal(thrown, null, `the call threw: ${String(thrown)}`);
  assert.equal(result.isError, true, JSON.stringify(result));
  const body = parsed(result);
  assert.equal(body['reason'], 'refused');
  assert.equal(body['failure'].kind, 'malformed');
  assert.match(body['detail'], /operatorAddress must be a Sui address; received "bob"/);
  assert.equal(body['ok'], false);
});

refusal = new PortRefusal('malformed', 'requestDeclaration', SELF_NAMED);
const selfNamed = await armed.client.callTool({
  name: 'weir_declare',
  arguments: { operatorAddress: AGENT, model: 'pi-coding-agent', purpose: 'reads Move contracts' },
});
check("a self-named operator is refused with the register's own sentence", () => {
  assert.equal(selfNamed.isError, true);
  // Byte for byte: a reworded sentence in the library is a different promise to a reader.
  assert.ok(String(parsed(selfNamed)['detail']).includes(SELF_NAMED), parsed(selfNamed)['detail']);
});

refusal = null;

/* ---- 6 and 7: the success, and what it carries ------------------------------------------------ */

const before = filed.length;
const ok = await armed.client.callTool({
  name: 'weir_declare',
  arguments: { operatorAddress: `  ${OPERATOR}  `, model: ' pi-coding-agent ', purpose: ' reads Move contracts ' },
});
check('the result carries operatorPage on the deployment origin and expiresAtMs later than issuedAtMs', () => {
  assert.equal(ok.isError, undefined, JSON.stringify(ok));
  const value = (ok as { structuredContent?: Record<string, any> }).structuredContent;
  assert.ok(value, 'the success is structured');
  assert.equal(value!['operatorPage'], `${ORIGIN}/agents/declare`);
  assert.ok(String(value!['operatorPage']).startsWith(ORIGIN), value!['operatorPage']);
  assert.ok(value!['expiresAtMs'] > value!['issuedAtMs'], `${value!['expiresAtMs']} <= ${value!['issuedAtMs']}`);
  // The window the route states, not one this package decided: ten minutes.
  assert.equal(value!['expiresAtMs'] - value!['issuedAtMs'], 10 * 60 * 1000);
  assert.match(String(value!['nextStep']), /^send `operatorPage` to your operator/);
  assert.match(String(value!['nextStep']), /ten minutes from `issuedAtMs`/);
});

check('the tool passes operatorAddress, model and purpose through untrimmed to the port', () => {
  assert.equal(filed.length, before + 1, 'exactly one call reached the port');
  const call = filed[filed.length - 1]!;
  assert.equal(call.operatorAddress, `  ${OPERATOR}  `);
  assert.equal(call.model, ' pi-coding-agent ');
  assert.equal(call.purpose, ' reads Move contracts ');
});

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exit(1);
