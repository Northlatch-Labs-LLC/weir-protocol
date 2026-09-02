// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The bivariance hole, proven shut — and kept shut for interfaces nobody has written yet.
 *
 * # Why a test runs the compiler
 *
 * `test/types-must-reject.compile-only.ts` states the assertions, but a type-level assertion that
 * nothing runs is a comment. `pnpm --filter @projectx-social/agent typecheck` would catch it; a
 * suite that only exercises values would not, and the two are run by different people at different
 * times. So this file runs `tsc` and reads its output, which makes the compiler's verdict part of
 * the same `pnpm test` everything else is part of.
 *
 * # And why a test also reads the source text
 *
 * The compile assertions pin the interfaces that exist today. **Method versus property syntax is
 * not observable in the type system** — by the time a type is formed, the only trace is the
 * variance rule the checker applies — so no type-level assertion can say "this interface was
 * declared the safe way". The only place that fact survives is the source text, so the scan below
 * reads it. That is the half which catches the NEXT interface somebody adds, which is what the
 * defect report asked for and what a fixture pinning today's fields cannot do.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const HERE = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PACKAGE_ROOT = resolve(HERE, '..');
const SRC = join(PACKAGE_ROOT, 'src');
const TSC = join(PACKAGE_ROOT, 'node_modules', '.bin', 'tsc');

/** Run `tsc` and hand back its diagnostics as lines. A non-zero exit is normal and not a throw. */
function runTsc(args: string[], cwd: string): string[] {
  try {
    execFileSync(TSC, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return [];
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
}

describe('the compiler rejects an implementation that demands more than the interface promises', () => {
  /**
   * The diagnostics `tsc` produces for this package, filtered to the files this change owns.
   *
   * Filtered rather than asserted as "exit 0" for one honest reason: this package is worked on by
   * more than one author, and an unrelated file mid-edit elsewhere in `src/` would turn this into a
   * test that fails for reasons that have nothing to do with variance — which is the fastest way to
   * teach a team to ignore a red test. The files below are the ones the assertions are about, plus
   * every file under `test/`, and **TS2578 anywhere at all** is fatal because that is precisely the
   * signal that a guard stopped guarding.
   */
  const OWNED = ['src/index.ts', 'src/tx.ts', 'src/session.ts', 'src/keys.ts', 'src/manifest.ts'];

  const diagnostics = runTsc(['--noEmit'], PACKAGE_ROOT);

  it('reports no error in any file this suite asserts about', () => {
    const mine = diagnostics.filter(
      (line) => OWNED.some((f) => line.startsWith(f)) || line.startsWith('test/'),
    );
    expect(mine).toEqual([]);
  });

  it('reports no UNUSED @ts-expect-error anywhere — the signal that a guard stopped guarding', () => {
    // TS2578. If a rejection this suite depends on stops happening, the directive goes unused and
    // this line is what says so. It is checked across the whole package, not just owned files.
    expect(diagnostics.filter((line) => line.includes('TS2578'))).toEqual([]);
  });

  /**
   * The mechanism itself, measured rather than assumed.
   *
   * Two fixtures identical in every character except one: `decrypt(x): P` versus `decrypt: (x) => P`.
   * The property form must be rejected and the method form must be accepted. If TypeScript ever
   * changed this rule — or if this package's `strict` settings drifted — the assertions above would
   * still pass while meaning nothing, and only this test would notice.
   */
  it('proves the difference is the syntax and nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaela-variance-'));

    const fixture = (member: string): string => `
      interface Envelope { a: string; b: number }
      interface Consumer { ${member} }
      const demandsMore: Consumer = {
        decrypt: (_x: Envelope & { mustAlsoHave: true }) => 1,
      };
      export default demandsMore;
    `;

    writeFileSync(join(dir, 'property.ts'), fixture('decrypt: (input: Envelope) => number;'));
    writeFileSync(join(dir, 'method.ts'), fixture('decrypt(input: Envelope): number;'));
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2023', module: 'preserve' },
      }),
    );

    const errors = runTsc(['--noEmit', '-p', dir], dir);
    const inProperty = errors.filter((line) => line.includes('property.ts'));
    const inMethod = errors.filter((line) => line.includes('method.ts'));

    // The sound rule: an implementation demanding more is refused.
    expect(inProperty.length).toBeGreaterThan(0);
    expect(inProperty.join('\n')).toContain('not assignable');

    // The unsound one, kept by TypeScript for arrays and the DOM, and the reason this defect
    // existed at all: the identical code compiles when the member is written as a method.
    expect(inMethod).toEqual([]);
  });
});

