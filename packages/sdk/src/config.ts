// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Deployment configuration.
 *
 * # There are no defaults in this file, and that is the design
 *
 * No package id, no object id, no network, no endpoint has a fallback value. An unset variable
 * makes {@link loadConfig} return a failure naming the variable; it never quietly resolves to
 * mainnet, or to the deployment the author happened to be testing against.
 *
 * The reason is specific rather than principled: a placeholder address that happens to be
 * syntactically valid is a transaction sent somewhere nobody chose. On a chain, that is not a
 * failed request — it is money moved.
 *
 * The real mainnet ids live in `sui-contracts/deploy/mainnet.json`, which is a **record**, not
 * configuration. Load it deliberately if you want it; do not let it become an implicit default.
 */

import { fail, ok, type Reading } from './reading.js';

export type Network = 'mainnet' | 'testnet' | 'devnet' | 'localnet';

export interface ProjectXSocialConfig {
  network: Network;
  /**
   * gRPC endpoint.
   */
  grpcUrl: string;
  /**
   * The **original** published `projectx_social` package.
   *
   * This is the address that appears in every struct and event type tag — `SocialAccount`,
   * `Subscription`, `PaymentSettled` — and it does not move when the package is upgraded. Move
   * type identity is bound to the address a struct was first published at, forever.
   *
   * Use it for object type filters and event filters. Never for a call target: after an upgrade it
   * names the *old* code, which does not contain modules added since.
   */
  packageId: string;
  /**
   * The **latest** published version, and the only correct target for a `moveCall`.
   *
   * Sui does not resolve a package id to its newest version. A call to the original address
   * executes the original bytecode, so a module added in an upgrade is simply not there — the
   * failure is `FunctionNotFound`, not something that looks like a version problem.
   *
   * Equal to `packageId` until the first upgrade, and different after it. Both are configured
   * rather than derived, because deriving one from the other means a chain read on every call and
   * a wrong answer whenever that read fails.
   */
  latestPackageId: string;
  /** The shared `platform::Platform` object. */
  platformId: string;
  /** The shared `account::Registry` object. */
  registryId: string;
}

/** Every variable this SDK reads. Exported so a deployment script can print the full list. */
export const REQUIRED_ENV = [
  'PROJECTX_SOCIAL_NETWORK',
  'PROJECTX_SOCIAL_GRPC_URL',
  'PROJECTX_SOCIAL_PACKAGE_ID',
  'PROJECTX_SOCIAL_LATEST_PACKAGE_ID',
  'PROJECTX_SOCIAL_PLATFORM_ID',
  'PROJECTX_SOCIAL_REGISTRY_ID',
] as const;

const NETWORKS: readonly Network[] = ['mainnet', 'testnet', 'devnet', 'localnet'];

/**
 * The shared `key_registry::KeyRegistry`, loaded separately from the rest.
 *
 * Not part of {@link REQUIRED_ENV}, and that is a deliberate seam rather than a softer rule. Adding
 * it there would make the harvest daemon — which has no interest in encryption keys — refuse to
 * start until an unrelated variable was set, and the reliable consequence of that is somebody
 * pasting a plausible id to make the error go away.
 *
 * So the messaging feature asks for it, and only the messaging feature fails without it. There is
 * still no default: an unset variable returns a failure naming it, exactly as everything else here.
 */
export const KEY_REGISTRY_ENV = 'PROJECTX_SOCIAL_KEY_REGISTRY_ID';

export function loadKeyRegistryId(env: Record<string, string | undefined>): Reading<string> {
  const value = env[KEY_REGISTRY_ENV]?.trim();
  if (value === undefined || value === '') {
    return fail(
      'unconfigured',
      'KeyRegistry',
      `${KEY_REGISTRY_ENV} is not set. Encrypted messaging reads the key registry from chain and ` +
        `there is no default. The mainnet id is recorded in sui-contracts/deploy/mainnet.json.`,
    );
  }
  if (!OBJECT_ID.test(value)) {
    return fail(
      'unconfigured',
      'KeyRegistry',
      `${KEY_REGISTRY_ENV} is "${value}", which is not a 32-byte hex object id ` +
        `(expected 0x followed by 64 lowercase hex characters).`,
    );
  }
  return ok(value);
}

/**
 * The `agent_mind` package, loaded separately for the same reason as the key registry.
 *
 * It is a different package from `projectx_social` — published on its own, with its own id and
 * its own digest file — and only the agent's mind feature calls it. Putting it in
 * {@link REQUIRED_ENV} would stop every other consumer until an unrelated id was set. Unset, or
 * not a 32-byte hex id, is `unconfigured`, exactly as {@link loadKeyRegistryId}.
 */
