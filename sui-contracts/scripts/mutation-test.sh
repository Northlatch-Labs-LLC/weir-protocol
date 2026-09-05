#!/usr/bin/env bash
# Built-by: @projectx.sui · Co-authored-by: Claude
#
# Mutation harness for projectx_social.
#
# A passing suite is not evidence. This breaks each load-bearing invariant on purpose, confirms
# the suite notices, then restores the source and verifies it is byte-identical by hash. A
# mutation that survives means the invariant it names is not actually covered, however many tests
# reference it.
#
# Usage:  ./scripts/mutation-test.sh
# Exit 0  every mutation was killed.
# Exit 1  at least one survived, and is named in the output.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

SOURCES=(
  sources/platform.move
  sources/account.move
  sources/creator.move
  sources/entitlement.move
  sources/stake_ladder.move
  sources/stake_vault.move
)
BACKUP_DIR="$(mktemp -d)"
trap 'rm -rf "$BACKUP_DIR"' EXIT

for f in "${SOURCES[@]}"; do
  cp "$f" "$BACKUP_DIR/$(basename "$f")"
done

hash_of() { shasum -a 256 "$1" | cut -d' ' -f1; }

declare -a BEFORE_HASHES
for f in "${SOURCES[@]}"; do BEFORE_HASHES+=("$(hash_of "$f")"); done

restore() {
  for f in "${SOURCES[@]}"; do
    cp "$BACKUP_DIR/$(basename "$f")" "$f"
  done
}

KILLED=0
SURVIVED=0
declare -a SURVIVORS

# mutate <name> <file> <sed-expression> <invariant being tested>
mutate() {
  local name="$1" file="$2" expr="$3" invariant="$4"

  restore
  local before after
  before="$(hash_of "$file")"
  sed -i '' "$expr" "$file"
  after="$(hash_of "$file")"

  if [[ "$before" == "$after" ]]; then
    echo "  !! $name — SED MATCHED NOTHING. The mutation did not apply; this is a broken"
    echo "     harness entry, not a passing test. Fix the expression."
    SURVIVED=$((SURVIVED + 1))
    SURVIVORS+=("$name (sed matched nothing)")
    return
  fi

  if sui move test >/dev/null 2>&1; then
    echo "  SURVIVED  $name"
    echo "            invariant not covered: $invariant"
    SURVIVED=$((SURVIVED + 1))
    SURVIVORS+=("$name")
  else
    echo "  killed    $name"
    KILLED=$((KILLED + 1))
  fi
}

echo "Mutation testing projectx_social"
echo

# --- The referral fold. This is the defect the suite actually caught during development, so it
# --- is the first thing re-checked: with no referrer, the share must stay with the platform.
mutate "referral fold removed" sources/creator.move \
  's|let referral_cut = if (has_referrer) {|let referral_cut = if (true) {|' \
  "an absent referrer leaves their share with the platform, not the creator"

# --- Conservation. Give the platform the creator's share and vice versa.
mutate "creator and platform legs swapped" sources/creator.move \
  's|vault.platform_fees.join(funds.split(platform_net));|vault.platform_fees.join(funds.split(creator_net));|' \
  "each party receives its own leg of the split"

# --- Early renewal must extend from the expiry, not from now.
mutate "renewal resets the clock" sources/entitlement.move \
  's|let base = if (subscription.expires_at_ms > now) { subscription.expires_at_ms } else { now };|let base = now;|' \
  "renewing early adds a period rather than discarding unused time"

# --- Expiry boundary. `<` becomes `<=`, granting one extra millisecond.
mutate "expiry boundary widened" sources/entitlement.move \
  's|clock.timestamp_ms() < subscription.expires_at_ms$|clock.timestamp_ms() <= subscription.expires_at_ms|' \
  "expires_at_ms is exclusive"

# --- The claim path must not consult a pause. Introduce the check the design forbids.
mutate "claim gated on the creator switch" sources/creator.move \
  's|    assert!(vault.earnings.value() >= amount, EInsufficientBalance);|    assert!(vault.accepting, ENotAccepting);\n    assert!(vault.earnings.value() >= amount, EInsufficientBalance);|' \
  "no switch can block a creator withdrawing earnings"

# --- Self-payment guard, which stops a creator inflating their own volume.
mutate "self-payment guard removed" sources/creator.move \
  's|    assert!(payer != vault.owner, ESelfPayment);||' \
  "a creator cannot pay their own vault"

# --- Fee snapshotting. Read the live platform rate instead of the stamped one.
mutate "fee ceiling removed" sources/platform.move \
  's|    assert!(fee_bps <= MAX_PLATFORM_FEE_BPS, EFeeAboveCeiling);||' \
  "the compiled fee ceiling bounds what PlatformCap may set"

