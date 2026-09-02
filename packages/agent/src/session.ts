// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Getting a read session, without a browser.
 *
 * # What a session is here, and what it very deliberately is not
 *
 * `packages/web/lib/read-session.ts` is unusually honest about this and the honesty is worth
 * carrying across the boundary rather than restating loosely. The token minted by
 * `POST /api/session` is a **bearer token**, and it is bounded on purpose:
 *
 *   - It grants **reads only**. Every write still needs a fresh single-use signature.
 *   - It grants **only what the address already owns** — the chain is consulted per request; the
 *     session merely settles *whose* entitlements to ask about.
 *   - It expires after a day, and it is revocable.
 *
 * A stolen agent session therefore cannot publish, spend, unlock, follow or send. That containment
 * is the reason a bearer token is acceptable at all, and it is why this module holds the token in
 * memory and never writes it anywhere.
 *
 * # Why an agent needs one, when it could sign every read
 *
 * `read-content` is single-use and spent. `read` is not. An agent polling a feed could in principle
 * sign each request — but a session is one signature a day instead of one per poll, and the
 * signature it replaces is the *expensive* kind: the replay ledger writes a row per single-use
 * signature, so a chatty agent signing every read would be writing to `used_signatures` on a timer
 * for no gain in authority.
 *
 * # Bearer or cookie: both are supported and bearer wins
 *
 * A cookie is a browser's mechanism, and a headless client re-implementing cookie storage to talk to
 * one endpoint is a jar with one entry in it. So the reader side now takes a header instead:
 * `provenReaderFor` in `read-session.ts` accepts `Authorization: Bearer <token>` against the same
 * row, the same expiry and the same revocation — verified by reading that file, not assumed. Its
 * parser is strict in two ways this client satisfies by construction: the scheme is compared
 * case-insensitively, and a credential containing **any** whitespace is refused outright, so the
 * token is emitted with exactly one space after `Bearer` and never wrapped or padded.
 *
 * The other half landed too: `POST /api/session` answers `{ address, expiresAtMs }`, and adds
 * `token` **only when the request asks for it** with `x-weir-bearer: 1`. This client asks — see the
 * header set on the request below. Read from the route rather than assumed, which is why
 * {@link BEARER_FIELDS} names exactly one field instead of guessing at several.
 *
 * This paragraph said the token came back unconditionally, which was true when it was written and
 * false the moment the route began withholding it. It is corrected here rather than only at the
 * request, because a reader looking for the SHAPE of the response reads the top of the file and a
 * reader looking for the header reads the middle, and the two disagreed.
 *
 * The route is explicit about what that costs and it is repeated here rather than left behind a
 * link, because a client author is entitled to know what they are holding: `HttpOnly` still stops
 * script reading the *stored* cookie, but script running during the exchange can read the response,
 * so cross-site scripting on that origin can carry a token away and use it for a day from
 * somewhere else. Narrow, genuinely widened, and bounded by the same three things as ever — reads
 * only, only of what the address already owns on chain, and `DELETE /api/session` withdraws every
 * session at once.
 *
 * So {@link openSession} reads both and **prefers the bearer when one is present**, falling back to
 * the cookie. The fallback is not dead code kept for symmetry: it is what runs against a deployment
 * that has not shipped the body token yet, and the value it replays is the same token the header
 * would have carried — one row, one expiry, one revocation, whichever carrier it travelled in.
 *
 * {@link BEARER_FIELDS} names exactly one field, `token`, because that is what the route returns.
 * Resist widening it on a hunch: a probe list is a client that silently accepts a field nobody
 * meant to publish, and the cost of being wrong here is reading as anonymous while believing
 * otherwise — which is a paywall shown to somebody who paid.
 *
 * It never invents a session. A response with neither a cookie nor a recognised bearer is a
 * failure, not an anonymous session that quietly reads less than the caller asked for — a paid post
 * silently rendered as a paywall is the exact defect `read-session.ts` was written to end.
 */

