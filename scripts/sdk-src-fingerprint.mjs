// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
//
// One fingerprint of `packages/sdk/src`, shared by the thing that writes it after a build and the
// thing that checks it before tests. Both must compute it the same way or the guard is decorative,
// so it lives in one file and neither side has its own copy.
//
// Path, size and mtime — never file contents. The question is "was `dist` produced from exactly
// this tree", not "what is in the tree", and hashing every byte on every test run buys nothing for
// that question. Sorted, so directory-listing order cannot change the answer.
import { readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

export const STAMP_FILE = 'dist/.build-fingerprint';

/** `null` when the directory does not exist — a checkout without the SDK has nothing to guarantee. */
export function fingerprintSrc(sdkDir) {
  const src = join(sdkDir, 'src');
  if (!existsSync(src)) return null;

  const rows = [];
  for (const entry of readdirSync(src, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = join(entry.parentPath ?? entry.path, entry.name);
    const s = statSync(full);
    rows.push(`${relative(src, full)}\0${s.size}\0${s.mtimeMs}`);
  }
  rows.sort();
  return createHash('sha256').update(rows.join('\n')).digest('hex');
}
