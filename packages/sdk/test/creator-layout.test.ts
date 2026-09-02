// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The `CreatorVault` BCS layout, asserted against the Move source.
 *
 * Same class of guard as the Platform one, and the same reason: BCS is positional and carries no
 * field names, so inserting a field in the Move struct would leave this decoder returning `min_tip`
 * as the accepting flag with nothing failing.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CREATOR_VAULT_BCS_FIELDS } from '../src/creator.js';

const SOURCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../sui-contracts/sources');
const source = readFileSync(resolve(SOURCES, 'creator.move'), 'utf8');

describe('CreatorVault BCS layout', () => {
  it('declares the same fields in the same order', () => {
    const body = /public struct CreatorVault<phantom T> has key \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, 'could not find `public struct CreatorVault` — renamed or reshaped').toBeDefined();

    const fields = [...body!.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]!);
    expect(fields).toEqual([...CREATOR_VAULT_BCS_FIELDS]);
  });

  it('Tier still has the fields the decoder reads, in order', () => {
    const body = /public struct Tier has copy, drop, store \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body).toBeDefined();
    const fields = [...body!.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]!);
    expect(fields).toEqual(['name', 'price', 'period_ms', 'active']);
  });

  it('subscribe still refuses a creator paying their own vault', () => {
    // The guard the checkout surfaces to users. If it were removed, the checkout's explanation
    // for abort 13 would describe something that no longer happens.
    expect(source).toContain('assert!(payer != vault.owner, ESelfPayment);');
  });
});

describe('the tier bounds the client mirrors', () => {
  /*
    `lib/creator-setup.ts` copies these so the studio can reject a bad period with a sentence rather
    than letting the user pay gas to be told "abort 9". A copy that drifted the other way would be
    worse: the client would forbid periods the chain accepts, and the restriction would exist only
    in a file nobody thinks to look in.
  */
  it('match the contract', () => {
    const max = /const MAX_TIERS: u64 = (\d+);/.exec(source)?.[1];
    const min = /const MIN_PERIOD_MS: u64 = ([^;]+);/.exec(source)?.[1];
    const maxPeriod = /const MAX_PERIOD_MS: u64 = ([^;]+);/.exec(source)?.[1];

    expect(max, 'MAX_TIERS renamed or removed').toBeDefined();
    expect(Number(max)).toBe(16);
    // Written as arithmetic in Move — evaluated rather than pattern-matched, so reformatting the
    // expression does not fail the test while changing the value silently would.
    expect(eval(min!.replace(/_/g, ''))).toBe(30 * 24 * 60 * 60 * 1000);
    expect(eval(maxPeriod!.replace(/_/g, ''))).toBe(3650 * 24 * 60 * 60 * 1000);
  });

  it('still refuses a period outside them', () => {
    expect(source).toContain('period_ms >= MIN_PERIOD_MS && period_ms <= MAX_PERIOD_MS');
  });
});
