// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Daemon configuration. No defaults, anywhere.
 *
 * An unset variable makes {@link loadDaemonConfig} return a failure naming it. Nothing here falls
 * back to mainnet, to a well-known endpoint, or to the deployment the author happened to be
 * testing against — on a chain, a plausible default is not a failed request, it is a transaction
 * sent somewhere nobody chose.
 *
 * # On the signing key
 *
 * The daemon signs `harvest`, which is **permissionless**: it takes no capability and confers no
 * authority. The key therefore needs gas and nothing else. If it leaks, the attacker's entire
 * power is to harvest vaults — which is what the daemon exists to do anyway.
 *
 * That is a deliberate property worth preserving. **Do not give this key `PlatformCap`,
 * `StakeCap`, or a treasury.** Use a dedicated address funded with a small gas float, and top it
 * up rather than raising the ceiling.
 *
 * The key is read from the environment and never logged, never echoed in an error, and never
 * placed on a config object that gets serialised. {@link redactedConfig} exists so a startup
 * banner can print the configuration without printing the key.
 */

import { fail, ok, type Reading } from '@projectx-social/sdk';

export interface DaemonConfig {
  /** gRPC endpoint. JSON-RPC is dead on Sui public fullnodes and is not an option. */
  grpcUrl: string;
  /**
   * The **original** published `projectx_social` package.
   *
   * Used for the event filter that discovers vaults. A Move struct's type identity is bound to the
   * address it was first published at and never moves, so `StakeVaultOpened` still carries this
   * address after any number of upgrades. Filtering on the newest package id instead returns
   * nothing at all — reported as "no vaults", which is the one wrong answer a harvest daemon must
   * never give quietly.
   */
  packageId: string;
  /**
   * The **latest** published version, and the only correct target for the harvest call.
   *
   * Sui does not resolve a package id to its newest version; calling the original address executes
   * the original bytecode. Equal to `packageId` until the first upgrade, and different after it.
   */
  latestPackageId: string;
  /**
   * Bech32 `suiprivkey1...` secret for the harvest signer, or `''` in a dry run. Gas-only.
   *
   * Held as a plain string because that is what the keypair constructor takes. It is deliberately
   * the only secret in this object, so `redactedConfig` has exactly one field to strip.
   */
  signerSecret: string;
  /**
   * The run journal's Postgres URL.
   *
   * Required for a live run and `null` only in `--dry-run`. A daemon spending real gas with no
   * record of what it did is one you can only trust, and nothing else in this system asks to be
   * trusted. It is also where the single-instance lock lives, so running without it would mean two
   * copies could both harvest and both pay.
   */
  databaseUrl: string | null;
  /** Seconds between ticks. */
  tickIntervalSeconds: number;
  /** Hard ceiling on event pages walked during discovery. Bounded, never caller-supplied. */
  maxDiscoveryPages: number;
  /** Gas budget per harvest, in MIST. */
  gasBudgetMist: bigint;
}

export const REQUIRED_ENV = [
  'PROJECTX_SOCIAL_GRPC_URL',
  'PROJECTX_SOCIAL_PACKAGE_ID',
  'PROJECTX_SOCIAL_LATEST_PACKAGE_ID',
] as const;

/** Optional, with the value used when unset stated explicitly rather than hidden in a `??`. */
export const OPTIONAL_ENV = {
  PROJECTX_DAEMON_TICK_SECONDS: 3600,
  PROJECTX_DAEMON_MAX_DISCOVERY_PAGES: 20,
  /*
    0.02 SUI. A harvest costs roughly 0.002–0.005, so this is ample headroom, and unspent budget is
    returned rather than consumed.

    It was 0.2 — and that default was actively dangerous, not merely generous. Sui requires the gas
    coin to cover the whole budget, so a signer funded with 0.2 could pay for exactly one harvest;
    afterwards its balance sat below the budget and **every** subsequent harvest would be rejected
    before execution. Once per epoch, for ever, with the daemon reporting a submission failure
    rather than anything that names the cause. `assertSignerFunded` now catches that at startup.
  */
  PROJECTX_DAEMON_GAS_BUDGET_MIST: 20_000_000n,
} as const;

/**
 * How many times over the balance must cover the gas budget before the daemon will run.
 *
 * Three, because the failure it prevents is not "runs out of gas" — that is obvious and expected —
 * but "budget exceeds balance, so nothing executes at all while the process looks healthy".
 */
const REQUIRED_BALANCE_MULTIPLE = 3n;

const OBJECT_ID = /^0x[0-9a-f]{64}$/;

/**
 * A tick shorter than this is refused.
 *
 * Sui epochs are roughly a day, and the contract permits at most one rung staked per epoch, so
 * anything faster than a few minutes cannot discover new work — it can only spend gas
 * rediscovering that there is none. The decision function already declines to submit, so this is
 * belt and braces against a misconfigured deployment hammering a fullnode.
 */
