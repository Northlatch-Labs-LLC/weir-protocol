// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Live-chain tests against the published mainnet deployment.
 *
 * Separate from the unit suite and run with `pnpm test:chain`, because a network outage must not
 * turn the ordinary suite red — a suite that fails for reasons unrelated to the code is a suite
 * people learn to ignore.
 *
 * What these prove that no unit test can: that the gRPC transport actually works, that the objects
 * named in `deploy/mainnet.json` actually exist and have the shape the SDK expects, and that the
 * economic terms on chain are the ones that were intended.
 *
 * Configuration comes from the environment, exactly as production does. There are no defaults —
 * see `PROJECTX_SOCIAL_*` in `.env.example`.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type ProjectXSocialConfig } from '../src/config.js';
import { createClient, readDecimals, readPlatform } from '../src/client.js';
import { computeSplit } from '../src/split.js';
import { fold } from '../src/reading.js';
import type { SuiGrpcClient } from '@mysten/sui/grpc';

/** Native Circle USDC on Sui mainnet. Six decimals — asserted below, never assumed. */
const USDC =
  '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC';

let config: ProjectXSocialConfig;
let client: SuiGrpcClient;

beforeAll(() => {
  config = fold(
    loadConfig(process.env),
    (value) => value,
    (failure) => {
      throw new Error(
        `${failure.detail}\n\n` +
          `These tests read the live deployment. Copy .env.example and source it, ` +
          `or run: pnpm test (unit tests only, no network).`,
      );
    },
  );
  client = createClient(config);
});

describe('the published platform', () => {
  it('is readable over gRPC', async () => {
    const reading = await readPlatform(client, config);
    fold(
      reading,
      (platform) => expect(platform.version).toBe(1n),
      (failure) => {
        throw new Error(`could not read the Platform: ${failure.kind} — ${failure.detail}`);
      },
    );
  });

  it('carries the economic terms that were configured', async () => {
    const reading = await readPlatform(client, config);
    if (!reading.ok) throw new Error(reading.failure.detail);

    expect(reading.value.feeBps).toBe(290n);
    expect(reading.value.referralShareBps).toBe(500n);
    expect(reading.value.creationFeeMist).toBe(0n);
  });

  it('is open for business', async () => {
    const reading = await readPlatform(client, config);
    if (!reading.ok) throw new Error(reading.failure.detail);

    expect(reading.value.creationPaused).toBe(false);
    expect(reading.value.paymentsPaused).toBe(false);
  });

  it('never exceeds its own compiled ceilings', async () => {
    // A live fee above the ceiling would mean the ceiling is not being enforced, which is a far
    // more serious finding than a wrong rate.
    const reading = await readPlatform(client, config);
    if (!reading.ok) throw new Error(reading.failure.detail);

    expect(reading.value.feeBps).toBeLessThanOrEqual(3_000n);
    expect(reading.value.referralShareBps).toBeLessThanOrEqual(5_000n);
  });
});

describe('the split shown to a user matches the live terms', () => {
  it('computes a 10 USDC subscription from chain-read rates', async () => {
    const reading = await readPlatform(client, config);
    if (!reading.ok) throw new Error(reading.failure.detail);

    const { feeBps, referralShareBps } = reading.value;
    const gross = 10_000_000n; // 10 USDC at 6 decimals

    const referred = computeSplit(gross, feeBps, referralShareBps, true);
    const organic = computeSplit(gross, feeBps, referralShareBps, false);

    // Conservation, against the rates actually deployed rather than against test constants.
    expect(referred.creator + referred.platform + referred.referrer).toBe(gross);
    expect(organic.creator + organic.platform + organic.referrer).toBe(gross);

    // The creator is indifferent to referral — the invariant the whole fee design rests on.
    expect(referred.creator).toBe(organic.creator);

    // At the deployed 290/500: creator 9.71, platform 0.2755, referrer 0.0145.
    expect(referred.creator).toBe(9_710_000n);
    expect(referred.platform).toBe(275_500n);
    expect(referred.referrer).toBe(14_500n);
  });
});

describe('coin decimals are read, not assumed', () => {
  it('reads 6 for native USDC', async () => {
    const reading = await readDecimals(client, USDC);
    fold(
      reading,
      (decimals) => expect(decimals).toBe(6),
      (failure) => {
        throw new Error(`could not read USDC decimals: ${failure.kind} — ${failure.detail}`);
      },
    );
  });

  it('reports a failure rather than a number for a coin that does not exist', async () => {
    // The property that matters most in `Reading<T>`: a coin with no metadata must not resolve to
    // a plausible default like 9. A wrong decimals value is wrong by a factor of a thousand.
    const reading = await readDecimals(
      client,
      '0x0000000000000000000000000000000000000000000000000000000000000abc::nope::NOPE',
    );
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(['not-found', 'transport', 'malformed']).toContain(reading.failure.kind);
    }
  });
});

describe('a misconfigured client refuses rather than guessing', () => {
  it('fails when the platform id names something that is not a Platform', async () => {
    // Pointed at the Sui framework's Clock, which certainly exists but is not ours. The read must
    // fail loudly rather than return a Platform-shaped object full of zeros.
    const wrong = { ...config, platformId: `0x${'0'.repeat(63)}6` };
    const reading = await readPlatform(client, wrong);
    expect(reading.ok).toBe(false);
  });
});
