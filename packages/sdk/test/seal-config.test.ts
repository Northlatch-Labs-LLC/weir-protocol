// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Seal deployment configuration.
 *
 * # Why every one of these is a failure test
 *
 * The cost of a wrong value here is asymmetric in a way that is worth stating. A missing key server
 * or a threshold nobody meant produces content encrypted to a committee that cannot or will not
 * reconstruct the key — and by the time anybody notices, the ciphertext is on Walrus, the plaintext
 * is gone, and there is no recovery. That is unlike the rest of this SDK, where a bad value
 * produces a failed transaction and a retry.
 *
 * So the loader has no defaults and no lenience, and this suite exists to prove the absence rather
 * than to exercise the happy path.
 */

import { describe, expect, it } from 'vitest';
import { loadSealConfig, SEAL_ENV } from '../src/index.js';

const SERVER_A = `0x${'11'.repeat(32)}`;
const SERVER_B = `0x${'22'.repeat(32)}`;
const SERVER_C = `0x${'33'.repeat(32)}`;

function env(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
  return {
    [SEAL_ENV.keyServers]: `${SERVER_A},${SERVER_B}`,
    [SEAL_ENV.threshold]: '2',
    ...overrides,
  };
}

describe('loading the key server committee', () => {
  it('reads a plain comma-separated list, weighting each server once', () => {
    const config = loadSealConfig(env({}));
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.keyServers).toEqual([
      { objectId: SERVER_A, weight: 1 },
      { objectId: SERVER_B, weight: 1 },
    ]);
    expect(config.value.threshold).toBe(2);
  });

  it('reads weights and aggregator urls when they are given', () => {
    const config = loadSealConfig(
      env({
        [SEAL_ENV.keyServers]: `${SERVER_A}|2|https://aggregator.example, ${SERVER_B}|1`,
        [SEAL_ENV.threshold]: '3',
      }),
    );
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.keyServers).toEqual([
      { objectId: SERVER_A, weight: 2, aggregatorUrl: 'https://aggregator.example' },
      { objectId: SERVER_B, weight: 1 },
    ]);
  });

  it('leaves aggregatorUrl absent rather than empty for an independent server', () => {
    // The Seal SDK distinguishes committee-mode servers from independent ones by whether this is
    // set. An empty string is set.
    const config = loadSealConfig(env({ [SEAL_ENV.keyServers]: `${SERVER_A}||`, [SEAL_ENV.threshold]: '1' }));
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect('aggregatorUrl' in config.value.keyServers[0]!).toBe(false);
  });
});