# --- The platform must publish shut. Opening it by default reopens the window in which a vault
# --- can snapshot a zero fee permanently, between publish and set_fees.
mutate "platform publishes open" sources/platform.move \
  's|        creation_paused: true,|        creation_paused: false,|' \
  "a freshly published platform is closed until it is configured"

# --- Handle charset, which is the impersonation defence.
mutate "handle charset check removed" sources/account.move \
  's|        assert!(ok, EHandleCharset);||' \
  "handles are restricted to [a-z0-9_]"

# --- One account per address.
mutate "duplicate account guard removed" sources/account.move \
  's|    assert!(!registry.by_address.contains(owner), EAlreadyRegistered);||' \
  "one address may hold only one account"

# === The stake leg ===
#
# These matter more than the flow leg's, because the two defects they guard against both present
# as a yield of exactly zero — a number that looks like "nothing happened yet" rather than a bug.

# --- The maturity boundary. `<=` becomes `<`, holding every tranche one epoch too long.
mutate "maturity boundary narrowed" sources/stake_ladder.move \
  's|tranche.stake_activation_epoch() + LADDER_DEPTH <= current_epoch|tranche.stake_activation_epoch() + LADDER_DEPTH < current_epoch|' \
  "a tranche matures at exactly activation + LADDER_DEPTH"

# --- The one-rung-per-epoch rule. Without it the ladder collapses into a lump, which is the
# --- live mainnet defect this whole module exists to prevent.
mutate "one-rung-per-epoch guard removed" sources/stake_ladder.move \
  's|    if (staked_this_epoch(tranches, ctx.epoch())) return 0;||' \
  "at most one rung may be staked per epoch"

# --- The no-loss invariant itself.
#
# Note what is NOT mutated here. Deleting `assert!(backing >= total_principal)` on its own
# survives, and correctly so: it is a defensive assertion that cannot fire while the surrounding
# accounting is right, so no black-box test can distinguish its presence. A mutation that only
# removes an unreachable guard measures nothing, and counting its survival as a coverage gap would
# be misreading the harness.
#
# What is mutated instead is the accounting the assertion exists to catch: harvested principal is
# treated as yield rather than returned to the liquid buffer. That genuinely breaks solvency —
# depositor principal would be paid out as creator revenue — and it is precisely the failure the
# assertion is there to stop.
mutate "harvested principal booked as yield" sources/stake_vault.move \
  's|    vault.liquid.join(proceeds.split(principal));|    let _unused = principal;|' \
  "harvested principal returns to the buffer instead of being paid out as yield"

# --- The rebate must come out of the creator's share, never the platform's.
mutate "rebate taken from the gross" sources/stake_vault.move \
  's|        (((after_fee as u128) \* (rebate_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64;|        (((gross as u128) * (rebate_bps as u128)) / (BPS_DENOMINATOR as u128)) as u64;|' \
  "the rebate is carved from the creator's post-fee share"

# --- Emergency unwind. Without it a withdrawal aborts whenever the buffer is short, which turns
# --- "your principal is available" into "your principal is available in about a week".
mutate "emergency unwind removed" sources/stake_vault.move \
  's|        assert!(!vault.tranches.is_empty(), ECannotRaiseLiquidity);|        assert!(false, ECannotRaiseLiquidity);|' \
  "a withdrawal unwinds the ladder rather than failing when the buffer is short"

# --- Rebate accounting. Skipping the re-baseline pays a new depositor for yield earned before
# --- they arrived, at the expense of the depositors who actually earned it.
mutate "rebate re-baseline skipped" sources/stake_vault.move \
  's|        resync_debt_on(position, acc, eligible_after);||' \
  "a depositor accrues rebate only from the moment they deposit"

# --- Expansion set: 23 further load-bearing invariants. Patterns source-verified before
# --- installation; survivors are findings.

mutate "referral ceiling removed" sources/platform.move \
  's|    assert!(referral_share_bps <= MAX_REFERRAL_SHARE_BPS, EFeeAboveCeiling);||' \
  "the referral share ceiling bounds what PlatformCap may set"

mutate "treasury sweep guard removed" sources/platform.move \
  's|    assert!(platform.treasury.value() >= amount_mist, EInsufficientTreasury);||' \
  "the treasury cannot sweep more than it holds"

mutate "migrate version guard removed" sources/platform.move \
  's|    assert!(platform.version < VERSION, ENotUpgraded);||' \
  "migrate refuses a platform already at the current version"

mutate "creation fee underpayment guard removed" sources/platform.move \
  's|    assert!(payment.value() >= due, EInsufficientFee);||' \
  "underpaying the creation fee aborts"

