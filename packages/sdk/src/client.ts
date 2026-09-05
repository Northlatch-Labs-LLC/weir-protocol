// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The chain client: gRPC transport, reads that cannot lie, and simulate-before-sign.
 *
 * # gRPC is not a preference
 */

import { decodeObjectBytes } from './objectbytes.js';
import { bcs } from '@mysten/sui/bcs';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import type { Transaction } from '@mysten/sui/transactions';
import type { ProjectXSocialConfig } from './config.js';
import { classify, fail, ok, type Reading } from './reading.js';

export function createClient(config: ProjectXSocialConfig): SuiGrpcClient {
  return new SuiGrpcClient({ network: config.network, baseUrl: config.grpcUrl });
}

/**
 * BCS layout of `platform::Platform`.
 *
 * gRPC returns object contents as **raw BCS bytes**, not parsed fields — so this layout must match
 * the Move struct's field order exactly. BCS is positional and carries no field names: reorder two
 * `u64`s in the Move struct and this decoder keeps working while silently returning the fee as the
 * referral share.
 *
 * `test/drift.test.ts` therefore asserts this order against `platform.move` directly. Do not edit
 * one without the other.
 *
 * ```move
 * public struct Platform has key {
 *     id: UID,                    // 32 bytes
 *     version: u64,
 *     fee_bps: u64,
 *     referral_share_bps: u64,
 *     creation_fee_mist: u64,
 *     creation_paused: bool,
 *     payments_paused: bool,
 *     treasury: Balance<SUI>,     // a single u64
 *     accounts_created: u64,
 *     vaults_created: u64,
 * }
 * ```
 */
const PlatformBcs = bcs.struct('Platform', {
  id: bcs.Address,
  version: bcs.u64(),
  feeBps: bcs.u64(),
  referralShareBps: bcs.u64(),
  creationFeeMist: bcs.u64(),
  creationPaused: bcs.bool(),
  paymentsPaused: bcs.bool(),
  treasury: bcs.u64(),
  accountsCreated: bcs.u64(),
  vaultsCreated: bcs.u64(),
});

/** The field order above, exported so the drift test can compare it with the Move source. */
export const PLATFORM_BCS_FIELDS = [
  'id',
  'version',
  'fee_bps',
  'referral_share_bps',
  'creation_fee_mist',
  'creation_paused',
  'payments_paused',
  'treasury',
  'accounts_created',
  'vaults_created',
] as const;

/**
 * Normalise whatever the transport hands back into bytes.
 *
 * The gRPC client may return a `Uint8Array` or, after a JSON round trip, an object with numeric
 * keys. Both are accepted; anything else is a shape this SDK does not understand and is reported
 * as `malformed` rather than coerced into an empty buffer that would decode to all zeros.
 */
/**
 * One decoder for every object read in this package — `decodeObjectBytes` in objectbytes.ts —
 * so a transport that answers base64, a byte array or an array-like object is read the same way
 * here as everywhere else. Until 2026-09-02 this file carried its own reader that accepted a
 * subset of those shapes, and a platform answered as the other shape was reported "malformed:
 * no decodable content" (the read fails CLOSED, never wrong, but a page said "not measured" for a
 * value the node had sent). A decode failure is `null` here, which every caller below already
 * reports as malformed with the source named.
 */
function toBytes(content: unknown): Uint8Array | null {
  const decoded = decodeObjectBytes(content, 'platform');
  return decoded.ok ? decoded.value : null;
}

/** Fields of `platform::Platform`, as they appear on chain. */
export interface PlatformState {
  version: bigint;
  feeBps: bigint;
  referralShareBps: bigint;
  creationFeeMist: bigint;
  creationPaused: boolean;
  paymentsPaused: boolean;
  treasuryMist: bigint;
  accountsCreated: bigint;
  vaultsCreated: bigint;
}

/**
 * Read the platform's live economic terms.
 *
 * Every quantity a UI shows about fees must come from here rather than from a constant. The fee is
 * an on-chain value that a capability holder can change; a hardcoded "2.9%" in a component is
 * wrong the moment it does, and wrong silently.
 */
