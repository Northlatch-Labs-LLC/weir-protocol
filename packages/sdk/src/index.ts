// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * ProjectX Social SDK.
 *
 * Two rules govern everything exported here:
 *
 *  1. A failed read is never a value. Chain reads return `Reading<T>`; there is no `unwrapOr`.
 *  2. Nothing signs without simulating first. Builders return transactions; `simulate()` gates them.
 */
export {
  type Reading,
  type Failure,
  type FailureKind,
  type ReaderHealth,
  type ReaderStats,
  type RetryAdvice,
  FAILURE_KINDS,
  ok,
  fail,
  fold,
  map,
  orThrow,
  readerHealth,
  classify,
  retryAdvice,
  describeFailureKind,
} from './reading.js';

export {
  type ProjectXSocialConfig,
  type Network,
  type SealConfig,
  type SealKeyServer,
  loadConfig,
  loadKeyRegistryId,
  loadMindPackageId,
  loadSealConfig,
  REQUIRED_ENV,
  KEY_REGISTRY_ENV,
  MIND_PACKAGE_ENV,
  SEAL_ENV,
} from './config.js';

export {
  SEAL_UNLOCK,
  SEAL_SUBSCRIPTION,
  SEAL_MIND,
  SEAL_PERIOD_MS,
  unlockIdentity,
  periodIdentity,
  mindIdentity,
  periodOf,
  sealId,
  sealPackageId,
  approveUnlock,
  approveSubscription,
  approveMind,
  approvalBytes,
} from './seal.js';

export {
  type StakeVaultState,
  type StakePosition,
  type StakeMember,
  type StakeMembers,
  type Tranche,
  ACC_SCALE,
  claimableRebateMist,
  decodeStakeVault,
  readStakeVault,
  readCurrentEpoch,
  readStakePosition,
  listStakePositions,
  STAKE_VAULT_BCS_FIELDS,
  POSITION_BCS_FIELDS,
  STAKED_SUI_BYTES,
} from './stakevault.js';

export {
  type RegistryTables,
  type HandleProblem,
  readRegistryTables,
  resolveHandle,
  handleOf,
  handleProblem,
  MIN_HANDLE_LEN,
  MAX_HANDLE_LEN,
  REGISTRY_BCS_FIELDS,
} from './accounts.js';

export {
  type PublishedKey,
  readKeyRegistryTableId,
  readPublishedKey,
  KEY_BYTES,
  KEY_REGISTRY_BCS_FIELDS,
  PUBLISHED_KEY_BCS_FIELDS,
} from './keyregistry.js';

export {
  type PaymentSplit,
  type YieldSplit,
  computeSplit,
  computeYieldSplit,
  BPS_DENOMINATOR,
  MAX_PLATFORM_FEE_BPS,
  MAX_REFERRAL_SHARE_BPS,
} from './split.js';

export {
  type Amount,
  amount,
  parseAmount,
  formatAmount,
  parseSui,
  MIST_PER_SUI,
  SUI_DECIMALS,
} from './money.js';

export {
  type PlatformState,
  type SimulationOutcome,
  type DecodedAbort,
  createClient,
  readPlatform,
  readDecimals,
  simulate,
  simulationEnvelope,
  simulationStatus,
  type SimulationStatus,
  decodeAbort,
  ABORT_EXPLANATIONS,
  PLATFORM_BCS_FIELDS,
} from './client.js';

export { decodeObjectBytes, decodeObjectBytesAtLeast } from './objectbytes.js';

/*
  The end-to-end scheme, hoisted from `packages/web/lib/e2e.ts` on 2026-09-02 for the same reason
  the statements were: an agent encrypting its own memory must use the one implementation the
  browser uses to encrypt a message, or the two drift and a memory becomes unopenable.
*/
export {
  KEY_STATEMENT,
  type Envelope,
  type EncryptedPayload,
  toB64,
  fromB64,
  ciphertextDigest,
  deriveSecret,
  publicFromSecret,
  encrypt,
  encryptBytes,
  decrypt,
  decryptBytes,
} from './e2e.js';

export * as tx from './tx.js';

export {
  type Tier,
  type CreatorVaultState,
  decodeCreatorVault,
  readCreatorVault,
  readContentPrice,
  CREATOR_VAULT_BCS_FIELDS,
  readVaultCoinType,
} from './creator.js';

/*
  The signed-statement format.

  Exported from the SDK rather than from the web app because three different processes must produce
  identical bytes: the Next server that verifies, the browser that signs, and a headless agent that
  signs without a browser at all. It lived in `packages/web/lib/identity.ts` and was hand-copied
  into `packages/agent`; the copies drifted, and this is the removal of the duplicate rather than a
  better test for it. `verifyAction` stayed behind — it spends rows in `used_signatures` and reads
  `siteConfig()`, neither of which belongs in a package a browser imports.
*/
export {
  HEAD_LINES,
  type Action,
  statementFor,
  isSingleUse,
  SIGNATURE_WINDOW_MS,
  STATEMENT_SHAPES,
  accessStatement,
  parseAccessStatement,
} from './statements.js';
