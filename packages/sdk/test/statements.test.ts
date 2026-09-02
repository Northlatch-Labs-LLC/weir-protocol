// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The statement bytes, pinned to what they were before this module existed.
 *
 * # What this file is
 *
 * `statementFor` used to live in `packages/web/lib/identity.ts`, with a hand copy in
 * `packages/agent/src/statements.ts`. Hoisting it here removed the copy. The risk in that move is
 * not that it stops compiling — it is that **one byte changes and nothing complains.** A signature
 * is made over these exact bytes and verified by rebuilding them; a changed space silently
 * invalidates every signature in flight, and the error the user is handed is `the signature does
 * not prove control of 0x…`, which points at their wallet.
 *
 * So {@link GOLDEN} below is not written by hand and is not derived from anything in this package.
 * Every string in it was **executed out of `packages/web/lib/identity.ts` before the hoist**, with
 * the fixed address and timestamp below, and pasted here verbatim. The same vectors were also run
 * against the agent's copy and came back identical, which is the last measurement that copy will
 * ever produce.
 *
 * A failure here is never a formatting nit. It means live wallets are about to be refused.
 *
 * # Why the fixtures look like that
 *
 * `comment` carries an em dash on purpose. It is the character the copy's own doc block warned
 * about — "an em dash where a hyphen belongs is a total failure with a misleading message" — and
 * it is the one that would survive a careless encoding change without anybody noticing in ASCII.
 * `send(free)` pins the trailing `paid: ` with nothing after it, because free is a value that gets
 * signed rather than the absence of one, and an empty field is exactly what a "tidy up" deletes.
 * Both boolean branches of `follow` and `set-perks` are pinned because they print a word where
 * every other field prints a slot.
 */

import { describe, expect, it } from 'vitest';
import { accessStatement, parseAccessStatement } from '../src/statements.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HEAD_LINES,
  isSingleUse,
  statementFor,
  SIGNATURE_WINDOW_MS,
  STATEMENT_SHAPES,
  type Action,
} from '../src/statements.js';

/** The address and issue time every golden vector was captured with. Changing either is a rewrite. */
const ADDRESS = `0x${'ab'.repeat(32)}`;
/** The deployment the bytes are bound to. Portable statements were the defect. */
const ORIGIN = 'https://weir.social';
const AT = 1_756_600_000_000;

/**
 * Captured from `packages/web/lib/identity.ts` BEFORE the hoist. Do not regenerate these from the
 * current implementation — that would make this file assert that the code equals itself.
 */
const GOLDEN: Readonly<Record<string, string>> = {
  "comment": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: comment\npost: pmtgxlqay\ntext: a comment — with an em dash",
  "follow(true)": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: follow\ncreator: atlas",
  "follow(false)": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: unfollow\ncreator: atlas",
  "send": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: send\nto: 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd\ntext: hello\npreview: hel\npaid: atlas:key-1:10000",
  "send(free)": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: send\nto: 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd\ntext: hello\npreview: hel\npaid: ",
  "send-encrypted": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: send encrypted\nto: 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd\nciphertext-sha256: eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "read": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: read\nthread with: 0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
  "onramp": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: fund wallet\nwallet: 0xabababababababababababababababababababababababababababababababab\nnetwork: mainnet",
  "read-content": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: read content",
  "publish": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: publish\ncreator: atlas\naccess: paid\ntitle: Sealed on Walrus\ncontent-sha256: ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff\nkey: sealed-on-walrus-001\nprice: 10000",
  "name-vault": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: name vault\nvault: 0x1111111111111111111111111111111111111111111111111111111111111111\nname: Atlas\nbio: Documentary notes.\ncoin: 0x2::sui::SUI",
  "set-profile": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: set profile\nhandle: atlas\nname: Atlas",
  "set-perks(true)": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: set perks\nhandle: atlas\nperks-sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsupporters-first: yes",
  "set-perks(false)": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: set perks\nhandle: atlas\nperks-sha256: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\nsupporters-first: no",
  "declare-agent": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: declare agent\noperated by: 0x2222222222222222222222222222222222222222222222222222222222222222\nmodel: claude-opus-5\npurpose: publishes notes",
  "declare-operator": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: declare operator\noperating: 0x3333333333333333333333333333333333333333333333333333333333333333\nmodel: claude-opus-5\npurpose: publishes notes",
  "upload": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: upload\npost: pmtgxlqay\nfile-sha256: bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  // Written by hand on 2026-09-02 when the action was added, from the design paper, not from the code.
  "remember": "Weir\naddress: 0xabababababababababababababababababababababababababababababababab\nissued: 1756600000000\norigin: https://weir.social\naction: remember\nlabel: session-notes\nciphertext-sha256: cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc\nbytes: 4096",
};