describe('no interface in this package declares a member with method syntax', () => {
  /**
   * Strip comments so a doc block quoting `decrypt(input): T` is not mistaken for a declaration.
   *
   * Block comments go first, then whole-line `//`. Trailing `//` is left alone deliberately: a
   * naive strip would cut a URL in a string literal, and a false negative here is cheaper than a
   * mangled line. Nothing in this package declares an interface member on a line that also carries
   * a trailing comment, and if that changes the scan errs toward reporting rather than hiding.
   */
  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
  }

  /**
   * Member declarations written as methods, inside an `interface` or an object type alias.
   *
   * Class bodies are excluded: bivariance is a property of how a *type's* member is declared, and a
   * class's own methods are not a cross-module contract. `seal-node.ts` has three constructors and
   * they are not what this is about.
   */
  function methodSyntaxMembersIn(source: string): string[] {
    const clean = stripComments(source);
    const found: string[] = [];
    let depth = 0;
    let inTypeBody = false;
    let bodyDepth = 0;

    for (const raw of clean.split('\n')) {
      const line = raw.trim();

      if (!inTypeBody && /^(export\s+)?(interface\s+\w|type\s+\w[\w<>,\s]*=\s*\{)/.test(line)) {
        inTypeBody = true;
        bodyDepth = depth;
      }

      if (inTypeBody && depth > bodyDepth) {
        // `name(` or `name<T>(` or `name?(` at the head of a member, with no `function`, no arrow,
        // no `new`, and not a call expression.
        if (/^(readonly\s+)?[A-Za-z_$][\w$]*\??\s*(<[^>]*>)?\s*\(/.test(line)) {
          found.push(line);
        }
      }

      for (const ch of raw) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
      if (inTypeBody && depth <= bodyDepth) inTypeBody = false;
    }
    return found;
  }

  const files = readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  it.each(files)('%s', (file) => {
    const offenders = methodSyntaxMembersIn(readFileSync(join(SRC, file), 'utf8'));
    expect(
      offenders,
      `${file} declares an interface member with METHOD syntax, which TypeScript checks ` +
        `bivariantly even under strictFunctionTypes. Write it as a property function — ` +
        `\`name: (arg: T) => R\` — so an implementation demanding more than the interface ` +
        `promises is refused at compile time. See SealDecryptor in src/index.ts for what this ` +
        `cost the first time.`,
    ).toEqual([]);
  });

  it('the scanner would actually catch one', () => {
    // A scanner that finds nothing is indistinguishable from a scanner that looks nowhere. This is
    // the control: a synthetic offender must be reported, and its property-function twin must not.
    expect(
      methodSyntaxMembersIn('export interface Bad {\n  decrypt(input: X): Promise<Y>;\n}\n'),
    ).toHaveLength(1);
    expect(
      methodSyntaxMembersIn('export interface Good {\n  decrypt: (input: X) => Promise<Y>;\n}\n'),
    ).toEqual([]);
    expect(
      methodSyntaxMembersIn('export class Fine {\n  decrypt(input: X) { return input; }\n}\n'),
    ).toEqual([]);
    // A doc block quoting the dangerous form must not be reported.
    expect(
      methodSyntaxMembersIn(
        'export interface Ok {\n  /** never write `decrypt(x): T` */\n  decrypt: (x: X) => T;\n}\n',
      ),
    ).toEqual([]);
  });
});