const MIN_TICK_SECONDS = 60;

export function loadDaemonConfig(
  env: Record<string, string | undefined>,
): Reading<DaemonConfig> {
  const missing = REQUIRED_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    return fail(
      'unconfigured',
      'DaemonConfig',
      `missing required environment ${missing.length === 1 ? 'variable' : 'variables'}: ` +
        `${missing.join(', ')}. There is no default for any of them.`,
    );
  }

  const grpcUrl = env['PROJECTX_SOCIAL_GRPC_URL']!.trim();
  if (!/^https?:\/\//.test(grpcUrl)) {
    return fail('unconfigured', 'DaemonConfig', `PROJECTX_SOCIAL_GRPC_URL is not an http(s) URL`);
  }

  const packageId = env['PROJECTX_SOCIAL_PACKAGE_ID']!.trim();
  if (!OBJECT_ID.test(packageId)) {
    return fail(
      'unconfigured',
      'DaemonConfig',
      `PROJECTX_SOCIAL_PACKAGE_ID is not a 32-byte hex object id`,
    );
  }

  const latestPackageId = env['PROJECTX_SOCIAL_LATEST_PACKAGE_ID']!.trim();
  if (!OBJECT_ID.test(latestPackageId)) {
    return fail(
      'unconfigured',
      'DaemonConfig',
      `PROJECTX_SOCIAL_LATEST_PACKAGE_ID is not a 32-byte hex object id`,
    );
  }

  /*
    Loaded outside REQUIRED_ENV because `--dry-run` legitimately runs without it: a dry run signs
    nothing, so there is nothing to record and no gas for a second instance to waste. `loadDaemonConfig`
    therefore returns it as possibly-null and `assertJournalConfigured` is what a live run calls —
    which keeps the refusal at the point where the requirement actually exists.
  */
  const databaseUrl = env['PROJECTX_DAEMON_DATABASE_URL']?.trim() ?? null;

  /*
    The signing key is loaded but NOT required here, for the same reason as the journal URL:
    `--dry-run` signs nothing and is documented as running with no key and no gas. Requiring one at
    load time made that documentation false — the run refused before it reached the dry-run branch
    at all, which is the sort of defect only running the thing reveals.

    `assertSignerConfigured` is what a live run calls, so the refusal lands where the requirement
    actually is.
  */
  const signerSecret = env['PROJECTX_DAEMON_SIGNER_SECRET']?.trim() ?? '';

  const tick = parseNumber(env, 'PROJECTX_DAEMON_TICK_SECONDS', OPTIONAL_ENV.PROJECTX_DAEMON_TICK_SECONDS);
  if (tick === null) {
    return fail('unconfigured', 'DaemonConfig', `PROJECTX_DAEMON_TICK_SECONDS is not a number`);
  }
  if (tick < MIN_TICK_SECONDS) {
    return fail(
      'unconfigured',
      'DaemonConfig',
      `PROJECTX_DAEMON_TICK_SECONDS is ${tick}; the minimum is ${MIN_TICK_SECONDS}. ` +
        `Sui epochs are about a day and at most one rung may be staked per epoch, so a faster ` +
        `tick cannot find new work.`,
    );
  }

  const pages = parseNumber(
    env,
    'PROJECTX_DAEMON_MAX_DISCOVERY_PAGES',
    OPTIONAL_ENV.PROJECTX_DAEMON_MAX_DISCOVERY_PAGES,
  );
  if (pages === null || pages < 1) {
    return fail(
      'unconfigured',
      'DaemonConfig',
      `PROJECTX_DAEMON_MAX_DISCOVERY_PAGES must be a positive number`,
    );
  }

  const rawGas = env['PROJECTX_DAEMON_GAS_BUDGET_MIST'];
  let gasBudgetMist: bigint = OPTIONAL_ENV.PROJECTX_DAEMON_GAS_BUDGET_MIST;
  if (rawGas !== undefined && rawGas.trim() !== '') {
    if (!/^\d+$/.test(rawGas.trim())) {
      return fail(
        'unconfigured',
        'DaemonConfig',
        `PROJECTX_DAEMON_GAS_BUDGET_MIST must be a whole number of MIST`,
      );
    }
    gasBudgetMist = BigInt(rawGas.trim());
  }

  return ok({
    grpcUrl,
    packageId,
    latestPackageId,
    databaseUrl: databaseUrl === '' ? null : databaseUrl,
    signerSecret,
    tickIntervalSeconds: tick,
    maxDiscoveryPages: pages,
    gasBudgetMist,
  });
}

