# WEIR-PROTOCOL — UPDATE

**READ THIS FILE FROM THE TOP. Newest first.** The entry below the title is the current state.
New entries go at the TOP. Never edit an old entry to agree with a new one; add, and name what
was superseded.

This repository is the PUBLIC half of Weir: the six Apache-2.0 libraries and the two BUSL-1.1 Move
packages, with fresh history. The private `weir` repository is the source; this one is exported to.
Where the two disagree, `weir` is right and this file should say why.

---

## 2026-09-03 · Branch `truth/weir-protocol-readme` staged, unmerged — the Master's truth-pass order

**Who:** engineering agent on the chief technology officer's dispatch, under the Master's order
2026-09-03 ("present that we are less and be more, than present more and be less") · **Where:**
branch `truth/weir-protocol-readme`, created from `main` at `90ee7a6` · **Ref:**
`work/reports/2026-09-03-product-truth-pass-claim-ledger.md` §6–§7 (the replacement copy and the
engineering hand-off); rows 238–249 of the CSV beside it.

`README.md` only, three sentences, staged with `git add`, not committed:

- The Seal line (row 240, was COULD BE: "a committee of key servers") now says "a key server (one
  today, threshold 1)" — matches `weir/UPDATE.md` 2026-09-01.
- "The numbers" table's check-count row (row 244, was WAS: a stale per-package count) now cites
  this laptop's last gate (3 September 2026, recorded above) and points the reader at `pnpm test`
  for the current figure; the commit/PR counts stay as private-history numbers a reader cannot
  reproduce, dated "as of 2 September 2026" as before.
- The maintainer paragraph (row 247, was COULD BE: "pays contributors … from her own wallet"
  stated as an ongoing practice) now says contributors are paid "for work that was agreed and
  merged — none yet", since no contributor has been paid to date.

**Claims changed: 3.** Unmerged. Nothing pushed, committed or deployed.

---

## 2026-09-03 · Gate run on this laptop, recorded in the estate ledger; main at `90ee7a6`, one untracked file (this one)

**Who:** engineering agent on the chief technology officer's dispatch · **Where:** `main` at `90ee7a6`, `main...origin/main` per the local ref (not fetched) · **Ref:** `work/state/gate-runs.json` id `weir-protocol`; report `work/reports/2026-09-03-engineering-gates-for-every-solution.md`

Until today this repository had CI runs on GitHub but no run recorded in the estate's own ledger. The CI's three jobs were run here, in order, 137 seconds in all:

- `python3 scripts/scan-secrets.py --all` → `253 tracked file(s), 0 live secret(s) compared` · **DEGRADED — patterns only**, exit 0. No `.env` exists here, so the identity rule did not run; the scanner says so itself.
- `pnpm install --frozen-lockfile` → `Done in 5s`.
- `pnpm test` → `every-package-is-tested: OK (6 packages, none silent)`; policy 62/62, sdk 297/297, signer 106/106, agent 255 passed + 9 skipped, daemon 97/97, mcp: all eleven test scripts report 0 failed.
- `pnpm typecheck` → six packages `Done`, exit 0.
- `bash sui-contracts/assert-toolchain.sh` → `OK — sui 1.78.1, pinned 1.78.1`.
- `sui move test` → `Total tests: 203; passed: 203; failed: 0` in `sui-contracts`; `Total tests: 4; passed: 4; failed: 0` in `sui-contracts-mind`.

**Result: pass.** Recorded as such.

**The one dirty file is this `UPDATE.md`**, untracked (`?? UPDATE.md`), created by the entry below earlier today and never committed. It is an intended change and is left in place; committing is Kaela's.

---

## 2026-09-03 · This file created; the repository had no update file until now

Every other solution on the estate carries an `UPDATE.md` and this one did not, so nothing recorded
what had changed here or when. That is the gap this file closes.

**State as measured today:** `main` at `90ee7a6`, clean, nothing unpushed. CI passes — and it is the
only repository on the estate whose CI does pass, because it is public and public repositories draw
on an unmetered Actions allowance. The private repositories cannot start a job at all since
2026-09-02, so this repository is currently the estate's only working proof that GitHub itself is
healthy.

**What it holds:** the six libraries published to npm at 1.0.0 under Apache-2.0
(`sdk`, `policy`, `signer`, `agent`, `mcp`, `daemon`), and the Move contracts under BUSL-1.1 with
the licensor and change date in every file header.

**What it deliberately excludes:** the web application, the room package, the daemon deploy scripts,
cloudbuild, the ceremony runbooks and the recovery card. Counsel's ruling of 2026-09-02 is that the
libraries are open, the contracts are source-available, and the web application is proprietary.

**Its address is now in the agent manifest.** Until today the signed manifest told agents to verify
us against our contracts and never said where they were, which sent at least two agents searching —
one through the organisation's private repositories. `chain.source` now names this repository, the
path to the contracts, and the licence that travels with them.

---
