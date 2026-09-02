// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * The agent is handed its environment — run, not argued.
 *
 * # What this proves
 *
 * `openWeir` used to pass `createAgent` a placeholder, `{ source: 'weir-mcp' }`, where the agent's
 * manifest loader expected the environment. The loader reads the six chain ids, the coin type and
 * the base URL from the record it is given and from nothing else, so it refused with "missing
 * required environment variables" whatever the operator had exported. Hosted keyless mode had never
 * started on any machine, and the refusal named the wrong cause.
 *
 * Three real starts of `--http`, each with more of the environment, assert that each variable is now
 * SEEN: the refusal moves from "the six are missing" to "the coin type is missing" to "the base URL
 * is missing", and with all eight set none of those three sentences appears.
 *
 * # The last assertion is a target, not a success
 *
 * With every variable set the process still stops, on the agent library's requirement for a
 * signing key (`createAgent` reads `key.address` at construction; hosted mode passes `null` by
 * design). That is the next change's job, in `packages/agent`. This harness pins the EXACT message
 * it stops on today so that change has a red test to turn green — when it lands, replace that
 * assertion with "listening on", and nothing else here moves.
 *
 * # The list is checked against its sources
 *
 * `AGENT_ENVIRONMENT` is a literal in this package. The names it must contain are exported by the
 * SDK (`REQUIRED_ENV`, `KEY_REGISTRY_ENV`) and by the agent (`AGENT_ENV`), so the two are compared
 * here: a variable added over there without being added here fails this file, and a name invented
 * here that neither package reads fails it too. The agent's secret is asserted ABSENT.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENT_ENVIRONMENT, agentEnvironment } from '../src/transport.js';
import { AGENT_ENV } from '../../agent/src/manifest.js';
import { KEY_REGISTRY_ENV, REQUIRED_ENV } from '../../sdk/src/config.js';

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

const here = join(import.meta.dirname, '..');
const id = (c: string) => `0x${c.repeat(64)}`;

/** The six the SDK requires. Shapes are valid; values are nobody's. */
const SIX: Record<string, string> = {
  PROJECTX_SOCIAL_NETWORK: 'mainnet',
  PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.example:443',
  PROJECTX_SOCIAL_PACKAGE_ID: id('1'),
  PROJECTX_SOCIAL_LATEST_PACKAGE_ID: id('2'),
  PROJECTX_SOCIAL_PLATFORM_ID: id('3'),
  PROJECTX_SOCIAL_REGISTRY_ID: id('4'),
};
const COIN = { PROJECTX_SOCIAL_AGENT_COIN_TYPE: `${id('5')}::usdc::USDC` };
const BASE = { PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social' };

const MISSING_SIX = 'missing required environment variables';
const MISSING_COIN = 'PROJECTX_SOCIAL_AGENT_COIN_TYPE is not set';
const MISSING_BASE = 'PROJECTX_SOCIAL_AGENT_BASE_URL is not set';
/** Where the process stops today with everything set. `packages/agent`'s target. */
const STOPS_ON_KEY = "Cannot read properties of null (reading 'address')";

/**
 * Start `--http` with exactly this environment and return what it said on stderr.
 *
 * A clean environment apart from PATH, so nothing the developer has exported can satisfy a variable
 * the case is meant to leave unset. A high port because 0 is refused and 8402 may be in use. The
 * timeout is the guard against the day this starts listening — which is the intended future — so a
 * green agent package cannot hang this harness; it is reported rather than waited on.
 */
function start(vars: Record<string, string>): { stderr: string; status: number | null } {
  const result = spawnSync('pnpm', ['exec', 'tsx', 'src/index.ts', '--http'], {
    cwd: here,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', WEIR_MCP_HTTP_PORT: '8497', ...vars },
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { stderr: result.stderr, status: result.status };
}

console.log('=== the list matches its sources ===');
check('every name the SDK requires is in AGENT_ENVIRONMENT', () => {
  for (const name of REQUIRED_ENV) assert.ok(AGENT_ENVIRONMENT.includes(name), name);
});
check("the agent's coin type and base URL are in AGENT_ENVIRONMENT", () => {
  assert.ok(AGENT_ENVIRONMENT.includes(AGENT_ENV.coinType));
  assert.ok(AGENT_ENVIRONMENT.includes(AGENT_ENV.baseUrl));
});
check('the optional key registry is in AGENT_ENVIRONMENT, and nothing else is', () => {
  const expected = new Set<string>([...REQUIRED_ENV, AGENT_ENV.coinType, AGENT_ENV.baseUrl, KEY_REGISTRY_ENV]);
  assert.deepEqual(new Set(AGENT_ENVIRONMENT), expected);
});
check("the agent's SECRET is not in the projection — keys travel as `keypair`, never as environment", () => {
  assert.ok(!(AGENT_ENVIRONMENT as readonly string[]).includes(AGENT_ENV.secret));
  const projected = agentEnvironment({ ...SIX, [AGENT_ENV.secret]: 'suiprivkey1notreal', UNRELATED: 'x', PROJECTX_SOCIAL_AGENT_COIN_TYPE: '  ' });
  assert.deepEqual(Object.keys(projected).sort(), Object.keys(SIX).sort());
});
check('the README documents every name in the projection', () => {
  const readme = readFileSync(join(here, 'README.md'), 'utf8');
  for (const name of AGENT_ENVIRONMENT) assert.ok(readme.includes(`\`${name}\``), name);
});

console.log('=== the agent sees what the operator exported ===');
const six = start(SIX);
check('with the six chain variables set, the refusal is no longer "missing required environment variables"', () => {
  assert.ok(!six.stderr.includes(MISSING_SIX), six.stderr);
});
check('…it is the coin type, the seventh, which the placeholder used to hide', () => {
  assert.ok(six.stderr.includes(MISSING_COIN), six.stderr);
  assert.equal(six.status, 78);
});
const seven = start({ ...SIX, ...COIN });
check('with the coin type set too, the refusal is the base URL, the eighth', () => {
  assert.ok(!seven.stderr.includes(MISSING_COIN), seven.stderr);
  assert.ok(seven.stderr.includes(MISSING_BASE), seven.stderr);
  assert.equal(seven.status, 78);
});
const eight = start({ ...SIX, ...COIN, ...BASE });
check('with all eight set, none of the three configuration refusals appears', () => {
  for (const sentence of [MISSING_SIX, MISSING_COIN, MISSING_BASE]) assert.ok(!eight.stderr.includes(sentence), eight.stderr);
});
check(`…and the keyless server LISTENS — the agent library's key requirement no longer stops it`, () => {
  // Until packages/agent gained its read-only construction path (2026-09-02) this asserted the
  // opposite: that the eight-variable start died on `Cannot read properties of null (reading
  // 'address')`, exit 1, because the agent could not exist without a key. That was the measured
  // truth then and the docblock above said this line would flip the day it changed. It changed:
  // the server now announces itself and keeps running, so `start()`'s 30-second timeout is what
  // ends it — a null status, not an exit code. The old sentence must be ABSENT, or the read-only
  // path has regressed to the old failure.
  assert.ok(eight.stderr.includes('listening on'), eight.stderr);
  assert.ok(eight.stderr.includes('(stateless, keyless)'), eight.stderr);
  assert.ok(!eight.stderr.includes(STOPS_ON_KEY), eight.stderr);
  assert.notEqual(eight.status, 78, 'a configuration refusal is not a start');
  assert.notEqual(eight.status, 1, 'the key requirement is not a start');
});

console.log(`${checks - failures}/${checks} checks passed, ${failures} failed`);
if (failures > 0) process.exitCode = 1;
