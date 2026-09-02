// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The harvest signer, behind the policy signer.
 *
 * # Why a daemon that only ever harvests still signs through a policy
 *
 * The harvest key used to sign whatever this adapter built. That was one function, and the function
 * was right, so the key was safe exactly as long as this file stayed right. A policy moves the bound
 * out of the code and into a document the signer checks on every call: the only target this key may
 * call is `stake_vault::harvest`, the only objects it may touch are the vault being harvested and
 * the system state, the only coin that may leave it is the gas it pays, and never more than the
 * configured budget. A future edit to this file that built a different transaction would be
 * refused by the policy and written down as a refusal.
 *
 * # One audit chain for the whole run
 *
 * Every decision — every harvest signed and every refusal — goes into one hash-chained `AuditLog`
 * shared by every vault the run touches. Its head hash is what the journal anchors per run
 * (`db/002_audit_anchor.sql`): a chain is tamper-evident on its own only against partial edits, and
 * an anchor written to a store the process does not own is what makes a rewritten chain detectable
 * after the fact. The signer package says as much in its own header and leaves the anchor to the
 * deployment; this is the deployment.
 *
 * # Per-vault policies, one hash each
 *
 * `allowedObjects` must name the vault, and the vault is chosen per call, so the policy document is
 * built per vault from one template. Each audit entry carries the hash of the document that judged
 * it, so a reader can rebuild the exact policy for any entry from the vault id and the configuration.
 *
 * # Simulation
 *
 * The policy signer simulates before it decides: it reads the effects through the signer package's
 * evidence reader and confirms success through the SDK's own `simulate` gate, which is the decoder
 * that knows `FailedTransaction`. Nothing here decodes a simulation by hand — that copy was wrong
 * once (see `test/one-simulation-decoder.test.ts`) and it is not coming back.
 */
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { classify, fail, ok, type Reading } from '@projectx-social/sdk';
import { type LedgerState, type PolicyDoc } from '@projectx-social/policy';
import {
  AuditLog,
  GENESIS_HASH,
  localKeypairSignerFromSecret,
  policySigner,
  type Signer,
} from '@projectx-social/signer';

const SUI_SYSTEM_STATE_ID = '0x5';
const SUI_TYPE = '0x2::sui::SUI';

/** What the journal anchors at the end of a run. */
export interface AuditHead {
  /** The chain head, 64 hex characters; {@link GENESIS_HASH} when nothing was decided. */
  headHash: string;
  /** How many decisions the chain holds. */
  entries: number;
  /** Whether the chain verifies from genesis to head at the moment of reading. */
  intact: boolean;
}

export interface HarvestSigner {
  address: string;
  simulateAndHarvest(vaultId: string): Promise<Reading<string>>;
  /** The audit chain's head at this moment. Cheap; read it after every tick. */
  auditHead(): AuditHead;
}

/**
 * The policy a harvest of `vaultId` is judged by.
 *
 * Exported so a test can pin its shape and so a reader can rebuild the hash an audit entry names.
 * The gas ceiling doubles as the outflow ceiling: a harvest moves no coin of the signer's except
 * the gas it burns, so "no more than one budget of SUI may leave per call" is exactly the bound.
 */
export function harvestPolicy(input: {
  address: string;
  latestPackageId: string;
  vaultId: string;
  gasBudgetMist: bigint;
}): PolicyDoc {
  return {
    version: 1,
    agentAddress: input.address,
    outflowCeilings: [{ coinType: SUI_TYPE, maxPerPeriod: input.gasBudgetMist.toString(), periodMs: 60_000 }],
    allowedTargets: [`${input.latestPackageId}::stake_vault::harvest`],
    allowedTypeArguments: [],
    allowedRecipients: [],
    allowedObjects: [input.vaultId, SUI_SYSTEM_STATE_ID],
    maxGasBudgetMist: input.gasBudgetMist.toString(),
    allowedCommandKinds: ['MoveCall'],
  };
}

/** The one transaction this key ever signs, before sender and budget are set. */
export function harvestTransaction(latestPackageId: string, vaultId: string): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    // public fun harvest(vault: &mut StakeVault, state: &mut SuiSystemState, ctx: &mut TxContext)
    target: `${latestPackageId}::stake_vault::harvest`,
    arguments: [tx.object(vaultId), tx.object(SUI_SYSTEM_STATE_ID)],
  });
  return tx;
}

