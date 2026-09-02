// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * Reading a `StakeVault` and a depositor's position off chain.
 *
 * # Why this lives in the SDK and not in the daemon
 *
 * It was in the daemon, because the daemon was the only thing that read a stake vault. Now the web
 * application reads one too — to show a depositor their principal and a creator their yield — and
 * the alternative to moving it was a second BCS decoder for the same struct.
 *
 * A duplicated positional decoder is the specific hazard this codebase guards against everywhere
 * else: insert a field in `StakeVault` and one copy gets fixed while the other silently returns
 * `rebate_bps` as the validator address. One decoder, one layout test.
 *
 * The daemon keeps its own domain types. `VaultSnapshot` is what the harvest DECISION needs and is
 * deliberately a plain value with no client and no clock; what is decoded here is the chain's
 * shape. They happen to overlap, and they are not the same concern.
 *
 * # Every byte offset below is a mirror
 *
 * gRPC returns object contents as raw BCS — positional, with no field names. A mirror that goes
 * stale is silent and total. `test/stakevault-layout.test.ts` asserts this against
 * `stake_vault.move` directly and decodes a synthetic buffer to prove the offsets.
 *
 * # What is deliberately not here
 *
 * No signing, no key material, no submission. This reads. A compromised reader cannot spend
 * anything.
 */

import { decodeObjectBytes } from './objectbytes.js';
import { bcs } from '@mysten/sui/bcs';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { deriveDynamicFieldID } from '@mysten/sui/utils';
import { classify, fail, ok, type Reading } from './reading.js';

/** One tranche of delegated principal, as read from the vault. */
export interface Tranche {
  /** The epoch this stake becomes active. Sui stamps `current + 1` at staking time. */
  activationEpoch: bigint;
  /** Principal delegated, in MIST. */
  principalMist: bigint;
}

/**
 * `sui_system::staking_pool::StakedSui`, as laid out in BCS.
 *
 * ```move
 * public struct StakedSui has key, store {
 *     id: UID,                        // 32
 *     pool_id: ID,                    // 32
 *     stake_activation_epoch: u64,    //  8
 *     principal: Balance<SUI>,        //  8
 * }
 * ```
 * Eighty bytes each. This is a framework type, so it moves only with a framework upgrade — but it
 * is still a mirror, and the layout test pins the size.
 */
const StakedSuiBcs = bcs.struct('StakedSui', {
  id: bcs.Address,
  poolId: bcs.Address,
  stakeActivationEpoch: bcs.u64(),
  principal: bcs.u64(),
});

/** Serialized size of one `StakedSui`, asserted by the layout test. */
export const STAKED_SUI_BYTES = 80;

/**
 * `stake_vault::StakeVault`.
 *
 * A `Table<K, V>` serialises as `{ id: UID, size: u64 }` — 40 bytes — because the entries live in
 * dynamic fields rather than inline. `Balance<T>` is a bare `u64`.
 *
 * Field order here must match the Move struct exactly. See the header.
 */
const StakeVaultBcs = bcs.struct('StakeVault', {
  id: bcs.Address,
  version: bcs.u64(),
  platform: bcs.Address,
  creator: bcs.Address,
  creatorAccount: bcs.Address,
  feeBpsSnapshot: bcs.u64(),
  rebateBps: bcs.u64(),
  validator: bcs.Address,
  totalPrincipal: bcs.u64(),
  positions: bcs.struct('Table', { id: bcs.Address, size: bcs.u64() }),
  tranches: bcs.vector(StakedSuiBcs),
  liquid: bcs.u64(),
  creatorYield: bcs.u64(),
  platformYield: bcs.u64(),
  rebatePool: bcs.u64(),
  accRebatePerUnit: bcs.u128(),
  accepting: bcs.bool(),
  lifetimeYield: bcs.u64(),
  harvests: bcs.u64(),
});

/** The field order above, exported so the layout test can compare it with the Move source. */
export const STAKE_VAULT_BCS_FIELDS = [
  'id',
  'version',
  'platform',
  'creator',
  'creator_account',
  'fee_bps_snapshot',
  'rebate_bps',
  'validator',
  'total_principal',
  'positions',
  'tranches',
  'liquid',
  'creator_yield',
  'platform_yield',
  'rebate_pool',
  'acc_rebate_per_unit',
  'accepting',
  'lifetime_yield',
  'harvests',
] as const;

