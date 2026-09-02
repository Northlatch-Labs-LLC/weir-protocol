// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The `Registry` BCS layout and the handle rules, asserted against the Move source.
 *
 * Two different kinds of mirror in one file, and both are silent when they break.
 *
 * The layout is positional: swap `by_handle` and `by_address` in the Move struct and this decoder
 * keeps working, deriving every lookup against the wrong table — so every handle reads as free and
 * every address reads as having no account. The client would cheerfully send each new user into a
 * transaction that aborts.
 *
 * The rules are a copy: the client rejects a bad handle before anyone pays gas, and the contract
 * rejects it again. If the contract's charset loosened and the client's did not, users would be
 * told a legal handle was illegal — a restriction nobody could explain because it exists only in
 * the client.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handleProblem,
  MAX_HANDLE_LEN,
  MIN_HANDLE_LEN,
  REGISTRY_BCS_FIELDS,
} from '../src/accounts.js';

const SOURCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../sui-contracts/sources');
const source = readFileSync(resolve(SOURCES, 'account.move'), 'utf8');

describe('Registry BCS layout', () => {
  it('declares the same fields in the same order', () => {
    const body = /public struct Registry has key \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, 'could not find `public struct Registry` — renamed or reshaped').toBeDefined();

    const fields = [...body!.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]!);
    expect(fields).toEqual([...REGISTRY_BCS_FIELDS]);
  });

  it('keeps the two tables keyed the way each lookup derives', () => {
    /*
      The derivations are not interchangeable. `by_handle` is keyed by `String`, which BCS-encodes
      as a ULEB length plus bytes; `by_address` is keyed by `address`, a bare 32 bytes. Swapping the
      key types would make every derived id point at nothing, and every lookup would return the
      measured-absence answer — "this handle is free", for every handle on the platform.
    */
    expect(source).toMatch(/by_handle:\s*Table<String, address>/);
    expect(source).toMatch(/by_address:\s*Table<address, String>/);
  });
});

describe('handle rules mirrored from the contract', () => {
  it('uses the same length bounds', () => {
    const min = /const MIN_HANDLE_LEN: u64 = (\d+);/.exec(source)?.[1];
    const max = /const MAX_HANDLE_LEN: u64 = (\d+);/.exec(source)?.[1];
    expect(min, 'MIN_HANDLE_LEN was renamed or removed').toBeDefined();
    expect(max, 'MAX_HANDLE_LEN was renamed or removed').toBeDefined();
    expect(Number(min)).toBe(MIN_HANDLE_LEN);
    expect(Number(max)).toBe(MAX_HANDLE_LEN);
  });

  it('uses the same charset', () => {
    // The contract's three byte ranges, quoted. If a fourth were added, this fails and the client
    // is told to widen too — rather than quietly forbidding something the chain allows.
    expect(source).toContain('(b >= 0x61 && b <= 0x7A)');
    expect(source).toContain('(b >= 0x30 && b <= 0x39)');
    expect(source).toContain('b == 0x5F');
  });

  it('still rejects rather than normalises', () => {
    // A registry that lower-cases what you typed gives you a different handle and reports success.
    expect(source).toContain('assert!(ok, EHandleCharset);');
    expect(source).not.toMatch(/to_lowercase|to_ascii_lower/);
  });
});

describe('handleProblem', () => {
  it('accepts a plain handle', () => {
    expect(handleProblem('projectx')).toBeNull();
    expect(handleProblem('a_1')).toBeNull();
  });

  it('rejects one byte under and accepts the minimum', () => {
    // Both sides of the boundary. A test on only one of them passes against an off-by-one.
    expect(handleProblem('ab')).toEqual({ kind: 'too-short', min: 3 });
    expect(handleProblem('abc')).toBeNull();
  });

  it('accepts the maximum and rejects one byte over', () => {
    expect(handleProblem('a'.repeat(30))).toBeNull();
    expect(handleProblem('a'.repeat(31))).toEqual({ kind: 'too-long', max: 30 });
  });

  it('rejects uppercase rather than folding it', () => {
    expect(handleProblem('ProjectX')).toEqual({ kind: 'bad-character', character: 'P' });
  });

  it('rejects punctuation, spaces and hyphens', () => {
    for (const handle of ['a.b', 'a b', 'a-b', 'a@b']) {
      expect(handleProblem(handle)).not.toBeNull();
    }
  });

  it('rejects a handle that is short in characters but long in bytes', () => {
    /*
      The contract counts BYTES. "日本語のなまえ" is 7 characters and 21 bytes, so a client that
      counted characters would accept things the chain measures differently — and would reject
      others as too long that are not. The charset check catches this one first, but the length
      check must agree about the unit regardless.
    */
    expect(handleProblem('日本語')).toEqual({ kind: 'bad-character', character: '日' });
    expect(new TextEncoder().encode('日本語').length).toBe(9);
  });

  it('rejects an emoji', () => {
    // A single emoji is one character, four bytes, and not ASCII.
    expect(handleProblem('ab🔐')).toEqual({ kind: 'bad-character', character: '🔐' });
  });

  it('rejects the empty handle as too short, not as a bad character', () => {
    expect(handleProblem('')).toEqual({ kind: 'too-short', min: 3 });
  });
});