export const MIND_PACKAGE_ENV = 'PROJECTX_SOCIAL_MIND_PACKAGE_ID';

export function loadMindPackageId(env: Record<string, string | undefined>): Reading<string> {
  const value = env[MIND_PACKAGE_ENV]?.trim();
  if (value === undefined || value === '') {
    return fail(
      'unconfigured',
      'MindPackage',
      `${MIND_PACKAGE_ENV} is not set. The agent's mind is approved by the agent_mind package and ` +
        `there is no default. Its mainnet id is recorded in sui-contracts/deploy/mainnet.json ` +
        `under agentMindPackage once it is published.`,
    );
  }
  if (!OBJECT_ID.test(value)) {
    return fail(
      'unconfigured',
      'MindPackage',
      `${MIND_PACKAGE_ENV} is "${value}", which is not a 32-byte hex object id ` +
        `(expected 0x followed by 64 lowercase hex characters).`,
    );
  }
  return ok(value);
}

/**
 * A 32-byte hex object id.
 *
 * Length is checked, not just the prefix. `0x1234` parses as a valid-looking id in most tooling
 * and resolves to nothing at runtime, which surfaces as an opaque "object does not exist" a long
 * way from the typo.
 */
const OBJECT_ID = /^0x[0-9a-f]{64}$/;

/**
 * Build config from an environment.
 *
 * Takes the environment as an argument rather than reaching for `process.env`, so it is testable
 * and so a browser build can pass its own record without pretending to be Node.
 */
export function loadConfig(env: Record<string, string | undefined>): Reading<ProjectXSocialConfig> {
  const missing = REQUIRED_ENV.filter((name) => {
    const value = env[name];
    return value === undefined || value.trim() === '';
  });

  if (missing.length > 0) {
    return fail(
      'unconfigured',
      'ProjectXSocialConfig',
      `missing required environment ${missing.length === 1 ? 'variable' : 'variables'}: ` +
        `${missing.join(', ')}. There is no default — set them explicitly. ` +
        `Mainnet ids are recorded in sui-contracts/deploy/mainnet.json.`,
    );
  }

  const network = env['PROJECTX_SOCIAL_NETWORK']!.trim();
  if (!NETWORKS.includes(network as Network)) {
    return fail(
      'unconfigured',
      'ProjectXSocialConfig',
      `PROJECTX_SOCIAL_NETWORK is "${network}"; expected one of ${NETWORKS.join(', ')}.`,
    );
  }

  const ids: Array<[keyof ProjectXSocialConfig, string]> = [
    ['packageId', env['PROJECTX_SOCIAL_PACKAGE_ID']!.trim()],
    ['latestPackageId', env['PROJECTX_SOCIAL_LATEST_PACKAGE_ID']!.trim()],
    ['platformId', env['PROJECTX_SOCIAL_PLATFORM_ID']!.trim()],
    ['registryId', env['PROJECTX_SOCIAL_REGISTRY_ID']!.trim()],
  ];

  for (const [field, value] of ids) {
    if (!OBJECT_ID.test(value)) {
      return fail(
        'unconfigured',
        'ProjectXSocialConfig',
        `${field} is "${value}", which is not a 32-byte hex object id ` +
          `(expected 0x followed by 64 lowercase hex characters).`,
      );
    }
  }

  const grpcUrl = env['PROJECTX_SOCIAL_GRPC_URL']!.trim();
  if (!/^https?:\/\//.test(grpcUrl)) {
    return fail(
      'unconfigured',
      'ProjectXSocialConfig',
      `PROJECTX_SOCIAL_GRPC_URL is "${grpcUrl}"; expected an http(s) URL.`,
    );
  }

  return ok({
    network: network as Network,
    grpcUrl,
    packageId: ids[0]![1],
    latestPackageId: ids[1]![1],
    platformId: ids[2]![1],
    registryId: ids[3]![1],
  });
}

/**
 * Seal key custody, loaded separately from the rest.
 *
 * # Why this is its own loader and not part of {@link REQUIRED_ENV}
 *
 * The same seam as {@link KEY_REGISTRY_ENV}, for the same reason. The harvest daemon has no
 * interest in threshold encryption, and making it refuse to start until a key server list was set
 * would reliably produce somebody pasting a plausible object id to make the error go away. So the
 * media feature asks for this, and only the media feature fails without it.
 *
 * There is still no default anywhere below. An unset or malformed variable returns a failure naming
 * it. A default here would be worse than a default elsewhere in this file: a key server list that
 * silently fell back to somebody else's servers would encrypt a creator's paid media to a threshold
 * committee nobody chose, and the failure would be invisible until the day those servers declined
 * to answer — by which time the ciphertext is on Walrus and the key is underivable. There is no
 * recovery from that, which is why it fails at load instead.
 */