/** Everything the daemon reads from a vault, beyond what the decision needs. */
export interface StakeVaultState {
  vaultId: string;
  /** The struct's own `version`, bumped by `migrate`. Not the object version Sui tracks. */
  version: bigint;
  tranches: readonly Tranche[];
  /** Undelegated principal held by the vault, in MIST. */
  liquidMist: bigint;
  totalPrincipalMist: bigint;
  creator: string;
  validator: string;
  accepting: boolean;
  creatorYieldMist: bigint;
  platformYieldMist: bigint;
  rebatePoolMist: bigint;
  lifetimeYieldMist: bigint;
  harvests: bigint;
  /** Fixed at creation. The platform cannot raise it on an existing vault. */
  feeBpsSnapshot: bigint;
  /** The depositor's share of yield, set by the creator. Starts at zero. */
  rebateBps: bigint;
  /**
   * Rebate accrued per unit of principal since the vault began, scaled by `ACC_SCALE`.
   *
   * Carried so a client can compute what a position is owed *now* — `claimableRebateMist` — rather
   * than showing the `pending` figure the vault last wrote, which is stale from the moment the next
   * harvest lands.
   */
  accRebatePerUnit: bigint;
  /**
   * The `positions` table's own id.
   *
   * Each depositor's `Position` is a dynamic field on THIS id, not on the vault's. Deriving
   * against the vault id instead returns nothing for everybody, which reads as "you have no
   * deposit" — the wrong answer, delivered confidently.
   */
  positionsTableId: string;
}

/** One depositor's stake, as the vault records it. */
export interface StakePosition {
  /** Always redeemable one for one. This is the no-loss guarantee, as a number. */
  principalMist: bigint;
  /** Rebate accrued and not yet claimed, in MIST — as of the vault's last write, not now. */
  pendingRebateMist: bigint;
  /** `principal * acc_rebate_per_unit / ACC_SCALE` at the last interaction; see the Move struct. */
  rebateDebt: bigint;
}

/**
 * One decoder for every object read in this package — `decodeObjectBytes` in objectbytes.ts —
 * so a transport that answers base64, a byte array or an array-like object is read the same way
 * here as everywhere else. Until 2026-09-02 this file carried its own reader that accepted a
 * subset of those shapes, and a stake vault answered as the other shape was reported "malformed:
 * no decodable content" (the read fails CLOSED, never wrong, but a page said "not measured" for a
 * value the node had sent). A decode failure is `null` here, which every caller below already
 * reports as malformed with the source named.
 */
function toBytes(content: unknown): Uint8Array | null {
  const decoded = decodeObjectBytes(content, 'stake vault');
  return decoded.ok ? decoded.value : null;
}

/** Decode a raw BCS buffer into vault state. Exported so the layout test can drive it directly. */
export function decodeStakeVault(bytes: Uint8Array, expectedId: string): Reading<StakeVaultState> {
  const source = `StakeVault ${expectedId}`;
  try {
    const v = StakeVaultBcs.parse(bytes);

    // The decoded id must be the object we asked for. If it is not, we decoded a different struct
    // that happened to parse, and every field after it is meaningless rather than merely wrong.
    if (BigInt(v.id) !== BigInt(expectedId)) {
      return fail('malformed', source, `decoded id ${v.id} does not match the requested id`);
    }

    const tranches: Tranche[] = v.tranches.map((t) => ({
      activationEpoch: BigInt(t.stakeActivationEpoch),
      principalMist: BigInt(t.principal),
    }));

    return ok({
      vaultId: expectedId,
      version: BigInt(v.version),
      tranches,
      liquidMist: BigInt(v.liquid),
      totalPrincipalMist: BigInt(v.totalPrincipal),
      creator: v.creator,
      validator: v.validator,
      accepting: v.accepting,
      creatorYieldMist: BigInt(v.creatorYield),
      platformYieldMist: BigInt(v.platformYield),
      rebatePoolMist: BigInt(v.rebatePool),
      lifetimeYieldMist: BigInt(v.lifetimeYield),
      harvests: BigInt(v.harvests),
      feeBpsSnapshot: BigInt(v.feeBpsSnapshot),
      rebateBps: BigInt(v.rebateBps),
      accRebatePerUnit: BigInt(v.accRebatePerUnit),
      positionsTableId: v.positions.id,
    });
  } catch (error) {
    const failure = classify(error, source);
    return fail('malformed', source, failure.detail);
  }
}