export async function readPlatform(
  client: SuiGrpcClient,
  config: ProjectXSocialConfig,
): Promise<Reading<PlatformState>> {
  const source = `Platform ${config.platformId}`;
  try {
    const response = await client.getObject({
      objectId: config.platformId,
      include: { content: true },
    });

    const object = (response as { object?: { content?: unknown; objectId?: string } }).object;
    if (object === undefined || object === null) {
      return fail('not-found', source, 'no object exists at that id on this network');
    }

    const bytes = toBytes(object.content);
    if (bytes === null) {
      return fail(
        'malformed',
        source,
        'the object carried no decodable content — request it with include: { content: true }',
      );
    }

    // Reject a short buffer before decoding. BCS is positional and will happily read past the end
    // of a truncated payload or misinterpret a different struct entirely; the length check turns
    // "wrong object id" into a clear failure instead of a Platform full of plausible numbers.
    const MIN_BYTES = 32 + 8 * 4 + 1 + 1 + 8 * 3;
    if (bytes.length < MIN_BYTES) {
      return fail(
        'malformed',
        source,
        `content is ${bytes.length} bytes, expected at least ${MIN_BYTES} — ` +
          `the id probably names something that is not a Platform`,
      );
    }

    const decoded = PlatformBcs.parse(bytes);

    // The decoded id must be the object we asked for. If it is not, we decoded a different
    // struct that happened to be long enough, and every field after it is meaningless.
    if (BigInt(decoded.id) !== BigInt(config.platformId)) {
      return fail(
        'malformed',
        source,
        `decoded id ${decoded.id} does not match the requested id — not a Platform`,
      );
    }

    return ok({
      version: BigInt(decoded.version),
      feeBps: BigInt(decoded.feeBps),
      referralShareBps: BigInt(decoded.referralShareBps),
      creationFeeMist: BigInt(decoded.creationFeeMist),
      creationPaused: decoded.creationPaused,
      paymentsPaused: decoded.paymentsPaused,
      treasuryMist: BigInt(decoded.treasury),
      accountsCreated: BigInt(decoded.accountsCreated),
      vaultsCreated: BigInt(decoded.vaultsCreated),
    });
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

/**
 * Read a coin's decimals from its `CoinMetadata`.
 *
 * **Never assume this value.** Assuming 9 for a 6-decimal coin is wrong by a factor of a thousand,
 * in the direction nobody checks. If the metadata cannot be read, the correct behaviour is to
 * refuse to format or parse an amount — which is why this returns a `Reading` and there is no
 * fallback.
 */
export async function readDecimals(
  client: SuiGrpcClient,
  coinType: string,
): Promise<Reading<number>> {
  const source = `CoinMetadata for ${coinType}`;
  try {
    const response = await client.getCoinMetadata({ coinType });
    const decimals = (response as { coinMetadata?: { decimals?: unknown } }).coinMetadata?.decimals;

    if (decimals === undefined || decimals === null) {
      return fail(
        'not-found',
        source,
        'no metadata published for this coin type; refusing to guess its decimals',
      );
    }

    const value = Number(decimals);
    if (!Number.isInteger(value) || value < 0 || value > 38) {
      return fail('malformed', source, `decimals was ${String(decimals)}`);
    }

    return ok(value);
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

export interface SimulationOutcome {
  /** True when the transaction would succeed as built. */
  wouldSucceed: boolean;
  /** Raw status text from the node. Shown unmodified when it cannot be explained confidently. */
  status: string;
  /** Present only when the simulation failed. */
  abort?: DecodedAbort;
}

export interface DecodedAbort {
  module: string;
  code: number;
  explanation: string | null;
  /** The unmodified error text, always. */
  raw: string;
}

/**
 * Simulate a transaction. **Call this before offering to sign anything.**
 *
 * On a chain, an abort discovered after signing has already cost gas — and a *success* discovered
 * after signing may have moved money somewhere unintended. Neither is recoverable by retrying.
 */
/** The `{ success, error }` pair a node reports for a simulated transaction. */
export interface SimulationStatus {
  success?: boolean;
  error?: string | null;
}

/**
 * The one place that knows where a simulation's status lives.
 *
 * # Why this is a function and not four lines at the call site
 *
 * It was four lines at the call site, in more than one call site, and they disagreed. The daemon's
 * `adapters/signer.ts` carried its own copy that read `Transaction.status` and the legacy
 * `transaction.effects.status` — and NOT `FailedTransaction`. A successful simulation was decoded
 * correctly there; a genuine Move abort found no status at all and was reported as
 * "a client/server shape mismatch, not a rejected transaction", which is the opposite of what had
 * happened. It failed closed, so nothing was signed, and it wrote down the wrong reason for ever.
 *
 * Duplicating a decoder duplicates the shape it was written against, and only one copy gets fixed
 * when that shape moves. This client has already changed underneath this code once.
 *
 * # The envelopes, measured rather than read from documentation
 *
 * On `@mysten/sui` 2.27.1 against mainnet:
 *
 *     success -> { $kind: 'Transaction',       Transaction:       { status: { success: true } } }
 *     abort   -> { $kind: 'FailedTransaction', FailedTransaction: { status: { … } } }
 *     legacy  -> { transaction: { effects: { status: … } } }   (JSON-RPC, older nodes)
 *
 * # Why every level is checked before it is indexed
 *
 * `shape.Transaction?.status` guards `Transaction` being **undefined**. It does not guard it being
 * literally `null`: a node answering `{"Transaction": null}` would throw a TypeError inside the
 * caller's `try`, which returns `fail('transport', …)` — telling the caller to retry something
 * permanent. A `transport` label on a condition that reproduces for ever is worse than no label.
 *
 * Returns `undefined` when no status is found anywhere. The caller must treat that as REFUSAL:
 * "no status" is not permission to sign.
 */
export function simulationStatus(result: unknown): SimulationStatus | undefined {
  const { grpc, legacyEffects } = simulationEnvelope(result);
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;
  const grpcStatus =
    grpc !== undefined && isObject(grpc['status']) ? (grpc['status'] as SimulationStatus) : undefined;
  const legacyStatus =
    legacyEffects !== undefined && isObject(legacyEffects['status'])
      ? (legacyEffects['status'] as SimulationStatus)
      : undefined;
  return grpcStatus ?? legacyStatus;
}

/**
 * The two envelopes a simulation can arrive in, unwrapped once.
 *
 * # Why this is exported rather than kept inside `simulationStatus`
 *
 * A caller that needs the status ALSO needs `effects.gasUsed` and `balanceChanges` off the same
 * response, and until this existed the only way to reach them was to unwrap the envelope again by
 * hand. Sixteen places in `packages/web` did exactly that, every one of them as
 * `sim.Transaction` followed by `result?.effects?.status ?? result?.status` — which reads the
 * SUCCESS envelope only, so a genuine abort produced `undefined` and was reported as
 * "no status returned" rather than as the reason the chain gave.
 *
 * Handing back the unwrapped envelope is what makes the duplication unnecessary. A caller reads
 * the status through `simulationStatus` and everything else through `grpc`, and neither of them
 * needs to know that `FailedTransaction` exists.
 *
 * `legacyEffects` is the JSON-RPC shape, kept because a deployment may still be answering it. Note
 * that `grpc.effects.status` is NOT a path — see the note above `simulationStatus`: on the gRPC
 * shape it is always `undefined`, and reading it first means running on a fallback while the code
 * says otherwise.
 */
export function simulationEnvelope(result: unknown): {
  grpc: Record<string, unknown> | undefined;
  legacyEffects: Record<string, unknown> | undefined;
} {
  const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null;
  const envelope: Record<string, unknown> = isObject(result) ? result : {};
  const grpc = isObject(envelope['Transaction'])
    ? envelope['Transaction']
    : isObject(envelope['FailedTransaction'])
      ? envelope['FailedTransaction']
      : undefined;
  const legacy = isObject(envelope['transaction']) ? envelope['transaction'] : undefined;
  const legacyEffects =
    legacy !== undefined && isObject(legacy['effects']) ? legacy['effects'] : undefined;
  return { grpc, legacyEffects };
}

export async function simulate(
  client: SuiGrpcClient,
  transaction: Transaction,
  sender: string,
): Promise<Reading<SimulationOutcome>> {
  try {
    transaction.setSenderIfNotSet(sender);
    const bytes = await transaction.build({ client });
    const result = await client.simulateTransaction({ transaction: bytes });

    /*
      The status lives at `Transaction.status` — capital T, and NO `effects` in the path.

      This read was `transaction.effects.status`, which is the JSON-RPC shape and is not what the
      gRPC client returns. It therefore resolved to `undefined` on every call, and `undefined` is
      not `true`, so **every simulation reported `wouldSucceed: false` for a transaction that
      would have succeeded.** The daemon hit this in production — every harvest was journalled as
      a failed simulation, nothing was ever submitted, and the process exited 0 looking healthy.
      It was fixed there on 2026-08-30 and left wrong here, in the package third parties import.

      Measured against mainnet on `@mysten/sui` 2.27.1, not read from documentation:

        sim.Transaction.status          -> {"success":true,"error":null}
        sim.Transaction.effects.status  -> undefined
        sim.transaction.effects.status  -> undefined

      The JSON-RPC path is kept as a fallback rather than deleted: it costs one `??` and it is the
      shape an older node still speaks.
    */
    /*
      Read defensively, because optional chaining does not do what it looks like it does here.

      `shape.Transaction?.status` guards `Transaction` being **undefined**. It does not guard
      `Transaction` being literally `null` — `null?.status` is fine, but a node that answers
      `{"Transaction": null}` and a reader that then indexes further would throw a TypeError
      *inside* the `try`, and this function would return `fail('transport', …)`. That is the wrong
      answer twice over: nothing is retryable about it, and `transport` tells the caller to retry
      something that will reproduce for ever.

      So each level is checked for being an object before it is indexed. The cost is four lines;
      the alternative is a permanent condition wearing a transient's name.
    */
    const status = simulationStatus(result);

    /*
      An unrecognised shape REFUSES, and must keep refusing.

      Treating "no status found" as permission to sign is how a client library's rename turns into
      money moving with no simulation behind it — the exact gate this function exists to be. It is
      `malformed` rather than `transport` because retrying reproduces it exactly.
    */
    if (status === undefined) {
      return fail(
        'malformed',
        'simulateTransaction',
        'the simulation response carried no status field, so it could not be shown to have ' +
          'succeeded. Nothing was submitted. This is a client/server shape mismatch, not a ' +
          'rejected transaction.',
      );
    }

    if (status.success === true) {
      return ok({ wouldSucceed: true, status: 'success' });
    }

    /*
      `status.error` is a STRUCTURED object over gRPC, not a string. Passing it to `decodeAbort`
      stringifies it to `[object Object]`, which parses to module `unknown` and code `-1` — an
      abort reported as unrecognisable when the node named it precisely. Serialise it first, and
      keep the serialised form as the raw text so nothing is lost on the way to the reader.
    */
    const raw = typeof status.error === 'string' ? status.error : JSON.stringify(status.error ?? status);
    return ok({ wouldSucceed: false, status: raw, abort: decodeAbort(raw) });
  } catch (error) {
    return fail('transport', 'simulateTransaction', classify(error, 'simulate').detail);
  }
}

/**
 * A raw abort code is not information; the sentence explaining it is. But a *wrong* explanation is
 * worse than an opaque one, because an opaque one can be searched for — so anything not confidently
 * recognised returns `explanation: null` and the untouched `raw` text.
 *
 * # The format this parses, quoted from a real mainnet abort
 *
 * ```
 * MoveAbort in 2nd command, abort code: 5, in '0xc5c8…::stake_vault::deposit' (instruction 55)
 * ```
 */
export function decodeAbort(raw: string): DecodedAbort {
  // `abort code: N` — the only place a code appears, and never confusable with an ordinal.
  const codeMatch = /abort code:\s*(\d+)/i.exec(raw);
  // The module is the second segment of the fully-qualified function inside the quotes.
  const moduleMatch = /0x[0-9a-fA-F]+::(\w+)::\w+/.exec(raw);

  const code = codeMatch?.[1] !== undefined ? Number(codeMatch[1]) : -1;
  const moduleName = moduleMatch?.[1] ?? 'unknown';

  const table = ABORT_EXPLANATIONS[moduleName];
  const explanation = table?.[code] ?? null;

  return { module: moduleName, code, explanation, raw };
}

/**
 * Abort-code explanations, mirrored from the Move sources.
 *
 * Only codes whose meaning is unambiguous are listed. An unlisted code renders as the raw text
 * rather than a guess.
 */
export const ABORT_EXPLANATIONS: Record<string, Record<number, string>> = {
  platform: {
    1: 'The platform object is on an older schema than the package. Run platform::migrate.',
    2: 'That capability governs a different platform — check you are on the right deployment.',
    3: 'The requested fee is above the compiled ceiling (30% platform, 50% referral share).',
    4: 'Account and vault creation is paused on this platform.',
    5: 'Payments are paused on this platform. Claims and withdrawals are unaffected.',
    6: 'The SUI supplied does not cover the creation fee.',
    7: 'The treasury holds less than the amount requested.',
  },
  account: {
    1: 'Handle must be 3 to 30 characters.',
    2: 'Handle may only contain lowercase letters, digits and underscores.',
    3: 'That handle is already taken.',
    4: 'This address already has an account. One account per address.',
    5: 'That account belongs to a different address.',
    6: 'That account was opened on a different platform deployment.',
    7: 'An account cannot refer itself.',
  },
  creator: {
    1: 'This vault is on an older schema than the package. It needs migrating before it can be used.',
    // Reached by the earnings page the moment a creator owns more than one vault: a CreatorCap is
    // bound to a single vault and `assert_cap` checks the binding, so the cap for vault A aborts
    // against vault B. Worth a sentence rather than a code, because "abort 2" tells a creator
    // nothing about why their own money would not come out.
    2: 'That capability governs a different vault. Each CreatorCap is bound to the vault it was issued with.',
    3: 'That vault was opened on a different platform deployment.',
    4: 'This creator is not currently accepting payments.',
    5: 'The coin supplied does not cover the price.',
    6: 'No tier exists at that index.',
    7: 'That tier has been retired by the creator.',
    8: 'This vault already has the maximum number of tiers.',
    9: 'The tier period is outside the allowed range: at least thirty days, at most about ten years.',
    10: 'A price must be greater than zero. Unpriced means not for sale, never free.',
    11: 'The tip is below this creator’s minimum.',
    12: 'This content is not for sale.',
    13: 'A creator cannot pay their own vault.',
    14: 'The balance holds less than the amount claimed.',
    // Until v4 the contract reported a non-holder presenting someone else's Subscription under this
    // same code (creator.move `renew`); that reading now has its own code, 20, below.
    15: 'That subscription belongs to a different vault.',
    16: 'A name or content key cannot be empty.',
    17: 'Nothing to migrate: this vault already matches the package version.',
    18: 'A tier period must be a whole number of 30-day Seal periods.',
    19: 'Tier prices must ascend with the tier index: a higher tier cannot cost less than a lower one.',
    21: 'That Seal identity is not the one this vault, tier and period produce.',
    22: 'That tier costs more than this subscription pays per period, so its key is not released.',
    23: 'That period is outside what this subscription paid for.',
    20: 'That subscription is not yours to renew.',
  },
  stake_vault: {
    4: 'This vault is not accepting new deposits. Withdrawals are unaffected.',
    5: 'Deposit is below the one SUI minimum.',
    6: 'No deposit position exists for this address.',
    7: 'You cannot withdraw more principal than you deposited.',
    8: 'The balance holds less than the amount claimed.',
    9: 'A rebate above 100% of the creator’s own yield was requested.',
    10: 'Solvency check failed — this should be unreachable. Do not retry; report it.',
    11: 'The vault could not raise enough liquidity even after unwinding the ladder.',
  },
};
