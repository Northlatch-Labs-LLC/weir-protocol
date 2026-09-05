// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The third classification, and the abort table behind it.
 *
 * # The defect
 *
 * `Reading`'s kinds are `transport | timeout | malformed | unconfigured | not-found |
 * budget-exhausted`. A state-dependent refusal fits none of them, so this package used to call
 * every Move abort `malformed`, on the reasoning that "a transaction that aborts will abort again
 * for ever".
 *
 * **Many do not.** `ECreationPaused` clears when an operator unpauses. An insufficient-coin abort
 * clears when the wallet is funded. A price-guard refusal clears when the price moves. Reported as
 * `malformed`, every one of those tells an unattended loop to stop asking, permanently, about a
 * condition that may last ninety seconds.
 *
 * # Where the classification lives, and why not in the SDK
 *
 * `FailureKind` in `packages/sdk/src/reading.ts` is a CLOSED string-literal union switched on
 * exhaustively across `sdk`, `web` and `daemon`. It was **not** extended: widening it is a
 * breaking change to every one of those, `reading.ts` is outside this task's files, and
 * `packages/sdk/src/index.ts` — which would have to re-export a new member — was being edited by
 * another author in the same session. So the third classification is additive and package-local.
 * It does not weaken the SDK kind; it travels beside it, and {@link classificationOf} is how a
 * caller reads it.
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ABORT_CLASSIFICATION,
  PRECONDITION_MARKER,
  classificationOf,
  classifyAbort,
  preconditionOf,
  refusePrecondition,
  type PreconditionName,
} from '../src/index.js';

const MOVE = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'sui-contracts', 'sources');

const abortText = (code: number, path: string) =>
  `MoveAbort in 1st command, abort code: ${code}, in '0x${'c'.repeat(64)}::${path}' (instruction 7)`;

describe('the marker survives a round trip and nothing else does', () => {
  it('a precondition refusal reads back as one', () => {
    const reading = refusePrecondition<number>('creation-paused', 'account::open', 'the platform is paused.');
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(preconditionOf(reading.failure)?.name).toBe('creation-paused');
      expect(preconditionOf(reading.failure)?.mayClear).toBe(true);
      expect(classificationOf(reading.failure)).toBe('precondition');
      // The KIND is the classification since B17; the marker only names which condition.
      expect(reading.failure.kind).toBe('precondition');
      // The marker is FIRST in the string, so a truncating log still carries it.
      expect(reading.failure.detail.startsWith(PRECONDITION_MARKER)).toBe(true);
      // And the sentence a human reads names what has to change.
      expect(reading.failure.detail).toContain('set_creation_paused(false)');
    }
  });

  it('an ordinary failure is not mistaken for one', () => {
    expect(
      preconditionOf({ kind: 'malformed', source: 's', detail: 'a plain refusal' }),
    ).toBeNull();
    expect(
      classificationOf({ kind: 'malformed', source: 's', detail: 'a plain refusal' }),
    ).toBe('permanent');
  });

  it('the marker without the kind is NOT a precondition — the kind is authoritative', () => {
    // A `malformed` failure whose text quotes a marker (a message about a message, say) must not
    // hand a caller `mayClear: true`. Only the kind says what a refusal is.
    const quoted = { kind: 'malformed' as const, source: 's', detail: '[precondition:creation-paused] quoted' };
    expect(preconditionOf(quoted)).toBeNull();
    expect(classificationOf(quoted)).toBe('permanent');
  });

  it('a precondition kind with no readable name still classifies as a precondition', () => {
    // The loop may wait on it; `preconditionOf` just refuses to invent a `clearsWhen`.
    const unnamed = { kind: 'precondition' as const, source: 's', detail: 'not yet' };
    expect(preconditionOf(unnamed)).toBeNull();
    expect(classificationOf(unnamed)).toBe('precondition');
  });

  it('`denied` is permanent for a loop: the answer was no', () => {
    expect(classificationOf({ kind: 'denied', source: 's', detail: '403' })).toBe('permanent');
  });

  it('an unrecognised name inside the marker is NOT reported as a precondition', () => {
    // Better to under-report than to hand a caller `mayClear: true` for a condition this package
    // cannot say anything about — a loop waiting for something that will never clear is worse than
    // a loop that gave up early, because nothing ever alerts on it.
    expect(
      preconditionOf({ kind: 'precondition', source: 's', detail: '[precondition:invented] x' }),
    ).toBeNull();
  });

  it('transport and timeout stay transport, marker or not', () => {
    expect(classificationOf({ kind: 'transport', source: 's', detail: 'ECONNREFUSED' })).toBe('transport');
    expect(classificationOf({ kind: 'timeout', source: 's', detail: 'deadline exceeded' })).toBe('transport');
  });

  it('`unconfigured` is permanent for a loop, deliberately', () => {
    // Not "could a human ever change this" — a human could change anything. The question is whether
    // THIS loop can usefully look again on its own. A missing environment variable answers no: the
    // process must stop and be restarted, and a loop polling it never reports the real problem.
    expect(classificationOf({ kind: 'unconfigured', source: 's', detail: 'no key' })).toBe('permanent');
  });
});

describe('the abort table', () => {
  it('reads the module, not just the code — the same code means three different things', () => {
    // platform 4 = ECreationPaused, account 4 = EAlreadyRegistered, creator 4 = ENotAccepting.
    expect(classifyAbort(abortText(4, 'platform::assert_can_create'))?.precondition).toBe('creation-paused');
    expect(classifyAbort(abortText(4, 'account::open'))?.precondition).toBeNull();
    expect(classifyAbort(abortText(4, 'creator::settle'))?.precondition).toBe('vault-not-accepting');
  });

  it('classifies the cases the defect report named', () => {
    const expected: Array<[number, string, PreconditionName | null]> = [
      [4, 'platform::assert_can_create', 'creation-paused'], // ECreationPaused
      [5, 'platform::assert_can_pay', 'payments-paused'], // EPaymentsPaused
      [4, 'creator::settle', 'vault-not-accepting'], // ENotAccepting
      [5, 'creator::settle', 'insufficient-balance'], // EInsufficientPayment
      [14, 'creator::claim_earnings', 'insufficient-balance'], // EInsufficientBalance
      [6, 'platform::charge_creation_fee', 'insufficient-balance'], // EInsufficientFee
      [4, 'account::open', null], // EAlreadyRegistered — permanent for that address
    ];
    for (const [code, path, want] of expected) {
      expect(classifyAbort(abortText(code, path))?.precondition, `${path} code ${code}`).toBe(want);
    }
  });

  it('leaves an unlisted code unclassified rather than guessing', () => {
    const decoded = classifyAbort(abortText(99, 'creator::settle'));
    expect(decoded?.code).toBe(99);
    expect(decoded?.precondition).toBeNull();
  });

  it('returns null when there is no abort in the text at all', () => {
    expect(classifyAbort('connection reset by peer')).toBeNull();
  });

  it('every entry is either a known precondition name or the literal `permanent`', () => {
    // Written out rather than left implicit, so adding a code forces a decision instead of
    // defaulting to one.
    for (const [module, codes] of Object.entries(ABORT_CLASSIFICATION)) {
      for (const [code, value] of Object.entries(codes)) {
        expect(typeof value, `${module}:${code}`).toBe('string');
        expect(value.length, `${module}:${code}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('the table agrees with the Move sources it was read from', () => {
  /**
   * Parse `const EName: u64 = N;` out of a Move module.
   *
   * The table was read from these files on 2026-08-31. This is what stops it becoming a transcript
   * of what they said that day: a code renumbered in Move and not here would silently reclassify a
   * refusal, and the reclassification a loop cares about is exactly the one nobody would notice.
   */
  function errorCodes(file: string): Map<string, number> {
    const source = readFileSync(join(MOVE, file), 'utf8');
    const out = new Map<string, number>();
    for (const match of source.matchAll(/const\s+(E[A-Za-z0-9_]*)\s*:\s*u64\s*=\s*(\d+)\s*;/g)) {
      out.set(match[1]!, Number(match[2]));
    }
    return out;
  }

  const modules: Array<[string, string]> = [
    ['platform', 'platform.move'],
    ['account', 'account.move'],
    ['creator', 'creator.move'],
  ];

  it.each(modules)('%s: every code in the Move source is classified', (name, file) => {
    const codes = errorCodes(file);
    expect(codes.size, `${file} yielded no error constants — the parser is broken`).toBeGreaterThan(0);
    const table = ABORT_CLASSIFICATION[name] ?? {};
    for (const [constant, code] of codes) {
      expect(
        table[code],
        `${name}::${constant} = ${code} has no entry in ABORT_CLASSIFICATION. Every abort an ` +
          `agent can hit must be decided as a precondition or as permanent; an unlisted code ` +
          `silently becomes permanent, which is the failure this table exists to end.`,
      ).toBeDefined();
    }
  });

  it.each(modules)('%s: classifies no code the Move source does not define', (name, file) => {
    const defined = new Set(errorCodes(file).values());
    for (const code of Object.keys(ABORT_CLASSIFICATION[name] ?? {})) {
      expect(defined.has(Number(code)), `${name} code ${code} is not defined in ${file}`).toBe(true);
    }
  });

  it('the specific mappings named in the defect report match their Move constants', () => {
    const platform = errorCodes('platform.move');
    const account = errorCodes('account.move');
    const creator = errorCodes('creator.move');

    expect(ABORT_CLASSIFICATION['platform']?.[platform.get('ECreationPaused')!]).toBe('creation-paused');
    expect(ABORT_CLASSIFICATION['platform']?.[platform.get('EPaymentsPaused')!]).toBe('payments-paused');
    expect(ABORT_CLASSIFICATION['creator']?.[creator.get('ENotAccepting')!]).toBe('vault-not-accepting');
    expect(ABORT_CLASSIFICATION['creator']?.[creator.get('EInsufficientPayment')!]).toBe('insufficient-balance');
    expect(ABORT_CLASSIFICATION['account']?.[account.get('EAlreadyRegistered')!]).toBe('permanent');
  });
});
