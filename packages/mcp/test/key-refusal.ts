// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>

/**
 * The key never reaches the log, run rather than argued.
 *
 * # What this proves
 *
 * `openWeir` decodes the operator's private key. The decode is the only place in this package that
 * can fail while holding key material, and the library it calls puts the WHOLE INPUT into its
 * error message: `decodeSuiPrivateKey` reaches bech32, which throws `Invalid checksum in <value>`.
 * That error is not a `StartupRefusal`, so it travels to the top-level handler in `index.ts`, which
 * writes `error.message` to stderr — into whatever collects stderr.
 *
 * The prefix check in `resolveOptions` does not cover this. It accepts anything starting
 * `suiprivkey1`, so a key that is mistyped by one character, or truncated by a shell or an `.env`
 * edit, clears that gate and fails at the decode. Both of those values are key material: a prefix
 * of a private key is still a prefix of a private key.
 *
 * # Both directions, because one is not a test
 *
 * A guard that refuses everything passes a leak test and breaks the product. So this asserts the
 * negative direction too: a VALID key must still decode, and must not produce the refusal. The
 * valid key is generated here, in memory, and is nobody's — it is never written down.
 *
 * # What it deliberately does not do
 *
 * It never prints the key, on either path. A test that proves a value is absent from a log, by
 * printing that value, has moved the leak rather than closed it. Assertions report the property,
 * never the operand.
 */

import assert from 'node:assert/strict';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { ENV, openWeir, StartupRefusal } from '../src/transport.js';

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

/** The options `openWeir` needs, with the key as the only variable under test. */
function optionsWith(secretKey: string | null): Parameters<typeof openWeir>[0] {
  return {
    mode: 'stdio',
    baseUrl: 'https://weir.social',
    secretKey,
    policyPath: null,
    httpHost: '127.0.0.1',
    httpPort: 0,
    allowedOrigins: [],
    allowedHosts: [],
    agentEnvironment: {},
  };
}

async function messageFrom(secretKey: string): Promise<{ thrown: unknown; message: string }> {
  try {
    await openWeir(optionsWith(secretKey));
    return { thrown: null, message: '' };
  } catch (error) {
    return { thrown: error, message: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  /*
    Prefixed so it clears `resolveOptions`, and checksum-invalid so it fails at the decode — the
    exact shape of a mistyped or truncated key. It is filler, not anybody's key.
  */
  const undecodable = `suiprivkey1${'q'.repeat(59)}`;

  const bad = await messageFrom(undecodable);

  check('an undecodable key is refused', () => {
    assert.ok(bad.thrown !== null, 'openWeir returned instead of refusing');
  });

  /*
    Guards against a vacuous pass. If the agent package cannot load, `openWeir` refuses earlier and
    every assertion below would hold for the wrong reason. That is a failure of this test, not a
    property of the code, and it must say so rather than go green.
  */
  check('the refusal came from the key decode, not an earlier gate', () => {
    assert.ok(
      !bad.message.includes('could not be loaded'),
      'the agent package failed to load, so this test never reached the key decode',
    );
    assert.ok(
      bad.message.includes(ENV.key),
      'the refusal does not name the key variable, so it is not the decode refusal',
    );
  });

  check('the refusal is a StartupRefusal', () => {
    assert.ok(bad.thrown instanceof StartupRefusal, 'refused, but not with the startup type');
  });

  check('the refusal does not contain the key', () => {
    assert.ok(!bad.message.includes(undecodable), 'the whole key appears in the refusal');
  });

  /*
    The whole-value check alone would pass against a message quoting all but the last character.
    Any run this long out of a bech32 key is key material.
  */
  check('the refusal contains no 16-character run of the key', () => {
    const runs: string[] = [];
    for (let i = 0; i + 16 <= undecodable.length; i += 1) runs.push(undecodable.slice(i, i + 16));
    const leaked = runs.filter((run) => bad.message.includes(run));
    assert.equal(leaked.length, 0, `${leaked.length} run(s) of the key appear in the refusal`);
  });

  /*
    The negative direction. A generated key, held only in memory. `openWeir` may still refuse for a
    later reason — the agent stub is not bound here — but it must not refuse at the decode.
  */
  const valid = new Ed25519Keypair().getSecretKey();
  const good = await messageFrom(valid);

  check('a valid key is not refused by the decode', () => {
    assert.ok(
      !good.message.includes('could not be decoded'),
      'a well-formed key was rejected as undecodable',
    );
  });

  check('a valid key never appears in any refusal either', () => {
    assert.ok(!good.message.includes(valid), 'a valid key appears in an error message');
  });

  console.log(`\n${checks - failures}/${checks} checks passed, ${failures} failed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error('harness crashed:', error);
  process.exitCode = 1;
});
