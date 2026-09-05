// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Every workspace package declares a test script, or this says which does not.
 *
 * # The defect this closes
 *
 * `pnpm -r test` runs the packages that HAVE a `test` script and says nothing about the ones that
 * do not. `packages/room` has none — 1,937 lines that publish under a creator's handle, including
 * the boundary that decides whether a run is a dry run or a live one — and every "full gate" run
 * tonight passed over it in silence. Both desks read the result as complete coverage and quoted it
 * as such, repeatedly.
 *
 * The gate was not wrong about what it ran. It was silent about what it did not, which is the same
 * shape as everything else this audit has found: the behaviour is correct and the ACCOUNT of it is
 * false. A green that covers seven of eight packages, presented identically to one that covers
 * eight, is a claim nobody can check by reading it.
 *
 * This has already happened once here, one level up. `.github/workflows/ci.yml` records it: the CI
 * step read `working-directory: packages/web` with `pnpm test` until 2026-09-01, so it resolved to
 * the WEB package's script and nothing else. That fix took coverage from one package to seven. It
 * did not make the eighth visible.
 *
 * # Why a list of exemptions rather than a rule
 *
 * A package may legitimately have nothing to test. What it may not do is be skipped without anyone
 * deciding that. An exemption is a line in this file with a reason, which is a review; an absent
 * script is a silence.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGES = join(ROOT, 'packages');

/**
 * Packages deliberately without tests, each with the reason.
 *
 * Empty on purpose. Adding a name here is a decision somebody makes and signs; leaving one out is
 * not something that happens by itself.
 */
const EXEMPT = new Map([]);

const missing = [];
for (const entry of readdirSync(PACKAGES)) {
  const manifest = join(PACKAGES, entry, 'package.json');
  try {
    if (!statSync(manifest).isFile()) continue;
  } catch {
    continue;
  }
  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  const hasTest = typeof pkg.scripts?.test === 'string' && pkg.scripts.test.trim() !== '';
  if (!hasTest && !EXEMPT.has(entry)) missing.push(entry);
}

if (missing.length > 0) {
  console.error('every-package-is-tested: these packages declare no test script:\n');
  for (const name of missing) console.error(`  packages/${name}`);
  console.error(
    '\n`pnpm -r test` runs the packages that have one and says nothing about the rest, so a run\n' +
      'covering the others is reported exactly like a run covering all of them.\n\n' +
      'Give it a test script, or add it to EXEMPT in this file with the reason. Both are decisions.\n' +
      'An absent script is not.',
  );
  process.exit(1);
}

console.log(`every-package-is-tested: OK (${readdirSync(PACKAGES).length} packages, none silent)`);
