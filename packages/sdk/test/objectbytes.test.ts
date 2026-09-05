// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Getting an owned object's bytes out of a gRPC response.
 *
 * This decoder replaced three hand-written ones that disagreed with each other. The narrowest
 * handled neither the `{ value }` envelope nor a base64 string, and its caller skipped anything it
 * could not decode — so on a transport that returned either shape, a subscriber who had paid would
 * have been shown a locked post with no error raised anywhere.
 *
 * The shape cases below are therefore not hypothetical inputs. They are the four representations
 * observed across the codebase, plus the one a JSON round trip produces.
 */

import { describe, expect, it } from 'vitest';
import { decodeObjectBytes, decodeObjectBytesAtLeast } from '../src/objectbytes.js';

const SOURCE = 'test';
const bytes = (reading: ReturnType<typeof decodeObjectBytes>): Uint8Array => {
  if (!reading.ok) throw new Error(`expected ok, got ${reading.failure.detail}`);
  if (reading.value === null) throw new Error('expected bytes, got measured absence');
  return reading.value;
};

describe('every shape the transport has been seen to return', () => {
  const expected = Uint8Array.from([1, 2, 3, 250]);

  it('raw bytes', () => {
    expect(bytes(decodeObjectBytes(expected, SOURCE))).toEqual(expected);
  });

  it('bytes inside a { value } envelope — the case entitlement.ts could not read', () => {
    expect(bytes(decodeObjectBytes({ value: expected }, SOURCE))).toEqual(expected);
  });

  it('a base64 string — the other case entitlement.ts could not read', () => {
    expect(bytes(decodeObjectBytes('AQID+g==', SOURCE))).toEqual(expected);
  });

  it('a base64 string inside an envelope', () => {
    expect(bytes(decodeObjectBytes({ value: 'AQID+g==' }, SOURCE))).toEqual(expected);
  });

  it('a numeric array', () => {
    expect(bytes(decodeObjectBytes([1, 2, 3, 250], SOURCE))).toEqual(expected);
  });

  it('the array-like object a JSON round trip produces', () => {
    // `JSON.parse(JSON.stringify(new Uint8Array([1,2,3])))` is `{"0":1,"1":2,"2":3}`. Anything
    // crossing a route boundary arrives in this form.
    const roundTripped = JSON.parse(JSON.stringify(expected)) as unknown;
    expect(bytes(decodeObjectBytes(roundTripped, SOURCE))).toEqual(expected);
  });
});

describe('absence is measured, and is not a failure', () => {
  it.each([
    ['undefined content', undefined],
    ['null content', null],
    ['an envelope holding nothing', { value: null }],
    ['an empty string', ''],
    ['an empty object', {}],
  ])('%s reads as null inside an ok', (_label, input) => {
    const reading = decodeObjectBytes(input, SOURCE);
    expect(reading.ok).toBe(true);
    if (reading.ok) expect(reading.value).toBeNull();
  });
});

describe('unreadable content is a failure, never an absence', () => {
  /*
   * The distinction this file exists to enforce. `null` means "the object carried no content".
   * A failure means "content was there and could not be read". Collapsing the two is what let a
   * paid entitlement read as absent — and the caller, seeing `null`, would carry on and lock the
   * post rather than reporting that it could not tell.
   */
  it.each([
    ['a number', 42],
    ['a boolean', true],
    ['an array with a non-byte', [1, 2, 999]],
    ['an array with a negative', [1, -2, 3]],
    ['an array with a fraction', [1, 2.5, 3]],
    ['an object with a non-numeric value', { 0: 1, 1: 'x' }],
  ])('%s is a failure', (_label, input) => {
    const reading = decodeObjectBytes(input, SOURCE);
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.failure.kind).toBe('malformed');
  });

  it('names the source, so a failure says which read produced it', () => {
    const reading = decodeObjectBytes(42, 'entitlements of 0xabc');
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.failure.source).toBe('entitlements of 0xabc');
  });
});

describe('the minimum-length guard for capability structs', () => {
  /*
   * A `CreatorCap` is 32 bytes of id then 32 bytes of vault id. A shorter buffer matched the type
   * filter and then did not have that type's shape — decoding it anyway yields a plausible object
   * id pointing at nothing, which is worse than an error because it looks like an answer.
   */
  it('accepts a buffer at exactly the minimum', () => {
    const reading = decodeObjectBytesAtLeast(new Uint8Array(64), 64, SOURCE);
    expect(reading.ok).toBe(true);
  });

  it('refuses one byte short', () => {
    const reading = decodeObjectBytesAtLeast(new Uint8Array(63), 64, SOURCE);
    expect(reading.ok).toBe(false);
  });

  it('says how short it was, so the message is actionable', () => {
    const reading = decodeObjectBytesAtLeast(new Uint8Array(10), 64, SOURCE);
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(reading.failure.detail).toContain('10');
      expect(reading.failure.detail).toContain('64');
    }
  });

  it('passes absence through unchanged rather than calling it too short', () => {
    // Zero bytes because there is nothing there is not the same as zero bytes because the object
    // was truncated. Only the second is a disagreement with the chain.
    const reading = decodeObjectBytesAtLeast(undefined, 64, SOURCE);
    expect(reading.ok).toBe(true);
    if (reading.ok) expect(reading.value).toBeNull();
  });

  it('propagates a decode failure rather than reporting a length problem', () => {
    const reading = decodeObjectBytesAtLeast(42, 64, SOURCE);
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(reading.failure.detail).not.toContain('at least');
  });
});

describe('no caller can accidentally treat a failure as empty bytes', () => {
  it('never returns a zero-length array in place of a failure', () => {
    // The regression this whole module prevents: a decoder that returned `new Uint8Array()` on a
    // problem would parse as a struct full of zeros rather than raising anything.
    for (const input of [42, true, [1, 999], { 0: 'x' }]) {
      const reading = decodeObjectBytes(input, SOURCE);
      expect(reading.ok).toBe(false);
    }
  });
});
