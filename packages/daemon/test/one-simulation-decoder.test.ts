// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The daemon does not carry its own copy of the simulation envelope read.
 *
 * # Why this is a test and not a convention
 *
 * It WAS a convention, and the copy drifted. `adapters/signer.ts` read `Transaction.status` and the
 * legacy `transaction.effects.status`, and not `FailedTransaction` — where a node puts a simulation
 * that aborted. A success decoded correctly and a genuine Move abort found no status at all, and
 * was written into `daemon_harvests.error` as "a client/server shape mismatch, not a rejected
 * transaction": the opposite of what happened, on the one path where somebody is trying to find out
 * why a harvest did not go through.
 *
 * The SDK held the correct decoder the whole time, in the package this one already imports. A
 * duplicate decoder duplicates the shape it was written against, and only one copy gets fixed when
 * that shape moves — and this client's shape has already moved underneath this code once.
 *
 * A copy costs nothing to reintroduce and nothing reports it: the types are identical, the tests of
 * the success path stay green, and the difference only appears on an abort in production.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(process.cwd(), 'src');

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return entry.endsWith('.ts') ? [path] : [];
  });
}

/*
  Comments stripped first. The docblock above this file's own fix NAMES `FailedTransaction` and
  `Transaction.status` while explaining why they must not be read here — and a check that counted
  that as a violation would fail on the explanation of the fix.
*/
function code(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ');
}

const files = sources(SRC);

describe('the walk', () => {
  it('found the daemon sources, so an empty result cannot pass as a clean one', () => {
    expect(files.length).toBeGreaterThan(5);
  });
});

describe('reading a simulation status', () => {
  it('is not hand-rolled anywhere in this package', () => {
    const handRolled = files.filter((path) => {
      const source = code(path);
      return /FailedTransaction|effects\s*\?\.\s*status|Transaction\s*\?\.\s*status/.test(source);
    });

    expect(handRolled.map((p) => p.replace(process.cwd(), ''))).toEqual([]);
  });

  it('goes through the policy signer, whose gate is the SDK decoder that knows about FailedTransaction', () => {
    // The positive half. Without it this file would pass on a daemon that had simply stopped
    // checking simulation status altogether, which is worse than the defect it replaced. The
    // harvest adapter no longer simulates by hand at all: `policySigner` simulates, judges and
    // records before anything is signed, and its gate is the SDK's `simulate`.
    const signer = code(join(SRC, 'adapters', 'signer.ts'));
    expect(signer).toMatch(/\bpolicySigner\s*\(/);
    expect(signer).not.toMatch(/simulateTransaction\s*\(/);
  });
});