mutate "creation paused check removed" sources/platform.move \
  's|    assert!(!platform.creation_paused, ECreationPaused);||' \
  "no vault or account can be opened while creation is paused"

mutate "payments paused check removed" sources/platform.move \
  's|    assert!(!platform.payments_paused, EPaymentsPaused);||' \
  "the payments pause switch blocks new payments"

mutate "handle length bounds removed" sources/account.move \
  's|    assert!(len >= MIN_HANDLE_LEN \&\& len <= MAX_HANDLE_LEN, EHandleLength);||' \
  "a handle must be within the compiled length bounds"

mutate "duplicate handle guard removed" sources/account.move \
  's|    assert!(!registry.by_handle.contains(handle), EHandleTaken);||' \
  "two accounts cannot share a handle"

mutate "self-referral guard removed" sources/account.move \
  's|    assert!(\*referrer.borrow() != owner, ESelfReferral);||' \
  "a referrer must not be the account being opened"

mutate "inactive tier guard removed" sources/creator.move \
  's|    assert!(tier.active, ETierInactive);||' \
  "a retired tier cannot be subscribed to"

mutate "seal period alignment guard removed" sources/creator.move \
  's|    assert!(period_ms % entitlement::seal_period_ms() == 0, EPeriodNotWholeSealPeriods);||' \
  "a tier term must be a whole number of seal periods"

mutate "vault accepting check removed" sources/creator.move \
  's|    assert!(vault.accepting, ENotAccepting);||' \
  "a vault that has stopped accepting payments refuses new ones"

mutate "zero price guard removed (add_tier)" sources/creator.move \
  's|    assert!(price > 0, EZeroPrice);| |' \
  "a tier with a zero price is refused"

mutate "insufficient payment guard removed" sources/creator.move \
  's|    assert!(payment.value() >= price, EInsufficientPayment);||' \
  "underpaying a purchase aborts rather than silently crediting less"

mutate "seal unlock tag flipped to subscription tag" sources/entitlement.move \
  's|const SEAL_UNLOCK: u8 = 0;|const SEAL_UNLOCK: u8 = 1;|' \
  "an unlock identity must not collide with a subscription identity"

mutate "unlock holder check removed" sources/entitlement.move \
  's|    assert!(unlock.buyer == ctx.sender(), ENotHolder);||' \
  "an unlock may only be used by its buyer"

mutate "subscription expiry check removed from assert_subscribed" sources/entitlement.move \
  's|    assert!(clock.timestamp_ms() < subscription.expires_at_ms, EExpired);||' \
  "a lapsed subscription does not authenticate"

mutate "rung size min stake floor removed" sources/stake_ladder.move \
  's|    if (even < MIN_STAKE_MIST) MIN_STAKE_MIST |    even |' \
  "a rung below the minimum stake is refused"

mutate "max tranches cap removed" sources/stake_ladder.move \
  's|    if (tranches.length() >= MAX_TRANCHES) return 0;||' \
  "the tranche cap prevents unbounded gas cost in harvest"

mutate "available-exceeds-liquid assertion removed" sources/stake_ladder.move \
  's|    assert!(available <= liquid.value(), EAvailableExceedsLiquid);||' \
  "a caller cannot claim more spendable balance than the liquid buffer holds"

mutate "min deposit guard removed" sources/stake_vault.move \
  's|    assert!(amount >= MIN_DEPOSIT_MIST, EDepositTooSmall);||' \
  "a deposit below the minimum is refused"

mutate "rebate max guard removed" sources/stake_vault.move \
  's|    assert!(rebate_bps <= BPS_DENOMINATOR, ERebateAboveMax);||' \
  "a rebate above 100% of the creator's post-fee share is refused"

mutate "vault version check removed from deposit" sources/stake_vault.move \
  's|    assert_version(vault);||' \
  "every entry point checks the vault version before mutating"

restore

echo
echo "Verifying sources restored byte-identical..."
RESTORE_OK=1
for i in "${!SOURCES[@]}"; do
  now="$(hash_of "${SOURCES[$i]}")"
  if [[ "$now" != "${BEFORE_HASHES[$i]}" ]]; then
    echo "  MISMATCH ${SOURCES[$i]}"
    RESTORE_OK=0
  fi
done
[[ $RESTORE_OK == 1 ]] && echo "  all ${#SOURCES[@]} sources match their pre-run hashes"

echo
echo "killed: $KILLED   survived: $SURVIVED"
if [[ $SURVIVED -gt 0 ]]; then
  echo
  echo "Survivors:"
  for s in "${SURVIVORS[@]}"; do echo "  - $s"; done
  exit 1
fi
[[ $RESTORE_OK == 1 ]] || exit 1
exit 0