function parseNumber(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
): number | null {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

/** The configuration as it is safe to log: no secret, and JSON-serialisable. */
export interface RedactedConfig {
  grpcUrl: string;
  packageId: string;
  latestPackageId: string;
  /**
   * Whether a journal is configured — never the URL.
   *
   * A Postgres connection string carries a password. `signerSecret` is omitted from this object for
   * the same reason, and a URL is easier to leak because it looks like configuration rather than
   * like a credential.
   */
  journal: boolean;
  tickIntervalSeconds: number;
  maxDiscoveryPages: number;
  /** A decimal string, not a `bigint` — see below. */
  gasBudgetMist: string;
}

/**
 * The configuration with the secret removed, safe to log.
 *
 * `signerSecret` is **omitted entirely rather than masked**. A masked field still discloses the
 * length, and it leaves one more place for an upstream serialiser to find the real value.
 *
 * `gasBudgetMist` is converted to a string because `JSON.stringify` **throws** on a `bigint` —
 * `TypeError: Do not know how to serialize a BigInt`. Returning the raw value made this function
 * unusable for the one thing it exists for: a caller writing `JSON.stringify(redactedConfig(c))`
 * in a startup banner would crash the daemon at boot. Caught by its own test.
 */
export function redactedConfig(config: DaemonConfig): RedactedConfig {
  return {
    grpcUrl: config.grpcUrl,
    packageId: config.packageId,
    latestPackageId: config.latestPackageId,
    journal: config.databaseUrl !== null,
    tickIntervalSeconds: config.tickIntervalSeconds,
    maxDiscoveryPages: config.maxDiscoveryPages,
    gasBudgetMist: config.gasBudgetMist.toString(),
  };
}

/**
 * Refuse to run when the signer cannot actually pay.
 *
 * A gas budget above the signer's balance does not produce a slow daemon or a partial one — Sui
 * rejects the transaction before execution, so *nothing* happens, once per epoch, while the process
 * reports itself healthy and the logs show only a submission failure. That is the exact shape of
 * failure this codebase exists to refuse, so it is checked once at startup rather than discovered
 * from a vault that mysteriously never accrues.
 *
 * Returns a failure rather than throwing, so the caller decides — and names the numbers, because
 * "insufficient gas" without them sends someone to the wrong place.
 */
export function assertSignerFunded(
  balanceMist: bigint,
  gasBudgetMist: bigint,
): Reading<true> {
  const required = gasBudgetMist * REQUIRED_BALANCE_MULTIPLE;

  if (balanceMist < gasBudgetMist) {
    return fail(
      'unconfigured',
      'signer balance',
      `the signer holds ${balanceMist} MIST but the gas budget is ${gasBudgetMist}. ` +
        'Sui requires the gas coin to cover the whole budget, so no transaction would execute ' +
        'at all. Either fund the signer or lower PROJECTX_DAEMON_GAS_BUDGET_MIST.',
    );
  }

  if (balanceMist < required) {
    return fail(
      'unconfigured',
      'signer balance',
      `the signer holds ${balanceMist} MIST against a gas budget of ${gasBudgetMist}. ` +
        `That covers fewer than ${REQUIRED_BALANCE_MULTIPLE} transactions, and the balance will ` +
        'fall below the budget almost immediately — after which every harvest is rejected before ' +
        'execution rather than merely running short. Fund the signer or lower the budget.',
    );
  }

  return ok(true);
}

export function requiredBalanceMultiple(): bigint {
  return REQUIRED_BALANCE_MULTIPLE;
}

/**
 * Refuse a live run with no journal.
 */
export function assertJournalConfigured(config: DaemonConfig): Reading<string> {
  if (config.databaseUrl === null) {
    return fail(
      'unconfigured',
      'DaemonConfig',
      'PROJECTX_DAEMON_DATABASE_URL is not set. A live run records every tick to the journal, ' +
        'which is also where the single-instance lock lives — without it two daemons could both ' +
        'harvest and both pay gas, and nothing would show what either of them did. ' +
        'Use --dry-run to exercise the whole path without a journal, a key or any gas.',
    );
  }
  return ok(config.databaseUrl);
}

/**
 * Refuse a live run with no usable signing key.
 *
 * Checked by prefix rather than by decoding, so a malformed key is reported without the decoder
 * ever being handed something that could end up inside an exception message. The value is never
 * echoed — not even truncated, because a prefix of a private key is still a prefix of a private key.
 */
export function assertSignerConfigured(config: DaemonConfig): Reading<string> {
  if (config.signerSecret === '') {
    return fail(
      'unconfigured',
      'DaemonConfig',
      'PROJECTX_DAEMON_SIGNER_SECRET is not set. A live run signs harvest transactions and needs ' +
        'a gas-only key. Use --dry-run to exercise discovery, decoding and every decision without ' +
        'a key, a journal or any gas.',
    );
  }
  if (!config.signerSecret.startsWith('suiprivkey1')) {
    return fail(
      'unconfigured',
      'DaemonConfig',
      'PROJECTX_DAEMON_SIGNER_SECRET is not a bech32 Sui private key (expected a ' +
        '"suiprivkey1..." string). Its value is deliberately not shown.',
    );
  }
  return ok(config.signerSecret);
}