export const SEAL_ENV = {
  keyServers: 'PROJECTX_SOCIAL_SEAL_KEY_SERVERS',
  threshold: 'PROJECTX_SOCIAL_SEAL_THRESHOLD',
  /**
   * The header name a permissioned key server authenticates with — `X-API-Key` for the mainnet
   * committee. A name, not a secret.
   */
  apiKeyName: 'PROJECTX_SOCIAL_SEAL_API_KEY_NAME',
  /**
   * The credential itself. **A secret.**
   *
   * Never echoed in a failure message, never logged, never returned by anything that gets printed.
   * The failures below name the *variable* when it is missing and say nothing about its contents
   * when it is present — a configuration error that quotes the value it read is how a credential
   * reaches a log aggregator.
   */
  apiKey: 'PROJECTX_SOCIAL_SEAL_API_KEY',
} as const;

/** One key server this deployment will encrypt to. */
export interface SealKeyServer {
  /** The key server's on-chain object id. */
  objectId: string;
  /**
   * How many times this server counts towards the threshold.
   *
   * Defaults to 1 when the entry omits it. This is the one value with a default and it is a parsing
   * convenience rather than a deployment guess: a list of ids with no weights is unambiguous, and
   * every server counting once is the only reading of it.
   */
  weight: number;
  /**
   * Required for committee-mode servers, whose fetch-key calls go through an aggregator, and absent
   * for independent ones. The SDK distinguishes the two by whether this is set, so an aggregator
   * URL supplied for an independent server is not harmless.
   */
  aggregatorUrl?: string;
  /** Header name for a permissioned server. Present exactly when {@link apiKey} is. */
  apiKeyName?: string;
  /** The credential for a permissioned server. Secret — never log this. */
  apiKey?: string;
}

export interface SealConfig {
  keyServers: SealKeyServer[];
  /**
   * How many key servers must agree before a key can be reconstructed.
   *
   * Configured rather than derived from the list length. A threshold equal to the number of servers
   * means one unreachable server makes every paid asset permanently unreadable; a threshold of one
   * means any single server can hand out a creator's content. Neither is a choice a parser should
   * make on an operator's behalf.
   */
  threshold: number;
}

/**
 * Parse the key server list.
 *
 * The format is comma-separated entries of `objectId[|weight[|aggregatorUrl]]`, chosen over JSON
 * because this value is set in a hosting provider's environment panel, where a quoted JSON array
 * reliably arrives with its quotes mangled.
 *
 * Every entry is validated and a single bad one fails the whole list. The web app's vault-coin list
 * takes the opposite line and drops malformed entries, so that one typo does not withhold a whole
 * form; that trade is wrong here, because a dropped key server would silently change the committee
 * content is encrypted to, and would do it in a way that still appears to work.
 */
