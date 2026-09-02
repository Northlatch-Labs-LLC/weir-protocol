// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The agent client, verified against live mainnet. Reads only.
 *
 * # What this proves, and what it deliberately does not
 *
 * Every check below either reads mainnet through a public fullnode or builds a transaction and
 * inspects it. Nothing is signed, nothing is submitted, no key is loaded and no money moves — so
 * this is safe to run at any time, by anyone, with no configuration.
 *
 * That last part is the point. The web package cannot run its own verification without a populated
 * `.env.local`, which means the checks that matter most are the ones least likely to be run. The
 * agent's deployment record is a committed constant, so this script needs nothing but a network.
 *
 * It does **not** prove an agent can spend. Spending needs a funded key and a signer, and a script
 * that could demonstrate it could also lose money by being run twice.
 *
 *     pnpm --filter @projectx-social/agent verify
 */
import {
  createClient,
  readCurrentEpoch,
  readPlatform,
  readDecimals,
} from '@projectx-social/sdk';
import {
  MAINNET_RECORD,
  buildOpenAccount,
  buildSubscribe,
  buildTip,
  buildUnlock,
  guardPrice,
  loadAgentManifest,
} from '../src/index.js';

let failures = 0;
const pass = (m: string) => console.log(`  ok    ${m}`);
const fail = (m: string) => {
  failures += 1;
  console.log(`  FAIL  ${m}`);
};
const check = (condition: boolean, m: string) => (condition ? pass(m) : fail(m));
const info = (m: string) => console.log(`        ${m}`);

const ENV = {
  PROJECTX_SOCIAL_NETWORK: MAINNET_RECORD.network,
  PROJECTX_SOCIAL_GRPC_URL: 'https://fullnode.mainnet.sui.io:443',
  PROJECTX_SOCIAL_PACKAGE_ID: MAINNET_RECORD.packageId,
  PROJECTX_SOCIAL_LATEST_PACKAGE_ID: MAINNET_RECORD.latestPackageId,
  PROJECTX_SOCIAL_PLATFORM_ID: MAINNET_RECORD.platformId,
  PROJECTX_SOCIAL_REGISTRY_ID: MAINNET_RECORD.registryId,
  PROJECTX_SOCIAL_AGENT_COIN_TYPE: MAINNET_RECORD.usdcType,
  PROJECTX_SOCIAL_AGENT_BASE_URL: 'https://weir.social',
};

/** Every `moveCall` target in a built transaction, in command order. */
function targets(tx: { getData: () => unknown }): string[] {
  const data = tx.getData() as {
    commands: Array<{ MoveCall?: { package: string; module: string; function: string } }>;
  };
  return data.commands
    .flatMap((c) => (c.MoveCall === undefined ? [] : [c.MoveCall]))
    .map((c) => `${c.package}::${c.module}::${c.function}`);
}

