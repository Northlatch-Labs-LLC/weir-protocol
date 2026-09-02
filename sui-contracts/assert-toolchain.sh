#!/usr/bin/env bash
# Built-by: @projectx.sui /|\
# Co-authored-by: Kaela <kaela@projectxprotocol.dev>
#
# Refuse to build or publish with a compiler this package was not pinned to.
#
# # The night this exists because of
#
# On 2026-09-01 an upgrade ceremony stopped at "protocol version 135 is newer than the maximum
# version 133 supported by this CLI". The machine had TWO Sui binaries: 1.78.0 installed by
# Homebrew at /usr/local/bin, and a stale 1.77.2 at ~/.local/bin which came FIRST on PATH and had
# been silently winning every command for months. Nobody had noticed, because a stale compiler does
# not announce itself — it builds, it tests, it passes, and it is wrong only about the one thing
# nobody checks.
#
# # Why a digest is not enough
#
# A package digest is a function of the SOURCE AND THE COMPILER, and only the source is in git.
# `ci-expected-digest` is a bare 64-hex string: it records neither the toolchain that produced it
# nor the fact that it depends on one. So when a compiler changes the bytes, the digest guard says
# "the source no longer builds to the recorded package" — which is FALSE. The source did not move.
#
# `Published.toml` already records `toolchain-version` beside `version`. Somebody wrote down the
# exact fact that makes the check honest and nothing ever read it. This reads it.
#
# # What it does NOT do
#
# It does not refuse to build. A version difference is not automatically an error — measured on
# 2026-09-01, 1.77.2, 1.78.0 and 1.78.1 all build this package to the byte-identical digest
# 12536777af66da8e…, so the pin moved with no cost at all. What it refuses is SILENCE: the operator
# is told which compiler the package was pinned to, which one is about to be used, and that a digest
# mismatch under a changed compiler is not evidence of tampering.
#
# Usage:  assert-toolchain.sh [--strict]
#   default   report a difference loudly, exit 0
#   --strict  exit 1 on a difference. For a CEREMONY, where two people are about to sign bytes and
#             must be on the same build or the signatures will not combine.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STRICT=0
[[ "${1:-}" == "--strict" ]] && STRICT=1

PUBLISHED="$HERE/Published.toml"
[[ -f "$PUBLISHED" ]] || { echo "assert-toolchain: no Published.toml beside this script" >&2; exit 2; }

PINNED="$(sed -n 's/^[[:space:]]*toolchain-version[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$PUBLISHED" | head -1)"
if [[ -z "$PINNED" ]]; then
  # An absent pin is not a pass. It means nobody recorded what built the deployed package, and the
  # digest guard's verdict cannot be trusted either way.
  echo "assert-toolchain: Published.toml records no toolchain-version. The digest cannot be" >&2
  echo "  attributed to any compiler, so a mismatch proves nothing. Record one." >&2
  exit 2
fi

command -v sui >/dev/null 2>&1 || { echo "assert-toolchain: no sui on PATH" >&2; exit 2; }
RAW="$(sui --version)"
# "sui 1.78.1-homebrew" and "sui 1.77.2-51d177ad7d65" both reduce to their release number. The build
# suffix names where the binary came from, not what it compiles to, and pinning it would refuse a
# Homebrew install for matching a source build.
ACTUAL="$(printf '%s' "$RAW" | sed -n 's/^sui[[:space:]]\([0-9][0-9.]*\).*/\1/p')"

if [[ "$ACTUAL" == "$PINNED" ]]; then
  echo "assert-toolchain: OK — sui $ACTUAL, pinned $PINNED"
  exit 0
fi

echo "assert-toolchain: TOOLCHAIN DIFFERS" >&2
echo "  pinned in Published.toml : $PINNED" >&2
echo "  about to be used         : $ACTUAL   ($RAW)" >&2
echo "  which sui                : $(command -v sui)" >&2
echo >&2
echo "  A package digest is a function of the SOURCE AND THE COMPILER. If the digest guard fails" >&2
echo "  after this line, that is NOT evidence the source drifted — check this first." >&2
echo "  If the digest is unchanged, the compilers agree and the pin should be updated to $ACTUAL" >&2
echo "  in the same commit as whatever else changes." >&2

# Show every sui on PATH. The defect this file exists for was a SHADOWED binary, and a version
# number alone would not have revealed it.
echo >&2
echo "  every sui on PATH, in order:" >&2
type -a sui 2>/dev/null | sed 's/^/    /' >&2

[[ "$STRICT" -eq 1 ]] && exit 1
exit 0
