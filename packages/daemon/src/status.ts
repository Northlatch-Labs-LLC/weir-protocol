// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Read-only status. Interrogates the chain and prints what it finds. Signs nothing.
 *
 * `pnpm status` — needs no key, no gas, and no daemon running.
 */

import { SuiGrpcClient } from '@mysten/sui/grpc';
import { describeFailureKind, fold, retryAdvice } from '@projectx-social/sdk';
import { loadDaemonConfig } from './config.js';
import { discoverVaults } from './adapters/discovery.js';
import { readCurrentEpoch, readStakeVault } from './adapters/vault.js';
import { decideHarvest, ladderCaptureBps, nextActionableEpoch, LADDER_DEPTH } from './domain/harvest.js';

const SUI = 1_000_000_000n;

function sui(mist: bigint): string {
  const whole = mist / SUI;
  const frac = (mist % SUI).toString().padStart(9, '0').replace(/0+$/, '');
  return frac === '' ? `${whole}` : `${whole}.${frac}`;
}

function row(label: string, value: string): void {
  console.log(`  ${label.padEnd(26)}${value}`);
}

export async function status(env: NodeJS.ProcessEnv): Promise<number> {
  const config = fold(
    loadDaemonConfig(env),
    (v) => v,
    (f) => {
      console.error(`configuration: ${f.detail}`);
      return null;
    },
  );
  if (config === null) return 1;

  const client = new SuiGrpcClient({ network: 'mainnet', baseUrl: config.grpcUrl });

  const epochReading = await readCurrentEpoch(client);
  const epoch = fold(
    epochReading,
    (e) => e,
    (f) => {
      console.error(`epoch: ${f.kind} — ${f.detail}`);
      return null;
    },
  );
  if (epoch === null) return 1;

  console.log(`\nSui mainnet · epoch ${epoch}\n`);

  const discovery = await discoverVaults(client, config.packageId, config.maxDiscoveryPages);
  if (!discovery.ok) {
    console.error(`discovery: ${discovery.failure.kind} — ${discovery.failure.detail}`);
    return 1;
  }
  if (discovery.value.truncated) {
    console.log('  NOTE: vault list is partial — the page ceiling was reached.\n');
  }
  if (discovery.value.vaults.length === 0) {
    console.log('  No stake vault has been opened. The event log was read and is empty.\n');
    return 0;
  }

  let exit = 0;
  for (const found of discovery.value.vaults) {
    const reading = await readStakeVault(client, found.vaultId);
    if (!reading.ok) {
      // A vault we could not read is not a vault with nothing in it.
      console.log(`  ${found.vaultId}`);
      // The kind, its sentence and what to do next — so an operator reading this at 2am is told
      // whether to wait, retry or stop without opening the SDK.
      console.log(
        `    NOT MEASURED — ${reading.failure.kind} (${describeFailureKind(reading.failure.kind)}; ` +
          `${retryAdvice(reading.failure.kind)}): ${reading.failure.detail}\n`,
      );
      exit = 1;
      continue;
    }
    const v = reading.value;
    const staked = v.tranches.reduce((a, t) => a + t.principalMist, 0n);
    const backing = v.liquidMist + staked;

    console.log(`  ${v.vaultId}`);
    row('creator', v.creator);
    row('validator', v.validator);
    row('principal owed', `${sui(v.totalPrincipalMist)} SUI`);
    row('backing (liquid + staked)', `${sui(backing)} SUI`);
    row('solvent', backing >= v.totalPrincipalMist ? 'yes' : 'NO — investigate');
    row('tranches', `${v.tranches.length} of ${Number(LADDER_DEPTH) + 1} rungs`);
    row('ladder capture', `${(ladderCaptureBps(v) / 100).toFixed(2)}%`);
    row('realised yield', `${sui(v.lifetimeYieldMist)} SUI`);
    row('  → creator', `${sui(v.creatorYieldMist)} SUI`);
    row('  → platform', `${sui(v.platformYieldMist)} SUI`);
    row('harvests run', v.harvests.toString());

    for (const t of v.tranches) {
      const matures = t.activationEpoch + LADDER_DEPTH;
      const ready = epoch >= matures;
      row(
        `tranche ${sui(t.principalMist)} SUI`,
        `activated ${t.activationEpoch} · matures ${matures} · ${
          ready ? 'MATURE — harvest to realise it' : `${matures - epoch} epochs away`
        }`,
      );
    }

    const decision = decideHarvest(v, epoch);
    row('harvest now would', decision.act ? `act — ${decision.reason}` : `skip — ${decision.reason}`);

    /*
      The one thing a block query cannot tell you on its own.

      Rewards accrue inside the StakedSui object; `lifetime_yield` is only written by the harvest
      that withdraws it. So a vault whose ladder is working perfectly still reads zero here until
      something harvests after maturity — indistinguishable, from this number alone, from the
      defect that produced 22 consecutive zero harvests on the predecessor.
    */
    if (v.lifetimeYieldMist === 0n) {
      const next = nextActionableEpoch(v);
      if (next !== null && epoch >= next) {
        console.log(
          '\n    A tranche is mature and realised yield is still zero. Run one harvest: if it\n' +
            '    stays zero afterwards, that is the ladder defect and it is now a measurement.',
        );
      } else if (next !== null) {
        console.log(
          `\n    Realised yield is zero because nothing has matured yet, not because nothing is\n` +
            `    earning. Re-check after epoch ${next}, then harvest once to realise it.`,
        );
      }
    }
    console.log();
  }
  return exit;
}