/** Read one stake vault. */
export async function readStakeVault(
  client: SuiGrpcClient,
  vaultId: string,
): Promise<Reading<StakeVaultState>> {
  const source = `StakeVault ${vaultId}`;
  try {
    const response = await client.getObject({ objectId: vaultId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;

    if (object === undefined || object === null) {
      return fail('not-found', source, 'no object exists at that id on this network');
    }

    const bytes = toBytes(object.content);
    if (bytes === null) {
      return fail('malformed', source, 'the object carried no decodable content');
    }

    return decodeStakeVault(bytes, vaultId);
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

/**
 * The current Sui epoch.
 *
 * `core.getCurrentSystemState()` is the authority, and it is on the **core** client rather than
 * the top-level one.
 */
export async function readCurrentEpoch(client: SuiGrpcClient): Promise<Reading<bigint>> {
  const source = 'current epoch';
  try {
    const response = await client.core.getCurrentSystemState();
    const epoch = (response as { systemState?: { epoch?: unknown } }).systemState?.epoch;

    if (epoch === undefined || epoch === null) {
      return fail('malformed', source, 'systemState carried no epoch');
    }

    const value = BigInt(String(epoch));
    // A zero epoch is not a real mainnet answer; it is what a silently-failed read looks like,
    // and it would make every tranche appear matured. Refuse it rather than act on it.
    if (value === 0n) {
      return fail('malformed', source, 'epoch was 0, which no live network reports');
    }
    return ok(value);
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}

/**
 * `stake_vault::Position`, as stored in the vault's `positions` table.
 *
 * ```move
 * public struct Position has store {
 *     principal: u64,
 *     rebate_debt: u128,
 *     pending: u64,
 * }
 * ```
 */
const PositionBcs = bcs.struct('Position', {
  principal: bcs.u64(),
  rebateDebt: bcs.u128(),
  pending: bcs.u64(),
});

/** A `Table<address, Position>` entry is a `Field<address, Position>`. */
const PositionFieldBcs = bcs.struct('Field', {
  id: bcs.Address,
  name: bcs.Address,
  value: PositionBcs,
});

/** Field order, exported so the layout test can compare it with the Move source. */
export const POSITION_BCS_FIELDS = ['principal', 'rebate_debt', 'pending'] as const;

/**
 * One depositor's position, or `null` when they have never deposited.
 *
 * The `null` sits inside an `ok` deliberately. "You have no deposit" and "we could not read the
 * vault" lead to opposite actions — one is an invitation to deposit, the other must not be — and a
 * page that showed a zero principal because a node was unreachable would be telling somebody their
 * money is gone.
 *
 * The entry is derived rather than searched: a `Table<address, V>` child id is a pure function of
 * the table id and the BCS-encoded address, so one read answers it with no pagination and no
 * ceiling to hit.
 *
 * **`pending` is what the vault last accrued, not what is owed right now.** The contract calls
 * `accrue` on interaction, so a rebate earned since the depositor last touched the vault is not in
 * this number. It is a lower bound, and the UI says so rather than presenting it as a total.
 */
export async function readStakePosition(
  client: SuiGrpcClient,
  positionsTableId: string,
  depositor: string,
): Promise<Reading<StakePosition | null>> {
  const source = `stake position of ${depositor}`;
  try {
    const fieldId = deriveDynamicFieldID(
      positionsTableId,
      'address',
      bcs.Address.serialize(depositor).toBytes(),
    );

    const response = await client.getObject({ objectId: fieldId, include: { content: true } });
    const object = (response as { object?: { content?: unknown } }).object;
    if (object === undefined || object === null) return ok(null);

    const bytes = toBytes(object.content);
    if (bytes === null) return fail('malformed', source, 'the position carried no content');

    const decoded = PositionFieldBcs.parse(bytes);
    if (BigInt(decoded.name) !== BigInt(depositor)) {
      return fail(
        'malformed',
        source,
        `the entry at the derived id belongs to ${decoded.name}, not ${depositor}`,
      );
    }

    return ok({
      principalMist: BigInt(decoded.value.principal),
      pendingRebateMist: BigInt(decoded.value.pending),
      rebateDebt: BigInt(decoded.value.rebateDebt),
    });
  } catch (error) {
    const failure = classify(error, source);
    if (failure.kind === 'not-found') return ok(null);
    return fail(failure.kind, source, failure.detail);
  }
}

/** `ACC_SCALE` in `stake_vault.move`: the fixed-point denominator of `acc_rebate_per_unit`. */
export const ACC_SCALE = 1_000_000_000_000n;

/**
 * What a position could claim right now — `stake_vault::claimable_rebate`, computed client-side.
 *
 * `pending` is what the vault wrote the last time this depositor touched it. Every harvest since
 * has raised `acc_rebate_per_unit` without touching their entry, so `pending` alone understates
 * what they are owed by exactly `principal * (acc - acc_at_last_touch) / ACC_SCALE`. The contract
 * keeps `rebate_debt` so that difference is one subtraction. Same arithmetic, same integer
 * division, same clamp when `entitled` has not yet caught up to the debt, so this agrees with the
 * contract to the MIST.
 *
 * This is the settled-position path of `claimable_rebate` — the contract additionally discounts a
 * `Fresh` deposit made since the last harvest, which lives in a dynamic field this decoder does
 * not read. For such a position this can overstate until the next harvest settles it.
 */
export function claimableRebateMist(position: StakePosition, accRebatePerUnit: bigint): bigint {
  const entitled = (position.principalMist * accRebatePerUnit) / ACC_SCALE;
  if (entitled <= position.rebateDebt) return position.pendingRebateMist;
  return position.pendingRebateMist + (entitled - position.rebateDebt);
}

/** One entry of a vault's `positions` table, with the address it is keyed by. */
export interface StakeMember extends StakePosition {
  depositor: string;
}

export interface StakeMembers {
  members: StakeMember[];
  /** True when the page ceiling stopped the walk: these are some members, not all of them. */
  truncated: boolean;
}

const MEMBERS_PAGE = 100;
const MEMBERS_MAX_PAGES = 50;

/** One page of the walk — the fields of the node's answer this function actually reads. */
interface PositionsPage {
  dynamicFields: ReadonlyArray<{ name: { bcs: Uint8Array }; value?: { bcs: Uint8Array } }>;
  cursor: string | null;
  hasNextPage: boolean;
}

/** `Position` alone is 32 bytes; wrapped in its `Field<address, Position>` it is 96. */
const POSITION_BYTES = 8 + 16 + 8;
const POSITION_FIELD_BYTES = 32 + 32 + POSITION_BYTES;

/**
 * Every position in a vault, by walking its `positions` table.
 *
 * `readStakePosition` derives one entry from an address and needs no pagination. This is the
 * other direction — the creator asking who is pooled behind them — and a `Table` offers no way to
 * answer it but enumerating its dynamic fields. The node returns each entry's key and value as
 * BCS, so one page is one request and no per-entry object read is needed.
 *
 * Bounded at `MEMBERS_MAX_PAGES × MEMBERS_PAGE` entries, and says so with `truncated` rather than
 * presenting a partial list as the whole. A vault with more members than that is a good problem,
 * and one the reader must be told about rather than shown a total that does not add up.
 */
export async function listStakePositions(
  client: SuiGrpcClient,
  positionsTableId: string,
): Promise<Reading<StakeMembers>> {
  const source = `positions table ${positionsTableId}`;
  try {
    const members: StakeMember[] = [];
    let cursor: string | null = null;

    for (let page = 0; page < MEMBERS_MAX_PAGES; page += 1) {
      const response: PositionsPage = await client.listDynamicFields({
        parentId: positionsTableId,
        limit: MEMBERS_PAGE,
        include: { value: true },
        ...(cursor === null ? {} : { cursor }),
      });

      for (const field of response.dynamicFields) {
        const name = toBytes(field.name.bcs);
        const value = toBytes(field.value?.bcs);
        if (name === null || value === null) {
          return fail('malformed', source, 'an entry carried no decodable name or value');
        }

        /*
          The node hands back the value; whether that is the bare `Position` or the `Field` that
          wraps it is decided by length rather than assumed, because the two parse differently and
          a guess that is wrong yields a plausible principal belonging to nobody.
        */
        const decoded =
          value.length === POSITION_FIELD_BYTES
            ? PositionFieldBcs.parse(value).value
            : value.length === POSITION_BYTES
              ? PositionBcs.parse(value)
              : null;
        if (decoded === null) {
          return fail('malformed', source, `a position decoded to ${value.length} bytes`);
        }

        members.push({
          depositor: bcs.Address.parse(name),
          principalMist: BigInt(decoded.principal),
          pendingRebateMist: BigInt(decoded.pending),
          rebateDebt: BigInt(decoded.rebateDebt),
        });
      }

      if (!response.hasNextPage || response.cursor === null) {
        return ok({ members, truncated: false });
      }
      cursor = response.cursor;
    }

    return ok({ members, truncated: true });
  } catch (error) {
    const failure = classify(error, source);
    return fail(failure.kind, source, failure.detail);
  }
}