import { fail, ok, type Reading } from '@projectx-social/sdk';
import type { AgentKey } from './keys.js';
import { signAction } from './statements.js';

/**
 * The cookie `read-session.ts` sets.
 *
 * Mirrored, and mirrored with the same caveat the statement format carries: the `web` package
 * exports nothing, so this cannot be imported. It is `projectx_read` and it is deliberately not
 * called `session` — the original's words: "this is not one in the sense anybody expects. It
 * authenticates a reader and authorises nothing."
 */
export const READ_SESSION_COOKIE = 'projectx_read';

/**
 * The JSON field the bearer token arrives in.
 *
 * One entry, read from `packages/web/app/api/session/route.ts`, which answers
 * `{ address, expiresAtMs, token }`. A list rather than a constant only because the fallback below
 * iterates it — and because naming the shape makes a future rename a one-line change in a file that
 * says why, rather than a string buried in a parser.
 */
export const BEARER_FIELDS = ['token'] as const;

export interface SessionCredential {
  /** How the token travels. `bearer` when the server offered one, `cookie` otherwise. */
  readonly kind: 'bearer' | 'cookie';
  /** The address this session speaks for, as the server reported it back. */
  readonly address: string;
  /**
   * When it stops working, or `null` when the server did not say.
   *
   * `null` is not treated as "for ever". {@link isExpired} answers `false` for it — the session may
   * well be live — and the caller is expected to handle a 401 by opening a new one, which is the
   * only reliable expiry check against a server that can revoke.
   */
  readonly expiresAtMs: number | null;
  /**
   * Headers to attach to a request that should be made *as* this reader.
   *
   * Declared as a **property function**, not a method, and the same rule holds for every member of
   * every interface in this package. Under `strictFunctionTypes` TypeScript checks method
   * parameters bivariantly and property-function parameters contravariantly, so method syntax
   * quietly accepts an implementation that demands more of its arguments than the interface
   * promises. That unsoundness already shipped once here, on `SealDecryptor` — see the doc block
   * there — and `test/interface-variance.test.ts` now fails on any method-syntax member found
   * anywhere under `src/`.
   */
  headers: () => Record<string, string>;
  isExpired: (nowMs?: number) => boolean;
}

/** Injected so tests need no network, and so a caller can supply their own retrying fetch. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Prove control of the agent's address and take a read session for it.
 *
 * The signature is spent — `read-content` is single-use — so this is not idempotent and a failed
 * call must be retried with a **new** signature, which is what calling this function again does.
 * Retrying with the same one earns `this signature has already been used`.
 */