describe('an unset or malformed value fails at load, naming the variable', () => {
  it('names the key server variable when it is unset', () => {
    const config = loadSealConfig(env({ [SEAL_ENV.keyServers]: undefined }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.kind).toBe('unconfigured');
    expect(config.failure.detail).toContain(SEAL_ENV.keyServers);
  });

  it('names the key server variable when it is blank', () => {
    const config = loadSealConfig(env({ [SEAL_ENV.keyServers]: '   ' }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain(SEAL_ENV.keyServers);
  });

  it('names the threshold variable when it is unset', () => {
    const config = loadSealConfig(env({ [SEAL_ENV.threshold]: undefined }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.kind).toBe('unconfigured');
    expect(config.failure.detail).toContain(SEAL_ENV.threshold);
  });

  it('refuses an object id that is not a full 32-byte id', () => {
    // `0x1234` resolves to nothing at runtime and surfaces as an opaque "object does not exist"
    // a long way from the typo.
    const config = loadSealConfig(env({ [SEAL_ENV.keyServers]: '0x1234' }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain('0x1234');
  });

  it('refuses the whole list when one entry is malformed, rather than dropping that entry', () => {
    /*
      The important half of this suite.

      A dropped key server changes the committee content is encrypted to and still appears to work.
      Refusing the list makes the typo visible while it is still only a typo.
    */
    const config = loadSealConfig(env({ [SEAL_ENV.keyServers]: `${SERVER_A},oops,${SERVER_B}` }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain('oops');
  });

  it('refuses a duplicated key server', () => {
    // The Seal SDK throws InvalidClientOptionsError on duplicates, so collapsing them here would
    // turn a configuration mistake into a runtime crash far from the variable.
    const config = loadSealConfig(env({ [SEAL_ENV.keyServers]: `${SERVER_A},${SERVER_A}` }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain('twice');
  });

  it('refuses a non-http aggregator url', () => {
    const config = loadSealConfig(
      env({ [SEAL_ENV.keyServers]: `${SERVER_A}|1|aggregator.example` }),
    );
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain('aggregator.example');
  });

  it.each(['0', '-1', '1.5', 'two', ''])('refuses a weight of "%s"', (weight) => {
    const config = loadSealConfig(
      env({ [SEAL_ENV.keyServers]: `${SERVER_A}|${weight}`, [SEAL_ENV.threshold]: '1' }),
    );
    // An empty weight is the one that is allowed — `0x..|` means "no weight given", which is one.
    if (weight === '') {
      expect(config.ok).toBe(true);
      return;
    }
    expect(config.ok).toBe(false);
  });

  it.each(['0', '-1', '1.5', 'two'])('refuses a threshold of "%s"', (threshold) => {
    const config = loadSealConfig(env({ [SEAL_ENV.threshold]: threshold }));
    expect(config.ok).toBe(false);
  });

  it('refuses a threshold no committee could ever meet', () => {
    /*
      Checked against total weight, not entry count.

      `SealClient.encrypt` would refuse this too, but only at the first upload — by which point the
      operator has already told creators their media is protected. Failing at load moves that
      discovery to deployment.
    */
    const config = loadSealConfig(
      env({ [SEAL_ENV.keyServers]: `${SERVER_A},${SERVER_B}`, [SEAL_ENV.threshold]: '3' }),
    );
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain('total weight of 2');
  });

  it('allows a threshold that weights make reachable', () => {
    const config = loadSealConfig(
      env({ [SEAL_ENV.keyServers]: `${SERVER_A}|2,${SERVER_B}`, [SEAL_ENV.threshold]: '3' }),
    );
    expect(config.ok).toBe(true);
  });

  it('refuses a list of nothing but separators', () => {
    const config = loadSealConfig(env({ [SEAL_ENV.keyServers]: ',,,' }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain('names no key server');
  });

  it('tolerates whitespace around entries, because a pasted list carries it', () => {
    const config = loadSealConfig(
      env({ [SEAL_ENV.keyServers]: `  ${SERVER_A} ,\t${SERVER_B} , ${SERVER_C} `, [SEAL_ENV.threshold]: '2' }),
    );
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect(config.value.keyServers.map((s) => s.objectId)).toEqual([SERVER_A, SERVER_B, SERVER_C]);
  });
});

describe('credentials for a permissioned committee', () => {
  /*
    There are no open key servers on Sui mainnet. Every provider requires enrolment and issues an
    API key, so a mainnet deployment that cannot express one cannot use Seal at all.
  */
  it('attaches the credential to every configured server', () => {
    const config = loadSealConfig(
      env({
        [SEAL_ENV.apiKeyName]: 'X-API-Key',
        [SEAL_ENV.apiKey]: 'not-a-real-credential',
      }),
    );
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    for (const server of config.value.keyServers) {
      expect(server.apiKeyName).toBe('X-API-Key');
      expect(server.apiKey).toBe('not-a-real-credential');
    }
  });

  it('leaves both absent for open servers, rather than setting them empty', () => {
    // The Seal SDK refuses a config where one is present and the other is not, so "" is not a
    // neutral value.
    const config = loadSealConfig(env({}));
    expect(config.ok).toBe(true);
    if (!config.ok) return;
    expect('apiKey' in config.value.keyServers[0]!).toBe(false);
    expect('apiKeyName' in config.value.keyServers[0]!).toBe(false);
  });

  it('refuses a credential with no header name', () => {
    const config = loadSealConfig(env({ [SEAL_ENV.apiKey]: 'not-a-real-credential' }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain(SEAL_ENV.apiKeyName);
  });

  it('refuses a header name with no credential', () => {
    const config = loadSealConfig(env({ [SEAL_ENV.apiKeyName]: 'X-API-Key' }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).toContain(SEAL_ENV.apiKey);
  });

  it('never puts the credential in a failure message', () => {
    /*
      The one property here that is about safety rather than correctness.

      A configuration error that quotes the value it read is how a credential reaches a log
      aggregator, and configuration errors are exactly the lines people paste into chat.
    */
    const secret = 'super-secret-credential-value';
    const config = loadSealConfig(env({ [SEAL_ENV.apiKey]: secret }));
    expect(config.ok).toBe(false);
    if (config.ok) return;
    expect(config.failure.detail).not.toContain(secret);
  });
});
