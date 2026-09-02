// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// Record what `packages/sdk/dist` was just built FROM. Runs only after `tsc` exits 0, joined to it
// by `&&` in the SDK's build script, and that ordering is the entire point:
//
//   tsc emits file by file. Interrupt it — Ctrl-C, a killed terminal, a full disk — and `dist`
//   holds some files from this commit and some from the last one. Its newest mtime is `now`, so
//   any freshness check that compares mtimes against `dist` reports FRESH and vouches for a
//   mixture of two commits. That is worse than having no check at all, because the next person has
//   one more reason to believe the thing that is lying to them.
//
// An interrupted build never reaches this line, so the fingerprint stays old and the next test run
// rebuilds. Touching `dist`, or restoring it by `cp -R` or a cache, does not produce a fingerprint
// matching the current `src` either.
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fingerprintSrc, STAMP_FILE } from './sdk-src-fingerprint.mjs';

const sdkDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'packages', 'sdk');
const fingerprint = fingerprintSrc(sdkDir);
if (fingerprint !== null) {
  const target = join(sdkDir, STAMP_FILE);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, fingerprint + '\n');
}