export async function openSession(input: {
  key: AgentKey;
  /** Origin with no trailing slash, as {@link import('./manifest.js').AgentManifest} normalises it. */
  baseUrl: string;
  fetchImpl?: FetchLike;
}): Promise<Reading<SessionCredential>> {
  const source = 'read session';
  const doFetch = input.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
  if (doFetch === undefined) {
    return fail('unconfigured', source, 'no fetch implementation is available in this runtime.');
  }

  // The origin is the deployment this session is for: the same bytes must not open a session
  // anywhere else.
  const signed = await signAction(input.key.keypair, { kind: 'read-content' }, input.baseUrl);

  let response: Response;
  try {
    response = await doFetch(`${input.baseUrl}/api/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        /*
          Ask for the bearer token in the body.

          The route now withholds it unless asked, because a browser gets one it never reads while
          script on that origin could carry it away for a day. This client is the caller it was
          built for: it holds a key, has no cookie jar, and would otherwise parse `Set-Cookie` to
          obtain a credential the server just minted for it.

          A deployment that does not know this header still works — it returns no token, and the
          fallback below reads the cookie instead.
        */
        'x-weir-bearer': '1',
      },
      // `statement` is deliberately absent. The server rebuilds it; sending ours would invite the
      // substitution `identity.ts` refuses to allow.
      body: JSON.stringify({
        address: signed.address,
        signature: signed.signature,
        timestampMs: signed.timestampMs,
      }),
    });
  } catch (error) {
    return fail(
      'transport',
      source,
      `could not reach ${input.baseUrl}/api/session: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const body = await readJson(response);

  if (!response.ok) {
    /*
      The server's own words are passed through unmodified.

      A 401 here has several distinct causes that look identical from outside — an expired
      statement, a spent signature, a clock more than sixty seconds fast — and only the route can
      tell them apart. Substituting a friendlier sentence would discard the one piece of
      information that names which.
    */
    const detail =
      typeof body?.['error'] === 'string' ? body['error'] : `HTTP ${response.status}`;
    return fail(response.status === 401 ? 'malformed' : 'transport', source, detail);
  }

  const address = typeof body?.['address'] === 'string' ? body['address'] : signed.address;
  const expiresAtMs =
    typeof body?.['expiresAtMs'] === 'number' && Number.isFinite(body['expiresAtMs'])
      ? body['expiresAtMs']
      : null;

  const bearer = bearerFrom(body);
  if (bearer !== null) {
    return ok(credential('bearer', { Authorization: `Bearer ${bearer}` }, address, expiresAtMs));
  }

  const cookie = readSessionCookieFrom(response.headers);
  if (cookie !== null) {
    return ok(
      credential('cookie', { cookie: `${READ_SESSION_COOKIE}=${cookie}` }, address, expiresAtMs),
    );
  }

  return fail(
    'malformed',
    source,
    `the session endpoint returned 200 but carried neither a ${READ_SESSION_COOKIE} cookie nor a ` +
      `bearer token in any of the fields this client recognises (${BEARER_FIELDS.join(', ')}). ` +
      `No session was created — continuing would read as an anonymous caller while believing it ` +
      `was authenticated.`,
  );
}

function credential(
  kind: 'bearer' | 'cookie',
  headers: Record<string, string>,
  address: string,
  expiresAtMs: number | null,
): SessionCredential {
  return {
    kind,
    address,
    expiresAtMs,
    // A fresh object per call. Returning the stored one would let a caller mutate the credential
    // by editing the headers they were handed, which is a bug that presents as an intermittent 401.
    headers: () => ({ ...headers }),
    isExpired: (nowMs: number = Date.now()) => expiresAtMs !== null && nowMs >= expiresAtMs,
  };
}

/**
 * Pull the read-session cookie out of a response.
 *
 * `getSetCookie()` first, because a response may legitimately carry several `Set-Cookie` headers
 * and the single-header accessor folds them into one comma-joined string — from which a cookie
 * value containing a comma cannot be recovered. The fallback exists for runtimes whose `Headers`
 * predates that method, and it parses the folded form rather than pretending it cannot.
 */
export function readSessionCookieFrom(headers: Headers): string | null {
  const all: string[] =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : ((h) => (h === null ? [] : [h]))(headers.get('set-cookie'));

  for (const line of all) {
    // Only the first `=` separates a cookie's name from its value, and only the first `;` ends it.
    // The attributes after that point (`Path`, `HttpOnly`, `Max-Age`) are not part of the value.
    const pair = line.split(';', 1)[0] ?? '';
    const separator = pair.indexOf('=');
    if (separator === -1) continue;
    if (pair.slice(0, separator).trim() !== READ_SESSION_COOKIE) continue;
    const value = pair.slice(separator + 1).trim();
    // A cleared cookie is `projectx_read=` with `Max-Age=0`. Empty is an absence, not a session.
    if (value !== '') return value;
  }
  return null;
}

/** The first recognised bearer field carrying a non-empty string, or `null`. */
function bearerFrom(body: Record<string, unknown> | null): string | null {
  if (body === null) return null;
  for (const field of BEARER_FIELDS) {
    const value = body[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Parse a JSON body, or `null`.
 *
 * A body that is not JSON is not an error worth propagating on its own: an HTML error page from a
 * proxy in front of the app is a real thing that happens, and the status code already says what
 * went wrong. Returning `null` lets the caller fall back to `HTTP <status>`, which is more useful
 * than a JSON parse error naming a byte offset in somebody's 502 page.
 */
async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = await response.json();
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