export function loadSealConfig(env: Record<string, string | undefined>): Reading<SealConfig> {
  const source = 'SealConfig';

  const rawServers = env[SEAL_ENV.keyServers]?.trim();
  if (rawServers === undefined || rawServers === '') {
    return fail(
      'unconfigured',
      source,
      `${SEAL_ENV.keyServers} is not set. Gated media is encrypted to a Seal key server committee ` +
        `and there is no default. Format: comma-separated ` +
        `objectId[|weight[|aggregatorUrl]] entries.`,
    );
  }

  const keyServers: SealKeyServer[] = [];
  const seen = new Set<string>();
  for (const entry of rawServers.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const [objectId = '', rawWeight, rawAggregator] = trimmed.split('|').map((part) => part.trim());
    if (!OBJECT_ID.test(objectId)) {
      return fail(
        'unconfigured',
        source,
        `${SEAL_ENV.keyServers} names a key server "${objectId}", which is not a 32-byte hex ` +
          `object id (expected 0x followed by 64 lowercase hex characters).`,
      );
    }
    /*
      A duplicate is refused rather than deduplicated. The Seal SDK throws
      `InvalidClientOptionsError` on duplicate object ids, so silently collapsing them here would
      turn a configuration mistake into a runtime crash a long way from the variable — and if it did
      not, it would quietly halve the committee an operator thought they had configured.
    */
    if (seen.has(objectId)) {
      return fail('unconfigured', source, `${SEAL_ENV.keyServers} lists ${objectId} twice.`);
    }
    seen.add(objectId);

    let weight = 1;
    if (rawWeight !== undefined && rawWeight !== '') {
      weight = Number(rawWeight);
      if (!Number.isInteger(weight) || weight < 1) {
        return fail(
          'unconfigured',
          source,
          `${SEAL_ENV.keyServers} gives ${objectId} a weight of "${rawWeight}"; ` +
            `expected a whole number of at least 1.`,
        );
      }
    }

    if (rawAggregator !== undefined && rawAggregator !== '') {
      if (!/^https?:\/\//.test(rawAggregator)) {
        return fail(
          'unconfigured',
          source,
          `${SEAL_ENV.keyServers} gives ${objectId} an aggregator "${rawAggregator}"; ` +
            `expected an http(s) URL.`,
        );
      }
      keyServers.push({ objectId, weight, aggregatorUrl: rawAggregator });
    } else {
      keyServers.push({ objectId, weight });
    }
    /*
      The credential is attached after the list is parsed, not here — see below. It applies to every
      server uniformly because Enoki issues one key for the committee, and a per-server credential
      syntax would put a secret inside a comma-separated list that gets printed in error messages.
    */
  }

  if (keyServers.length === 0) {
    return fail('unconfigured', source, `${SEAL_ENV.keyServers} is set but names no key server.`);
  }

  /*
    Credentials for a permissioned committee.

    There are no open key servers on Sui mainnet — every mainnet provider, including the Mysten
    committee reached through `seal-aggregator-mainnet.mystenlabs.com`, requires enrolment and
    issues an API key. So this is optional in shape (testnet servers are open and need none) and
    mandatory in practice for any mainnet deployment.

    Both or neither. The Seal SDK throws `InvalidClientOptionsError` when one is supplied without
    the other, and it throws at client construction — inside an upload, far from the variable. Here
    it is a configuration failure that names what is missing.
  */
  const apiKeyName = env[SEAL_ENV.apiKeyName]?.trim();
  const apiKey = env[SEAL_ENV.apiKey]?.trim();
  const hasName = apiKeyName !== undefined && apiKeyName !== '';
  const hasKey = apiKey !== undefined && apiKey !== '';
  if (hasName !== hasKey) {
    return fail(
      'unconfigured',
      source,
      // Names the variable that is missing and never the one that is present. The value of
      // PROJECTX_SOCIAL_SEAL_API_KEY must not appear in a log line.
      `${hasName ? SEAL_ENV.apiKey : SEAL_ENV.apiKeyName} is not set, but ` +
        `${hasName ? SEAL_ENV.apiKeyName : SEAL_ENV.apiKey} is. A permissioned key server needs ` +
        `both a header name and a credential; an open one needs neither.`,
    );
  }
  const credential = hasName && hasKey ? { apiKeyName: apiKeyName!, apiKey: apiKey! } : {};

  const rawThreshold = env[SEAL_ENV.threshold]?.trim();
  if (rawThreshold === undefined || rawThreshold === '') {
    return fail(
      'unconfigured',
      source,
      `${SEAL_ENV.threshold} is not set. It decides how many of the ${keyServers.length} ` +
        `configured key servers must agree to release a key, and there is no safe default.`,
    );
  }
  const threshold = Number(rawThreshold);
  if (!Number.isInteger(threshold) || threshold < 1) {
    return fail(
      'unconfigured',
      source,
      `${SEAL_ENV.threshold} is "${rawThreshold}"; expected a whole number of at least 1.`,
    );
  }

  /*
    Checked against total weight, not against the number of entries, because a weighted server
    contributes its weight towards the threshold. Getting this wrong is unrecoverable in one
    direction: `SealClient.encrypt` refuses a threshold above the available weight, but only at the
    moment of the first upload, and an operator who set it there has already told creators their
    media is protected.
  */
  const totalWeight = keyServers.reduce((sum, server) => sum + server.weight, 0);
  if (threshold > totalWeight) {
    return fail(
      'unconfigured',
      source,
      `${SEAL_ENV.threshold} is ${threshold} but the key servers in ${SEAL_ENV.keyServers} carry ` +
        `a total weight of ${totalWeight}. No key could ever be reconstructed.`,
    );
  }

  return ok({
    keyServers: keyServers.map((server) => ({ ...server, ...credential })),
    threshold,
  });
}
