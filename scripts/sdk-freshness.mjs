// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// Rebuild `packages/sdk/dist` before any test runs, unless it was demonstrably built from the
// `src` that is on disk right now.
//
// # The failure this ends
//
// `packages/sdk/dist` is gitignored, so it holds whatever was last compiled ON THIS MACHINE and it
// does NOT change when you switch branches. Testing against a stale one produces results for a
// mixture of two commits, and the symptom is the expensive kind: correct code failing with a
// plausible assertion error, indistinguishable from a real defect. It happened four times on one
// machine on 2026-09-01, three of them to the person who had written the warning about it.
//
// # Why a globalSetup and not a `pretest` hook
//
// `pretest` fires on `pnpm test` and not on `npx vitest run` inside a package — which is the
// ordinary way to run one package's tests while working on it, and is how the fourth occurrence
// happened after the root `test` script had already been fixed to build first. vitest loads
// globalSetup from the config however vitest was invoked, so both paths reach it.
//
// # Why a fingerprint and not `dist`'s mtime
//
// Comparing newest(src) against newest(dist) is correct for a branch switch — git writes what it
// changes, so mtimes move ahead of dist and the guard fires. It is WRONG for anything that makes
// `dist` newer without correctly rebuilding it, and there is a realistic instance: `tsc` emits
// file by file, so an interrupted build leaves some files from this commit and some from the last,
// with a newest mtime of `now`. An mtime check reports FRESH and vouches for a mixture — worse
// than no check, because it gives the next person a reason to believe it. Copying `dist` in from
// another worktree or a cache does the same thing.
//
// So the build writes a fingerprint of the `src` it compiled, as its last step and only on
// success, and this compares against that. An interrupted build never writes one. A touched or
// copied `dist` does not carry one that matches. Costs one file read plus a walk of `src` — no
// file contents are hashed, and the walk of `dist` is gone entirely.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprintSrc, STAMP_FILE } from './sdk-src-fingerprint.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdkDir = join(repoRoot, 'packages', 'sdk');

export default function ensureSdkBuiltFromSource() {
  const expected = fingerprintSrc(sdkDir);
  if (expected === null) return; // No SDK in this checkout; nothing to guarantee.

  let recorded = null;
  try {
    recorded = readFileSync(join(sdkDir, STAMP_FILE), 'utf8').trim();
  } catch {
    // Missing, unreadable, never written, or wiped with `dist`. All mean the same thing: we cannot
    // show what `dist` was built from, so we do not get to assume it was this.
  }

  if (recorded === expected) return;

  // Say it out loud rather than rebuilding silently. The next person saved by this should be able
  // to see that it is what saved them, or they will spend the hour anyway wondering why it worked.
  process.stderr.write(
    recorded === null
      ? '[sdk-freshness] packages/sdk/dist carries no record of what it was built from — building it before the tests run.\n'
      : '[sdk-freshness] packages/sdk/dist was built from different sources than are on disk — rebuilding before the tests run.\n',
  );

  execFileSync('pnpm', ['--filter', '@projectx-social/sdk', 'build'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}
