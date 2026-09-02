#!/usr/bin/env bash
# Built-by: @projectx.sui /|\ · Co-authored-by: Claude
#
# Guard the ported staking-ladder policy against silent change.
#
# `sources/stake_ladder.move` is a deliberate fork of `projectx_protocol::stake_ladder`, copied
# rather than depended upon because that package is unpublished by choice. A copy is only safe if
# something fails when it moves, so this hashes the three policy rules that carry the mechanism —
# `is_matured`, `staked_this_epoch` and `rung_size` — plus the constants they read, and compares
# against a checked-in baseline.
#
# A failure is not necessarily a bug. It means someone changed a rule that was mutation-proven
# upstream, and that change needs to be a decision: verify it against the upstream module, re-run
# the mutation harness, then update the baseline with `--update`.
#
# Self-contained by design: it reads nothing outside this package. If the upstream tree happens to
# be present it is diffed as a courtesy, but its absence is not a failure — this package must build
# and verify on a machine that has never seen it.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LADDER="sources/stake_ladder.move"
BASELINE="scripts/ladder-policy.sha256"
UPSTREAM="${PROJECTX_UPSTREAM:-$HOME/ProjectX/V1.1.1/projectx-vaults/sui-contracts/sources/stake_ladder.move}"

if [[ ! -f "$LADDER" ]]; then
  echo "FAIL  $LADDER is missing."
  exit 1
fi

# Extract only the load-bearing policy: the constants and the three rule bodies. Comments and
# documentation are excluded on purpose — rewording a doc comment must not trip this check, or it
# will be ignored the third time it fires for no reason.
extract_policy() {
  sed -e 's|//.*||' -e 's|///.*||' "$1" \
    | grep -E 'const (LADDER_DEPTH|RUNGS|MAX_TRANCHES|MIN_STAKE_MIST)|stake_activation_epoch\(\) \+ LADDER_DEPTH|stake_activation_epoch\(\) > current_epoch|target_staked / RUNGS|if \(even < MIN_STAKE_MIST\)' \
    | tr -d '[:space:]'
}

current="$(extract_policy "$LADDER" | shasum -a 256 | cut -d' ' -f1)"

if [[ "${1:-}" == "--update" ]]; then
  printf '%s\n' "$current" > "$BASELINE"
  echo "Baseline updated to $current"
  echo "Re-run ./scripts/mutation-test.sh before trusting it."
  exit 0
fi

if [[ ! -f "$BASELINE" ]]; then
  echo "FAIL  No baseline at $BASELINE. Create it with: $0 --update"
  exit 1
fi

expected="$(cat "$BASELINE")"

echo "  policy hash: $current"

if [[ "$current" != "$expected" ]]; then
  echo
  echo "FAIL  The ladder policy has changed."
  echo "        baseline: $expected"
  echo "        current:  $current"
  echo
  echo "      These rules were mutation-proven upstream. Confirm the change is intended, re-run"
  echo "      ./scripts/mutation-test.sh, then record it with: $0 --update"
  exit 1
fi

echo "  matches baseline"

# Courtesy comparison. Never fatal — this package does not depend on the upstream tree existing,
# and must verify identically on a machine that has never had it.
if [[ -f "$UPSTREAM" ]]; then
  upstream_hash="$(extract_policy "$UPSTREAM" | shasum -a 256 | cut -d' ' -f1)"
  if [[ "$upstream_hash" == "$current" ]]; then
    echo "  upstream present and identical"
  else
    echo
    echo "  NOTE  Upstream policy differs from this fork."
    echo "        upstream: $upstream_hash"
    echo "        here:     $current"
    echo "        Not a failure — the fork is allowed to diverge — but worth knowing which way."
  fi
else
  echo "  upstream not present; skipped (not an error)"
fi

exit 0
