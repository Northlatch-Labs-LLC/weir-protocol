// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The server binds the AGENT, not the envelope the agent arrived in.
 *
 * # What this proves
 *
 * `createAgent` returns a `Reading<Agent>`. The binding used to check only that the answer was an
 * object — and both answers are. A success is `{ ok: true, value: … }`, a refusal is
 * `{ ok: false, failure: … }`, and neither carries `feed`, `quote`, `unlock` or any other method.
 *
 * `capabilitiesOf` decides what this server can do by asking `typeof port[name] === 'function'` for
 * each capability. Given an envelope, every one of those answers false.
 *
 * So the server started, announced itself, and registered ZERO TOOLS — on the success path as much
 * as the failure path. It did not crash and it did not warn, because a server with no tools is a
 * valid server. This is the only test in this package that touches that path; there was none
 * before, which is why it survived.
 */

import assert from 'node:assert/strict';
import { agentFromReading, capabilitiesOf, StartupRefusal, type WeirPort } from '../src/transport.js';

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

/** An agent with one method, which is all `capabilitiesOf` needs to report a capability. */
const agent: WeirPort = {
  quote: async () => ({ vaultId: '0x1', contentKey: 'k', priceMist: '1', coinType: '0x2::sui::SUI' }) as never,
};

function main(): void {
  check('unwraps a success to the agent itself, not the envelope', () => {
    const port = agentFromReading({ ok: true, value: agent });
    assert.equal(typeof port.quote, 'function', 'the bound port has no methods');
  });

  check('the unwrapped agent reports its capabilities', () => {
    /*
      The assertion the old code would have failed. Binding the envelope produced a port whose every
      capability check answered false, and an empty capability set registers no tools at all.
    */
    const port = agentFromReading({ ok: true, value: agent });
    const caps = capabilitiesOf({ port, signer: { kind: 'none' }, policyAvailable: false } as never);
    assert.ok(caps.has('quote'), 'a bound agent reported no capabilities');
  });

  check('binding the ENVELOPE would report none — the defect, stated', () => {
    // Not asserting on production code: this is what the old cast produced, kept so the reason the
    // unwrap exists is visible rather than remembered.
    const envelope = { ok: true, value: agent } as unknown as WeirPort;
    const caps = capabilitiesOf({ port: envelope, signer: { kind: 'none' }, policyAvailable: false } as never);
    assert.equal(caps.size, 0, 'the envelope somehow reported a capability');
  });

  check('a refusal is refused, not bound as an empty server', () => {
    assert.throws(
      () => agentFromReading({ ok: false, failure: { kind: 'malformed', detail: 'bad manifest' } }),
      StartupRefusal,
    );
  });

  check('the refusal carries the reason the agent gave', () => {
    try {
      agentFromReading({ ok: false, failure: { kind: 'malformed', detail: 'bad manifest' } });
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(
        error instanceof Error && error.message.includes('bad manifest'),
        'the operator is told a refusal happened but not why',
      );
    }
  });

  check('a refusal with no detail still refuses', () => {
    assert.throws(() => agentFromReading({ ok: false }), StartupRefusal);
  });

  for (const [name, value] of [
    ['a bare object', {}],
    ['null', null],
    ['a string', 'agent'],
    ['an agent passed unwrapped by mistake', agent],
  ] as const) {
    check(`refuses ${name} rather than binding it`, () => {
      assert.throws(() => agentFromReading(value), StartupRefusal);
    });
  }

  console.log(`\n${checks - failures}/${checks} checks passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main();
