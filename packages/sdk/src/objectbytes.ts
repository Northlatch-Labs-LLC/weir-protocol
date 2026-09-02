// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
/**
 * One way to get an owned object's bytes out of a gRPC response.
 *
 * # Why this exists
 *
 * Four modules read owned objects and two of them decoded the response differently. `checkout.ts`
 * and `stake.ts` unwrapped a `{ value }` envelope and accepted a base64 string; `entitlement.ts`
 * and `purchases.ts` accepted neither. Both worked, because the transport happens to return a
 * shape the narrower one handles — so the disagreement was invisible and would stay invisible
 * until the day it wasn't.
 *
 * The failure it was heading for is worth naming precisely, because it is not a crash. If the
 * client ever returns the enveloped form, the narrow decoder yields `null`, the caller skips the
 * object, and a subscriber who paid is shown a locked post. No error, no log, nothing to
 * investigate — just a paying customer told they have not bought the thing they bought.
 *
 * # Failure is a value here, not a skip
 *
 * `decodeObjectBytes` returns `null` only for *absent* content. An object whose content is present
 * but unreadable is a failure the caller must handle, and the type makes that unavoidable rather
 * than a matter of remembering. Silently continuing past an undecodable entitlement is the exact
 * shape of the bug above.
 */

import { fail, ok, type Reading } from './reading.js';

/**
 * Bytes from whatever the transport handed back.
 *
 * Accepts, in order: an envelope with a `value`, raw bytes, a base64 string, a numeric array, and
 * the array-like object a JSON round trip turns a `Uint8Array` into (`{"0":1,"1":2,…}`). The last
 * looks paranoid and is not: it is what a `Uint8Array` becomes after `JSON.parse(JSON.stringify(x))`,
 * which is what happens to anything that crosses a route boundary.
 *
 * `ok(null)` means the object carried no content — the caller asked without `include: { content }`,
 * or the object genuinely has none. That is measured absence and it is distinct from the failure
 * branch, which means content was there and could not be read.
 */
export function decodeObjectBytes(
  content: unknown,
  source: string,
): Reading<Uint8Array | null> {
  if (content === undefined || content === null) return ok(null);

  // The envelope, if there is one. `?? content` rather than a branch, so a bare value and a
  // wrapped value take the same path from here down.
  const raw =
    typeof content === 'object' && content !== null && 'value' in content
      ? (content as { value?: unknown }).value
      : content;

  if (raw === undefined || raw === null) return ok(null);
  if (raw instanceof Uint8Array) return ok(raw);

  if (typeof raw === 'string') {
    if (raw === '') return ok(null);
    try {
      // `atob` rather than Buffer: this module is imported by browser code as well as the daemon,
      // and Buffer is not defined there. Node has had `atob` globally since v16.
      const binary = atob(raw);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return ok(bytes);
    } catch (error) {
      return fail(
        'malformed',
        source,
        `object content was a string but not base64: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  if (Array.isArray(raw)) {
    if (!raw.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      return fail('malformed', source, 'object content was an array but not of bytes');
    }
    return ok(Uint8Array.from(raw as number[]));
  }

  if (typeof raw === 'object') {
    const values = Object.values(raw as Record<string, unknown>);
    if (values.length === 0) return ok(null);
    if (!values.every((byte) => typeof byte === 'number' && Number.isInteger(byte) && byte >= 0 && byte <= 255)) {
      return fail('malformed', source, 'object content was an object but not array-like bytes');
    }
    return ok(Uint8Array.from(values as number[]));
  }

  return fail('malformed', source, `object content was a ${typeof raw}, which cannot be bytes`);
}

/**
 * Bytes, with a minimum length enforced.
 *
 * A capability struct has a known minimum size, and a buffer shorter than it is not a capability —
 * decoding it anyway yields a plausible object id that points nowhere. `checkout.ts` and
 * `stake.ts` both checked this by hand with the same constant written twice.
 *
 * A *present but too short* buffer is a failure, never an absence: it means the object matched the
 * type filter and then did not have the shape that type is supposed to have, which is a real
 * disagreement with the chain rather than a thing that is simply not there.
 */
export function decodeObjectBytesAtLeast(
  content: unknown,
  minimumBytes: number,
  source: string,
): Reading<Uint8Array | null> {
  const decoded = decodeObjectBytes(content, source);
  if (!decoded.ok) return decoded;
  if (decoded.value === null) return decoded;
  if (decoded.value.length < minimumBytes) {
    return fail(
      'malformed',
      source,
      `object content decoded to ${decoded.value.length} bytes, expected at least ${minimumBytes}`,
    );
  }
  return decoded;
}