/**
 * The action that produces each golden vector.
 *
 * Labelled rather than keyed by kind, because two kinds have two branches and both are pinned.
 * {@link everyKindIsCovered} asserts this list reaches every member of the union, so a kind added
 * to `Action` without a vector fails here rather than shipping unpinned.
 */
const CASES: ReadonlyArray<readonly [string, Action]> = [
  ['comment', { kind: 'comment', postId: 'pmtgxlqay', text: 'a comment — with an em dash' }],
  ['follow(true)', { kind: 'follow', handle: 'atlas', following: true }],
  ['follow(false)', { kind: 'follow', handle: 'atlas', following: false }],
  [
    'send',
    { kind: 'send', to: `0x${'cd'.repeat(32)}`, text: 'hello', preview: 'hel', paid: 'atlas:key-1:10000' },
  ],
  ['send(free)', { kind: 'send', to: `0x${'cd'.repeat(32)}`, text: 'hello', preview: 'hel', paid: '' }],
  [
    'send-encrypted',
    { kind: 'send-encrypted', to: `0x${'cd'.repeat(32)}`, ciphertextSha256: 'e'.repeat(64) },
  ],
  ['read', { kind: 'read', other: `0x${'cd'.repeat(32)}` }],
  ['read-content', { kind: 'read-content' }],
  [
    'onramp',
    { kind: 'onramp', walletAddress: `0x${'ab'.repeat(32)}`, network: 'mainnet' },
  ],

  [
    'publish',
    {
      kind: 'publish',
      handle: 'atlas',
      title: 'Sealed on Walrus',
      access: 'paid',
      contentSha256: 'f'.repeat(64),
      contentKey: 'sealed-on-walrus-001',
      price: '10000',
    },
  ],
  [
    'name-vault',
    {
      kind: 'name-vault',
      vaultId: `0x${'11'.repeat(32)}`,
      name: 'Atlas',
      bio: 'Documentary notes.',
      coinType: '0x2::sui::SUI',
    },
  ],
  ['set-profile', { kind: 'set-profile', handle: 'atlas', name: 'Atlas' }],
  [
    'set-perks(true)',
    { kind: 'set-perks', handle: 'atlas', perksSha256: 'a'.repeat(64), supportersFirst: true },
  ],
  [
    'set-perks(false)',
    { kind: 'set-perks', handle: 'atlas', perksSha256: 'a'.repeat(64), supportersFirst: false },
  ],
  [
    'declare-agent',
    { kind: 'declare-agent', operator: `0x${'22'.repeat(32)}`, model: 'claude-opus-5', purpose: 'publishes notes' },
  ],
  [
    'declare-operator',
    { kind: 'declare-operator', agent: `0x${'33'.repeat(32)}`, model: 'claude-opus-5', purpose: 'publishes notes' },
  ],
  ['remember', { kind: 'remember', label: 'session-notes', sha256: 'c'.repeat(64), bytes: '4096' }],
  ['upload', { kind: 'upload', postId: 'pmtgxlqay', fileSha256: 'b'.repeat(64) }],
];