async function main() {
  console.log('\nManifest');
  const loaded = loadAgentManifest(ENV);
  if (!loaded.ok) {
    fail(`the pinned mainnet record does not load: ${loaded.failure.detail}`);
    process.exit(1);
  }
  const config = loaded.value.config;
  pass('the committed deployment record loads without any .env file');
  info(`original ${MAINNET_RECORD.packageId.slice(0, 18)}…  (types, events, Seal namespace)`);
  info(`latest   ${MAINNET_RECORD.latestPackageId.slice(0, 18)}…  (every moveCall target)`);
  check(
    MAINNET_RECORD.packageId !== MAINNET_RECORD.latestPackageId,
    'the two package ids are distinct — an upgrade happened and both uses survive',
  );

  console.log('\nLive mainnet');
  const client = createClient(config);

  const epoch = await readCurrentEpoch(client);
  if (epoch.ok) {
    pass(`the fullnode answers — current epoch ${epoch.value}`);
  } else {
    fail(`no fullnode: ${epoch.failure.detail}`);
  }

  const platform = await readPlatform(client, config);
  if (platform.ok) {
    pass('the shared Platform object reads');
    const p = platform.value as Record<string, unknown>;
    for (const key of ['version', 'creation_paused', 'payments_paused']) {
      if (key in p) info(`${key} = ${String(p[key])}`);
    }
    // Not asserted either way. A paused platform is an operating decision, not a defect, and a
    // verification script that failed on it would be reporting the weather as a fault.
    if (p['creation_paused'] === true) {
      info('creation is paused — an agent cannot open an account until it is not');
    }
  } else {
    fail(`the Platform object does not read: ${platform.failure.detail}`);
  }

  const decimals = await readDecimals(client, MAINNET_RECORD.usdcType);
  if (decimals.ok) {
    check(
      decimals.value === 6,
      `USDC decimals read from chain = ${decimals.value} (six, and never assumed)`,
    );
  } else {
    fail(`coin metadata does not read: ${decimals.failure.detail}`);
  }

  console.log('\nEvery moveCall goes to the LATEST package');
  const OBJ = (n: string) => `0x${n.repeat(64)}`;
  const built: Array<[string, { getData: () => unknown }]> = [
    ['openAccount', buildOpenAccount(config, { handle: 'verification-only', referrer: null })],
    ['unlock', buildUnlock(config, {
      coinType: MAINNET_RECORD.usdcType, vaultId: OBJ('1'), accountId: OBJ('2'),
      contentKey: 'k', price: 10_000n, sender: OBJ('9'),
    })],
    ['subscribe', buildSubscribe(config, {
      coinType: MAINNET_RECORD.usdcType, vaultId: OBJ('1'), accountId: OBJ('2'),
      tierIndex: 0, price: 1_000_000n, sender: OBJ('9'),
    })],
    ['tip', buildTip(config, {
      coinType: MAINNET_RECORD.usdcType, vaultId: OBJ('1'), accountId: OBJ('2'), amount: 5_000n,
    })],
  ];
  for (const [name, tx] of built) {
    const t = targets(tx);
    const allLatest = t.length > 0 && t.every((x) => x.startsWith(`${MAINNET_RECORD.latestPackageId}::`));
    check(allLatest, `${name} → ${t.map((x) => x.split('::').slice(1).join('::')).join(', ')}`);
  }

  console.log('\nThe spend guard');
  // The ceiling is the one genuinely new thing an agent adds, so it is checked here rather than
  // trusted to the unit tests alone. `guardPrice` is what every spending method routes through.
  const at = { what: 'a verification-only purchase', coinType: MAINNET_RECORD.usdcType };
  const under = guardPrice({ ...at, livePrice: 10_000n, maxPrice: 50_000n });
  check(under.ok, 'a price under the ceiling is allowed');
  const over = guardPrice({ ...at, livePrice: 90_000n, maxPrice: 50_000n });
  check(!over.ok, 'a price over the ceiling is refused — not clamped, not warned');
  if (!over.ok) info(`reason: ${over.failure.detail.slice(0, 96)}…`);
  const equal = guardPrice({ ...at, livePrice: 50_000n, maxPrice: 50_000n });
  check(equal.ok, 'a price exactly at the ceiling is allowed — the bound is inclusive');

  // The two fields a JavaScript caller or a JSON round trip can drop. Both must fail closed. The
  // casts are the whole point: this is what a caller who never saw the types can reach.
  const noCeiling = guardPrice({ ...at, livePrice: 10_000n, maxPrice: undefined as unknown as bigint });
  check(!noCeiling.ok, 'a missing maxPrice is refused, never defaulted');
  const noPrice = guardPrice({ ...at, livePrice: undefined as unknown as bigint, maxPrice: 50_000n });
  check(!noPrice.ok, 'a missing livePrice is refused — it used to return ok(undefined)');
  const changed = guardPrice({ ...at, livePrice: 10_000n, maxPrice: 50_000n, expected: 9_000n });
  check(!changed.ok, 'a price that moved since the quote is refused');

  console.log(
    failures === 0
      ? '\nAll checks passed. Reads only; nothing was signed or submitted.\n'
      : `\n${failures} check(s) failed.\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
