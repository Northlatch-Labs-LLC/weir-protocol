#!/usr/bin/env bash
# Built-by: @projectx.sui · Co-authored-by: Claude
#
# Verify the explicit SuiSystem pin in Move.toml matches the framework revision the toolchain
# actually resolves for Sui and MoveStdlib.
#
# Why this exists: Move.toml pins SuiSystem to a commit rather than the `framework/mainnet` branch,
# because a moving branch can resolve a different revision of the same 0x2 framework than the one
# the toolchain injects, and the build then refuses with two versions of Sui. That pin is correct
# only while it equals the injected revision, and nothing else notices when a toolchain upgrade
# moves one and not the other — the build keeps working until the day it doesn't.
#
# Run after any `sui` upgrade. Exit 1 means: read the commit out of Move.lock, put it in Move.toml,
# rebuild, re-run the tests.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

if [[ ! -f Move.lock ]]; then
  echo "FAIL  Move.lock is missing. Run 'sui move build' first — the lock is what pins revisions."
  exit 1
fi

# The revision the toolchain resolved for the auto-injected framework.
injected="$(awk '/^\[pinned\.mainnet\.Sui\]/{f=1} f && /rev = /{print; exit}' Move.lock \
  | sed -E 's/.*rev = "([a-f0-9]+)".*/\1/')"

# The revision this manifest asks for.
declared="$(grep -E '^SuiSystem = ' Move.toml | sed -E 's/.*rev = "([a-f0-9]+)".*/\1/')"

if [[ -z "$injected" ]]; then
  echo "FAIL  Could not read the injected Sui revision from Move.lock."
  exit 1
fi
if [[ -z "$declared" ]]; then
  echo "FAIL  Could not read the declared SuiSystem revision from Move.toml."
  echo "      If SuiSystem was removed: it must NOT be. Only MoveStdlib and Sui are genuinely"
  echo "      auto-injected; without an explicit SuiSystem the named address is never bound and"
  echo "      the stake leg does not compile. The CLI's own note claiming otherwise is wrong."
  exit 1
fi

echo "  injected (Move.lock):  $injected"
echo "  declared (Move.toml):  $declared"

if [[ "$injected" != "$declared" ]]; then
  echo
  echo "FAIL  Framework revisions have drifted apart."
  echo "      Set the SuiSystem rev in Move.toml to $injected, rebuild, and re-run the tests."
  exit 1
fi

echo "  match"
exit 0
