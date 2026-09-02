// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Configuration: it refuses rather than guessing, and it never leaks the key.
 */

import { describe, expect, it } from 'vitest';
import { assertSignerConfigured, assertSignerFunded, loadDaemonConfig, redactedConfig, REQUIRED_ENV } from '../src/config.js';

const SECRET = 'suiprivkey1qtestqtestqtestqtestqtestqtestqtestqtestqtestqtestqtestqtestq';

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
    /*
      The two package ids are deliberately DIFFERENT, matching mainnet after the key-registry
      upgrade. Setting them equal would let a test pass whichever field the code reached for, and
      the whole point of the split is that vault DISCOVERY must filter on the original — event type
      tags never move — while the harvest CALL must target the latest.
    */
    PROJECTX_SOCIAL_PACKAGE_ID:
      '0xc5c833991ed1123d70b1001c0bcdb01ec5728b09f25dfc42a0edaf16005d404d',
    PROJECTX_SOCIAL_LATEST_PACKAGE_ID:
      '0xa7fd154039f77780f808c7262511a9f4a860620d57e17b58e0e2ca010e1d214d',
    PROJECTX_DAEMON_SIGNER_SECRET: SECRET,
    ...overrides,
  };
}

describe('loadDaemonConfig', () => {
  it('accepts a complete environment', () => {
    const reading = loadDaemonConfig(env());
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.tickIntervalSeconds).toBe(3600);
    expect(reading.value.maxDiscoveryPages).toBe(20);
    expect(reading.value.gasBudgetMist).toBe(20_000_000n);
  });

  it('names every missing variable at once', () => {
    // One round trip per missing variable is how a deployment takes an afternoon.
    const reading = loadDaemonConfig({});
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    for (const name of REQUIRED_ENV) {
      expect(reading.failure.detail).toContain(name);
    }
  });

  it('treats an empty string as missing', () => {
    const reading = loadDaemonConfig(env({ PROJECTX_SOCIAL_GRPC_URL: '   ' }));
    expect(reading.ok).toBe(false);
  });

  it('refuses a package id that is not a full object id', () => {
    // 0x1234 parses as valid-looking in most tooling and resolves to nothing at runtime.
    const reading = loadDaemonConfig(env({ PROJECTX_SOCIAL_PACKAGE_ID: '0x1234' }));
    expect(reading.ok).toBe(false);
  });

  it('refuses a tick faster than the minimum', () => {
    // At most one rung may be staked per epoch, so a faster tick cannot find new work — it can
    // only spend gas rediscovering that there is none.
    const reading = loadDaemonConfig(env({ PROJECTX_DAEMON_TICK_SECONDS: '5' }));
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.failure.detail).toContain('minimum is 60');
  });

  it('accepts exactly the minimum tick', () => {
    const reading = loadDaemonConfig(env({ PROJECTX_DAEMON_TICK_SECONDS: '60' }));
    expect(reading.ok).toBe(true);
  });

  it('refuses a non-numeric gas budget rather than defaulting past it', () => {
    const reading = loadDaemonConfig(env({ PROJECTX_DAEMON_GAS_BUDGET_MIST: '1.5' }));
    expect(reading.ok).toBe(false);
  });
});

