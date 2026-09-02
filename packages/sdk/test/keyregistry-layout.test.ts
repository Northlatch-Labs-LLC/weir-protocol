// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * The key registry BCS layout, asserted against the Move source.
 *
 * Same class of guard as the Platform and CreatorVault ones, and the same reason: BCS is positional
 * and carries no field names. Insert a field before `x25519_public` and this decoder keeps working
 * while returning somebody's version number as their encryption key — a value of the right type,
 * the wrong length, and no error anywhere.
 *
 * It also pins the parts of the contract the client depends on for behaviour rather than layout:
 * the 32-byte rule it validates against before asking a user to sign, and the absence of any
 * address parameter on `publish`, which is the whole reason this registry is on chain.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { KEY_BYTES, KEY_REGISTRY_BCS_FIELDS, PUBLISHED_KEY_BCS_FIELDS } from '../src/keyregistry.js';

const SOURCES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../sui-contracts/sources');
const source = readFileSync(resolve(SOURCES, 'key_registry.move'), 'utf8');

/**
 * The same source with every comment removed.
 *
 * The absence tests below must look at code. The module's own documentation explains at length why
 * it does not consult `Platform` and has no capability — asserting against the raw text would fail
 * on the explanation and pass if somebody deleted it, which is precisely backwards.
 */
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/^\s*\/\/\/.*$/gm, '');

describe('KeyRegistry BCS layout', () => {
  it('declares the same fields in the same order', () => {
    const body = /public struct KeyRegistry has key \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, 'could not find `public struct KeyRegistry` — renamed or reshaped').toBeDefined();

    const fields = [...body!.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]!);
    expect(fields).toEqual([...KEY_REGISTRY_BCS_FIELDS]);
  });

  it('still stores the keys in a Table, not inline', () => {
    /*
      The lookup derives a dynamic-field id from the table's id. If `keys` became a `vector` or a
      `VecMap`, every derivation would point at nothing and the client would report that no address
      on the platform has ever published a key — a total, silent failure that looks like an empty
      registry.
    */
    expect(source).toMatch(/keys:\s*Table<address, PublishedKey>/);
  });
});

describe('PublishedKey BCS layout', () => {
  it('declares the same fields in the same order', () => {
    const body = /public struct PublishedKey has copy, drop, store \{([\s\S]*?)\n\}/.exec(source)?.[1];
    expect(body, 'could not find `public struct PublishedKey`').toBeDefined();

    const fields = [...body!.matchAll(/^\s{4}([a-z_][a-z0-9_]*)\s*:/gm)].map((m) => m[1]!);
    expect(fields).toEqual([...PUBLISHED_KEY_BCS_FIELDS]);
  });

  it('the key is still a byte vector', () => {
    // Decoded as `vector<u8>`. If it became a fixed-size type or an address the decode would
    // silently misalign everything after it.
    expect(source).toMatch(/x25519_public:\s*vector<u8>/);
  });
});

describe('the contract rules the client relies on', () => {
  it('still requires exactly the key length the client checks', () => {
    const declared = /const KEY_BYTES: u64 = (\d+);/.exec(source)?.[1];
    expect(declared, 'KEY_BYTES was renamed or removed').toBeDefined();
    expect(Number(declared)).toBe(KEY_BYTES);
    expect(source).toContain('assert!(x25519_public.length() == KEY_BYTES, EKeyLength);');
  });

  it('still rejects the all-zero key', () => {
    // The client refuses it too, but a contract that accepted it would let an address publish a
    // point every shared secret against it derives to zero.
    expect(source).toContain('assert!(any_nonzero, EKeyDegenerate);');
  });

  it('publish takes no address — the sender is the only subject', () => {
    /*
      The property the whole on-chain registry exists for. If `publish` ever gained an `owner`
      parameter, the substitution attack the database registry was vulnerable to would be back,
      and this client would have no way to notice.
    */
    const signature = /public fun publish\(([\s\S]*?)\)\s*\{/.exec(source)?.[1];
    expect(signature, 'could not find `public fun publish`').toBeDefined();
    expect(signature).not.toMatch(/:\s*address/);
    expect(source).toContain('let owner = ctx.sender();');
  });

  it('has no administrative override', () => {
    expect(code).not.toMatch(/Cap\b/);
  });

  it('does not consult the platform, so a pause cannot stop key publication', () => {
    expect(code).not.toContain('platform::');
    expect(code).not.toContain('Platform');
  });
});
