// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Why every interface member in these two packages is a property function.
 *
 * TypeScript compares **method** parameters bivariantly and **property-function** parameters
 * contravariantly, even under `strict`. `strictFunctionTypes` — which is on in this package's
 * tsconfig — explicitly exempts members written with method syntax. So the two spellings below
 * are not a style choice; one of them has a hole in it and the other does not.
 *
 * The hole is not theoretical. An implementation whose parameter is *narrower* than the interface
 * promises is accepted under the method form, and it then reads a field the caller never agreed
 * to supply. The first test demonstrates that at runtime; the `@ts-expect-error` in the second is
 * the actual guard, because it fails `tsc --noEmit` if the property form ever stops rejecting it.
 *
 * This is not a hypothetical for this branch: the method form already let an under-specified
 * implementation through here once. That is why `Signer`, `SimulationPort`, `KmsTransport`,
 * `PolicySigner` and `Rule` are all written the other way.
 */

import { describe, expect, it } from 'vitest';
import type { Rule } from '@projectx-social/policy';
import type { Signer } from '../src/index.js';

/** What the interface promises a checker will be given. */
interface Input {
  readonly a: string;
}

/** What an under-specified implementation demands instead — strictly more. */
interface Narrower extends Input {
  readonly b: string;
}

interface AsMethod {
  check(input: Input): number;
}

interface AsProperty {
  readonly check: (input: Input) => number;
}

const underSpecified = (input: Narrower): number => input.b.length;

describe('method syntax is bivariant, and that is a real hole', () => {
  it('accepts an implementation that demands more than the interface promises', () => {
    // No error. TypeScript compares method parameters bivariantly.
    const accepted: AsMethod = { check: underSpecified };

    // And here is what that costs at runtime: the caller supplies exactly what the interface
    // promised, and the implementation reads a field that was never there.
    expect(() => accepted.check({ a: 'only a' })).toThrow(TypeError);
  });
});

describe('property-function syntax is contravariant, and rejects it', () => {
  it('will not compile the same implementation', () => {
    // @ts-expect-error — the parameter is narrower than the interface promises. If this line ever
    // stops erroring, `tsc --noEmit` fails on the unused @ts-expect-error and this file is the
    // thing that tells you the interfaces have drifted back to method syntax.
    const rejected: AsProperty = { check: underSpecified };
    void rejected;
    expect(true).toBe(true);
  });

  it('accepts an implementation that takes exactly what it is promised', () => {
    const correct: AsProperty = { check: (input) => input.a.length };
    expect(correct.check({ a: 'four' })).toBe(4);
  });

  it('accepts one that takes less, which is the safe direction', () => {
    const wider: AsProperty = { check: () => 0 };
    expect(wider.check({ a: 'x' })).toBe(0);
  });
});

describe('the real interfaces are written the safe way', () => {
  it('Signer rejects a signTransaction that demands more than Uint8Array', () => {
    const signer: Partial<Signer> = {
      // @ts-expect-error — Signer.signTransaction is a property function, so a narrower parameter
      // does not type-check. Under method syntax this would have been accepted silently.
      signTransaction: async (bytes: Uint8Array & { nonce: string }) => {
        void bytes.nonce;
        throw new Error('never reached');
      },
    };
    void signer;
    expect(true).toBe(true);
  });

  it('Rule.check rejects a checker that demands more than RuleInput', () => {
    const rule: Partial<Rule> = {
      // @ts-expect-error — same reason, in the package that decides whether money may move.
      check: (input: { effects: { sender: string }; extra: boolean }) =>
        input.extra ? input.effects.sender : null,
    };
    void rule;
    expect(true).toBe(true);
  });
});
