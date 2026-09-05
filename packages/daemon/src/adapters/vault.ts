// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Reading a stake vault — now a re-export.
 *
 * The BCS decoder moved to `@projectx-social/sdk` when the web application began reading stake
 * vaults too. The alternative was a second positional decoder for the same struct, which is the
 * exact hazard this codebase guards against everywhere else: insert a field in `StakeVault` and one
 * copy gets fixed while the other silently returns `rebate_bps` as the validator address.
 *
 * The daemon's own domain types stay in `domain/harvest.ts`. `VaultSnapshot` is what the harvest
 * DECISION needs — a plain value with no client and no clock — and the SDK's `StakeVaultState` is
 * the chain's shape. They overlap structurally and they are not the same concern, which is why the
 * decision code still takes the narrower type.
 */

export {
  decodeStakeVault,
  readCurrentEpoch,
  readStakeVault,
  STAKE_VAULT_BCS_FIELDS,
  STAKED_SUI_BYTES,
  type StakeVaultState,
} from '@projectx-social/sdk';