describe('the signing key', () => {
  /*
    Validated by `assertSignerConfigured`, not by `loadDaemonConfig`, and the split is deliberate:
    `--dry-run` is documented as running with no key and no gas, and requiring one at load time made
    that documentation false — the run refused before it ever reached the dry-run branch. That
    defect only appeared when the daemon was actually run, which is the argument for running it.
  */
  const configWith = (secret: string | undefined) => {
    const reading = loadDaemonConfig(env({ PROJECTX_DAEMON_SIGNER_SECRET: secret }));
    expect(reading.ok).toBe(true);
    if (!reading.ok) throw new Error('fixture should load');
    return reading.value;
  };

  it('loads without one, so a dry run needs no key', () => {
    const reading = loadDaemonConfig(env({ PROJECTX_DAEMON_SIGNER_SECRET: undefined }));
    expect(reading.ok).toBe(true);
  });

  it('is rejected for a live run when it is not a bech32 Sui private key', () => {
    const checked = assertSignerConfigured(configWith('hunter2'));
    expect(checked.ok).toBe(false);
  });

  it('is rejected for a live run when it is absent, and says to use --dry-run instead', () => {
    const checked = assertSignerConfigured(configWith(undefined));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.failure.detail).toContain('--dry-run');
  });

  it('is accepted when it looks like a Sui key', () => {
    const checked = assertSignerConfigured(configWith(SECRET));
    expect(checked.ok).toBe(true);
  });

  it('never appears in the failure message', () => {
    // The failure path is the likeliest place for a secret to reach a log. Not even truncated —
    // a prefix of a private key is still a prefix of a private key.
    const checked = assertSignerConfigured(configWith('sk-super-secret-value'));
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    expect(checked.failure.detail).not.toContain('sk-super-secret-value');
    expect(checked.failure.detail).toContain('deliberately not shown');
  });

  it('is omitted entirely from the redacted config, not masked', () => {
    // Omitted rather than starred: a masked field still discloses the length, and leaves one more
    // place for an upstream serialiser to find the real value.
    const reading = loadDaemonConfig(env());
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;

    const redacted = redactedConfig(reading.value);
    expect('signerSecret' in redacted).toBe(false);

    // Must survive JSON.stringify, which is the one thing this function exists for. A bigint
    // field would throw "Do not know how to serialize a BigInt" and crash a startup banner.
    const serialised = JSON.stringify(redacted);
    expect(serialised).not.toContain(SECRET);
    expect(JSON.parse(serialised).gasBudgetMist).toBe('20000000');
    // And the original is untouched — redaction copies rather than mutates.
    expect(reading.value.signerSecret).toBe(SECRET);
  });
});

describe('assertSignerFunded', () => {
  it('refuses when the budget exceeds the balance', () => {
    // The defect this was written for: Sui requires the gas coin to cover the whole budget, so a
    // budget above the balance means nothing executes — not that it runs short.
    const r = assertSignerFunded(200_000_000n, 200_000_001n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain('cover the whole budget');
  });

  it('refuses a balance that covers fewer than three transactions', () => {
    // Exactly the situation observed live: funded with 0.2 SUI against a 0.2 budget. It pays for
    // one harvest, and every one after that is rejected before execution.
    const r = assertSignerFunded(200_000_000n, 200_000_000n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failure.detail).toContain('fewer than 3');
  });

  it('accepts a balance at exactly the required multiple', () => {
    expect(assertSignerFunded(60_000_000n, 20_000_000n).ok).toBe(true);
  });

  it('accepts the live configuration', () => {
    // 0.2 SUI against the 0.02 default — ten transactions of headroom.
    expect(assertSignerFunded(200_000_000n, 20_000_000n).ok).toBe(true);
  });
});

describe('the two package ids', () => {
  it('are both required, and each is named when it is the one missing', () => {
    for (const name of ['PROJECTX_SOCIAL_PACKAGE_ID', 'PROJECTX_SOCIAL_LATEST_PACKAGE_ID']) {
      const reading = loadDaemonConfig(env({ [name]: undefined }));
      expect(reading.ok).toBe(false);
      if (reading.ok) continue;
      expect(reading.failure.detail).toContain(name);
    }
  });

  it('are kept distinct, not collapsed into one', () => {
    /*
      The trap: discovery filters events by type, and a Move type's address is the package it was
      FIRST published at — it never moves. The harvest call must target the latest package, because
      Sui runs whatever bytecode lives at the address you name. Reading one field for both jobs
      breaks one of them silently in whichever direction it is wrong.
    */
    const reading = loadDaemonConfig(env());
    expect(reading.ok).toBe(true);
    if (!reading.ok) return;
    expect(reading.value.packageId).not.toBe(reading.value.latestPackageId);
  });

  it('rejects a latest package id that is not an object id', () => {
    const reading = loadDaemonConfig(env({ PROJECTX_SOCIAL_LATEST_PACKAGE_ID: '0x1234' }));
    expect(reading.ok).toBe(false);
    if (reading.ok) return;
    expect(reading.failure.detail).toContain('PROJECTX_SOCIAL_LATEST_PACKAGE_ID');
  });
});
