// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/*
  The policy document an operator hands this server, checked for the two things a wrong file
  would get past: shape, and whose policy it is.

  Mutation predicted: drop the address comparison → "another agent's policy is refused" red.
*/
import assert from 'node:assert/strict';
import { loadPolicyDoc, resolveOptions, ENV } from '../src/transport.js';

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

const ME = `0x${'f'.repeat(64)}`;
const doc = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    agentAddress: ME,
    outflowCeilings: [],
    allowedTargets: [],
    allowedTypeArguments: [],
    allowedRecipients: [],
    allowedObjects: [],
    maxGasBudgetMist: '10000000',
    ...over,
  });

function main(): void {
  check('a well-formed document for this signer is accepted', () => {
    const r = loadPolicyDoc(doc(), ME);
    assert.equal(r.ok, true, JSON.stringify(r));
  });
  check("another agent's policy is refused, case-insensitively on the address", () => {
    const r = loadPolicyDoc(doc({ agentAddress: `0x${'e'.repeat(64)}` }), ME);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, /different agentAddress/);
    assert.equal(loadPolicyDoc(doc({ agentAddress: ME.toUpperCase() }), ME).ok, true);
  });
  check('a document of another version, or missing a list, or not JSON, is refused with the reason', () => {
    assert.match((loadPolicyDoc(doc({ version: 2 }), ME) as { reason: string }).reason, /version/);
    assert.match((loadPolicyDoc(doc({ allowedObjects: undefined }), ME) as { reason: string }).reason, /allowedObjects/);
    assert.match((loadPolicyDoc('not json', ME) as { reason: string }).reason, /not JSON/);
  });
  check('WEIR_AGENT_POLICY is read only in stdio mode with a key, never under --http', () => {
    const base = { WEIR_BASE_URL: 'https://weir.social', PROJECTX_SOCIAL_NETWORK: 'mainnet' } as Record<string, string>;
    const http = resolveOptions(['--http'], { ...base, [ENV.policy]: '/tmp/policy.json' });
    assert.equal(http.policyPath, null);
    const stdioNoKey = resolveOptions(['--stdio'], { ...base, [ENV.policy]: '/tmp/policy.json' });
    assert.equal(stdioNoKey.policyPath, null);
  });

  console.log(`\n${checks} checks, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

main();