/** No prior spend is tracked across calls; the ceiling bounds each call on its own. */
const noLedger = (): LedgerState => ({ nowMs: Date.now(), spend: [] });

export function createSigner(
  client: SuiGrpcClient,
  secret: string,
  gasBudgetMist: bigint,
  latestPackageId: string,
): Reading<HarvestSigner> {
  const inner = localKeypairSignerFromSecret(secret);
  if (!inner.ok) {
    // The failure detail from the signer package is written not to quote the input; this line
    // deliberately does not add anything of its own either. A malformed key is still a key.
    return fail(
      'unconfigured',
      'harvest signer',
      'the signing secret could not be decoded as a Sui private key. Its value is deliberately not shown.',
    );
  }
  return ok(harvestSignerOver(inner.value, client, gasBudgetMist, latestPackageId));
}

/**
 * The signer over an already-built inner signer. Separated from {@link createSigner} so a test can
 * hand in a key it generated and a simulation it controls, without a bech32 secret on disk.
 */
export function harvestSignerOver(
  inner: Signer,
  client: SuiGrpcClient,
  gasBudgetMist: bigint,
  latestPackageId: string,
  options: {
    simulation?: Parameters<typeof policySigner>[0]['simulation'];
    /**
     * The harvest transaction for a vault. Defaults to {@link harvestTransaction}, which leaves the
     * object references and the gas payment to be resolved against the chain at build time. A test
     * hands in a fully specified one so nothing is resolved over the network.
     */
    transaction?: (vaultId: string) => Transaction;
  } = {},
): HarvestSigner {
  const address = inner.address;
  const audit = new AuditLog();

  return {
    address,
    auditHead: () => ({ headHash: audit.headHash, entries: audit.entries.length, intact: audit.verify().intact }),
    async simulateAndHarvest(vaultId: string): Promise<Reading<string>> {
      const source = `harvest ${vaultId}`;
      try {
        const tx = options.transaction === undefined ? harvestTransaction(latestPackageId, vaultId) : options.transaction(vaultId);
        tx.setSender(address);
        tx.setGasBudget(gasBudgetMist);

        const gate = policySigner({
          inner,
          policy: harvestPolicy({ address, latestPackageId, vaultId, gasBudgetMist }),
          client,
          ledger: noLedger,
          audit,
          ...(options.simulation === undefined ? {} : { simulation: options.simulation }),
        });

        // --- Simulated, judged and recorded inside the gate. Nothing is signed unless it allows. ---
        const signed = await gate.signTransaction(tx);
        if (!signed.ok) return fail(signed.failure.kind, source, signed.failure.detail);

        // --- Only now is anything submitted. ---
        const result = await client.executeTransaction({
          transaction: signed.value.bytes,
          signatures: [signed.value.signature],
        });
        /*
          Read through every envelope this client has been observed to use rather than the one that
          happens to be current: the gRPC client once wrapped its payload as `{ $kind: 'Transaction',
          Transaction: { … } }` and `result.transaction.digest` was `undefined` for a transaction that
          had landed. The daemon recorded that success as a failure.
        */
        const executed = result as {
          Transaction?: { digest?: unknown };
          transaction?: { digest?: unknown };
          digest?: unknown;
        };
        const digest = executed.Transaction?.digest ?? executed.transaction?.digest ?? executed.digest;
        if (typeof digest !== 'string' || digest === '') {
          // Submitted, but we cannot name what we submitted. Reported as a failure so a caller
          // does not record a harvest it cannot point at — the transaction may well have landed.
          return fail(
            'malformed',
            source,
            'the transaction was submitted but the node returned no digest; ' +
              'check the chain before retrying, as it may have succeeded',
          );
        }
        return ok(digest);
      } catch (error) {
        const failure = classify(error, source);
        return fail(failure.kind, source, failure.detail);
      }
    },
  };
}

/** The head a signer that never decided anything reports. */
export const EMPTY_AUDIT_HEAD: AuditHead = { headHash: GENESIS_HASH, entries: 0, intact: true };
