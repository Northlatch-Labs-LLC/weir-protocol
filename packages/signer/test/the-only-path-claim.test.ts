// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * The docblock's claim about itself must survive contact with the repository.
 *
 * # The defect this pins
 *
 * `policy-signer.ts` opened with "the only path to a transaction signature in this repository",
 * and it was not true: `packages/daemon/src/adapters/signer.ts` calls
 * `client.signAndExecuteTransaction` directly — no policy ceiling, no spend ledger, no audit entry.
 *
 * The daemon is a deliberate exception and the reasoning is sound: its key is capability-less and
 * gas-only, so the control on it is what it cannot do rather than what a ceiling would stop it
 * doing. But the reasoning lived nowhere and the false claim lived here, in the file somebody reads
 * when deciding whether a NEW signing path has to come through this one. It answered "everything
 * already does". That was the wrong answer for the daemon and would be the wrong answer again.
 *
 * # Why a test and not care
 *
 * A comment cannot be mutation-tested and does not fail when its subject moves — which is why
 * stale prose has been the most common finding on this codebase. This one can be tested, because
 * the claim is about a fact in the tree: it names a set of direct signing paths, and that set is
 * greppable. So the prose is pinned to the code it describes.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO = resolve(process.cwd(), '..', '..');
const DOC = readFileSync(join(process.cwd(), 'src', 'policy-signer.ts'), 'utf8');

/** Every first-party TypeScript source in the workspace. Build output and dependencies excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') return [];
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return entry.endsWith('.ts') && !entry.endsWith('.test.ts') ? [path] : [];
  });
}

function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

/*
  Signing paths that do NOT go through PolicySigner. `signAndExecuteTransaction` is the call that
  produces a signature and submits it; a file invoking it directly is by definition not coming
  through here.

  policy-signer.ts itself is excluded — it is the path, not a bypass of it.
*/
const bypasses = sources(join(REPO, 'packages'))
  .filter((p) => !p.endsWith(join('signer', 'src', 'policy-signer.ts')))
  .filter((p) => /\bsignAndExecuteTransaction\s*\(/.test(code(p)))
  .map((p) => p.replace(`${REPO}/`, ''));

describe('the walk', () => {
  it('found the workspace sources, so an empty result cannot pass as a clean one', () => {
    expect(sources(join(REPO, 'packages')).length).toBeGreaterThan(50);
  });
});

describe('the claim this file opens with', () => {
  it('does not OPEN by saying it is the only path to a signature, because it is not', () => {
    /*
      Asserted against the opening line rather than the whole file, because the corrected docblock
      QUOTES the false sentence while explaining that it was false — and a check on the whole file
      would count the explanation of the fix as the defect. That confusion, in both directions, is
      the most common way a check on prose turns out to mean nothing.
    */
    const opening = DOC.split('\n').slice(0, 4).join('\n');
    expect(opening).not.toContain('the only path to a transaction signature');
  });

  it('names every direct signing path that bypasses it', () => {
    /*
      This is the assertion that keeps the docblock honest as the tree changes. A second exception
      added later fails here until somebody writes it down — which is the review this file exists
      to force, since the question "does this new signer need the policy layer?" is exactly the one
      the false claim used to answer wrongly.
    */
    for (const path of bypasses) {
      expect(DOC, `${path} signs directly and is not named in policy-signer.ts`).toContain(path);
    }
  });

  it('is describing a real bypass rather than an empty list', () => {
    // If nothing bypassed it, the assertion above would be vacuously true and the docblock could
    // claim anything at all.
    expect(bypasses.length).toBeGreaterThan(0);
  });

  it('still states what MUST come through it', () => {
    expect(DOC).toMatch(/capability|spending a budget|another party's funds/);
  });
});