describe('statementFor still builds the bytes it built before the hoist', () => {
  it.each(CASES)('%s', (label, action) => {
    expect(statementFor(action, ADDRESS, AT, ORIGIN)).toBe(GOLDEN[label]);
  });

  it('pins every case, and no vector goes unused', () => {
    // A golden entry with no case would be a byte string nothing compares against — a test that
    // reads as coverage and is not.
    expect(CASES.map(([label]) => label).sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  it('everyKindIsCovered', () => {
    /*
      A `Record` over the union, so a kind ADDED to `Action` and forgotten fails to compile here
      rather than shipping with no golden vector. The runtime assertion catches the other
      direction: a kind renamed in the union but left in this list.
    */
    const covered: Record<Action['kind'], true> = {
      comment: true,
      follow: true,
      send: true,
      'send-encrypted': true,
      read: true,
      'read-content': true,
      onramp: true,
      publish: true,
      'name-vault': true,
      'set-profile': true,
      'set-perks': true,
      'declare-agent': true,
      'declare-operator': true,
      upload: true,
      remember: true,
    };
    expect([...new Set(CASES.map(([, action]) => action.kind))].sort()).toEqual(
      Object.keys(covered).sort(),
    );
    expect(Object.keys(covered)).toHaveLength(15);
  });

  it('would notice a single changed byte', () => {
    // A comparison that passes against anything looks identical to one that works. One space
    // removed from one field must fail, or none of the above means what it says.
    const real = statementFor({ kind: 'read', other: 'x' }, ADDRESS, AT, ORIGIN);
    expect(real.replace('thread with: ', 'thread with:')).not.toBe(real);
    expect(GOLDEN['read']).not.toBe(
      statementFor({ kind: 'read', other: `0x${'cd'.repeat(32)}` }, ADDRESS, AT + 1, ORIGIN),
    );
  });
});

describe('isSingleUse', () => {
  it('spends every kind, with no exemption', () => {
    /*
      `read` was the one exemption and it is gone. The argument for it was that spending a read
      means a wallet prompt per refresh — true, and reasoned entirely from the SIGNER: replaying a
      read grants an INTERCEPTOR that address's inbox for the full window. The prompt cost was also
      not being paid, since every client signs a fresh read per call and caches none.
    */
    for (const [, action] of CASES) {
      expect([action.kind, isSingleUse(action)]).toEqual([action.kind, true]);
    }
  });
});

describe('SIGNATURE_WINDOW_MS', () => {
  it('is ten minutes', () => {
    // Pinned because `verifyAction` compares an age against it and `used_signatures` rows expire on
    // it. A wider window is a longer replay opportunity; a narrower one fails honest slow signers.
    expect(SIGNATURE_WINDOW_MS).toBe(600_000);
  });
});

describe('STATEMENT_SHAPES', () => {
  it('names lines that really appear in the statement it describes', () => {
    /*
      It is derived from `statementFor` now, so this cannot catch a drift — there is nothing left to
      drift from. What it catches is the derivation itself going wrong: a slice offset that eats the
      first action line, or a variant merge that loses one.
    */
    for (const [, action] of CASES) {
      const lines = statementFor(action, ADDRESS, AT, ORIGIN).split('\n').slice(HEAD_LINES);
      const shape = STATEMENT_SHAPES[action.kind];
      for (const line of lines) {
        expect(shape.some((s) => line === s || line.startsWith(s))).toBe(true);
      }
    }
  });

  it('publishes both rendered forms of every branching line', () => {
    // `follow`/`unfollow` and `yes`/`no` are branches, not interpolations. An agent handed one form
    // and told it was the only one would sign the other and be refused as a forgery.
    expect(STATEMENT_SHAPES.follow).toEqual(['action: follow', 'action: unfollow', 'creator: ']);
    expect(STATEMENT_SHAPES['set-perks']).toEqual([
      'action: set perks',
      'handle: ',
      'perks-sha256: ',
      'supporters-first: yes',
      'supporters-first: no',
    ]);
  });

  it('describes every kind', () => {
    expect(Object.keys(STATEMENT_SHAPES)).toHaveLength(15);
  });
});

describe('the module stays importable by a browser and by a stranger', () => {
  it('imports nothing at all', () => {
    /*
      This package is Apache-licensed, published, and pulled into a browser bundle and into headless
      agents. The moment this file imports `server-only`, `pg`, `node:crypto` or Next, it stops
      being importable by one of them — and the failure appears in somebody else's build, not ours.

      Asserted against the source text rather than by trying an import, because a dependency that
      happens to resolve in Node is exactly the one that breaks in a bundler.
    */
    const source = readFileSync(join(import.meta.dirname, '../src/statements.ts'), 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});

describe('accessStatement — the tier rides on the access line', () => {
  it('leaves tier 0 and non-subscriber posts exactly as they were signed before', () => {
    expect(accessStatement('subscribers', 0)).toBe('subscribers');
    expect(accessStatement('subscribers')).toBe('subscribers');
    expect(accessStatement('public', 3)).toBe('public');
    expect(accessStatement('paid', 3)).toBe('paid');
  });
  it('binds a non-zero tier, and parses it back', () => {
    expect(accessStatement('subscribers', 2)).toBe('subscribers:2');
    expect(parseAccessStatement('subscribers:2')).toEqual({ access: 'subscribers', tier: 2 });
    expect(parseAccessStatement('subscribers')).toEqual({ access: 'subscribers', tier: 0 });
    expect(parseAccessStatement('subscribers:0')).toBeNull();
    expect(parseAccessStatement('subscribers:x')).toBeNull();
  });
  it('refuses a tier that is not a whole number', () => {
    expect(() => accessStatement('subscribers', 1.5)).toThrow(RangeError);
    expect(() => accessStatement('subscribers', -1)).toThrow(RangeError);
  });
});
