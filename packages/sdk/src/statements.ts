// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The exact bytes a signature authorises.
 *
 * # One implementation, because a second one is the defect
 *
 * This text used to exist twice: `packages/web/lib/identity.ts` built it for the server, and
 * `packages/agent/src/statements.ts` built it again for headless agents. The two were kept in
 * agreement by a test that diffed them. That test could only ever report a divergence *after* it
 * was written — and it did exactly that: `declare-agent` and `declare-operator` were added to the
 * server copy and not the agent's, and the copies were out of step until somebody ran the suite.
 * A drift test is a smoke alarm; the point of this file is that there is nothing left to burn.
 *
 * Both former copies now re-export this module. Nothing else in the repository may re-implement
 * `statementFor`, and the two remaining hand-written copies — the browser components, which cannot
 * import a server module and are not going to import a wallet-facing SDK into every button — stay
 * pinned by `packages/web/test/statement-drift.test.ts`.
 *
 * # Why the drift matters more than duplication usually does
 *
 * The server never receives the statement. It rebuilds it from the request and verifies the
 * signature against *its* version — deliberately, so a client cannot sign one thing and submit
 * another. The consequence is that a client formatting one character differently produces a
 * signature that verifies against nothing, and the error the user is handed is `the signature does
 * not prove control of 0x…`. That reads as a wallet problem and is not one. **A single space, a
 * single newline, or an em dash where a hyphen belongs is a total failure with a misleading
 * message.** Do not "improve" the formatting below: not the `\n` separators, not the spacing after
 * each colon, not the field order, and not the head.
 *
 * # What is in here, and what is deliberately not
 *
 * This module is **pure**. It has no imports at all, and that is a constraint rather than an
 * accident: this package is Apache-licensed, published, and imported by a browser bundle and by a
 * headless agent alike. It must not acquire Next.js, `server-only`, `pg`, or `node:crypto`.
 *
 * `verifyAction` therefore did **not** move. It reads `siteConfig()`, opens a Postgres connection
 * and spends a row in `used_signatures`; it stays in `packages/web/lib/identity.ts` where the
 * replay ledger lives. Formatting a statement and deciding whether one has already been spent are
 * different jobs, and only the first of them belongs to everyone.
 *
 * `signAction`, `publishContentSha256` and `paidStatementFor` did not move either. They need a
 * keypair and a SHA-256 implementation, and they mirror route logic rather than this file; they
 * stay in `packages/agent/src/statements.ts`.
 */

/**
 * How long a signed statement stays valid. Long enough to type, short enough to matter.
 *
 * Ten minutes. An agent should sign immediately before sending and never hold a statement, which
 * is easy advice for a process with no user to wait for — but the window matters in the other
 * direction too: `verifyAction` refuses a statement dated more than sixty seconds in the future,
 * so an agent on a host with a drifting clock fails every write with a signature error. If writes
 * start failing across the board, check NTP before checking the key.
 */
export const SIGNATURE_WINDOW_MS = 10 * 60 * 1000;

/**
 * Every action a signature can authorise.
 *
 * Each member's doc block says what the binding closes — the replay it makes impossible. Read them
 * before adding a field, because an unbound field is a field an attacker chooses.
 */
export type Action =
  | { kind: 'comment'; postId: string; text: string }
  | { kind: 'follow'; handle: string; following: boolean }
  /**
   * Sending a message.
   *
   * `preview` is bound because it is the only thing a recipient sees before deciding to pay, and
   * `paid` because it is what they would be paying. Neither was: the statement named the recipient
   * and the body text alone, so a captured `send` could be replayed with a paywall and a preview of
   * the attacker's choosing attached to words the sender had signed as free.
   *
   * `paid` is one readable field rather than three, so the wallet prompt stays short enough to be
   * read — `handle:key:price`, or empty when the message is not for sale.
   */
  | { kind: 'send'; to: string; text: string; preview: string; paid: string }
  /**
   * Sending an encrypted message.
   *
   * A separate action from `send` because the server cannot rebuild the `send` statement: it never
   * sees the plaintext. Binding to the SHA-256 of the ciphertext instead keeps the signature tied
   * to one exact payload — a captured signature cannot be attached to different ciphertext — while
   * keeping the text the wallet displays short enough for a human to actually read. Signing five
   * kilobytes of base64 is a prompt nobody inspects, which is the same as no prompt.
   */
  | { kind: 'send-encrypted'; to: string; ciphertextSha256: string }
  /**
   * Reading a thread is signed too, and that is not belt-and-braces.
   *
   * For a post, naming an address grants nothing — entitlement comes from objects that address
   * owns on chain, which cannot be forged by claiming to be someone. A direct message has no such
   * backstop: the store decides, so an unsigned `?reader=` would let anyone read anyone's
   * messages by typing their address. Reading therefore has to be proved.
   */
  | { kind: 'read'; other: string }
  /**
   * Beginning a read session.
   *
   * The one action that authorises nothing on its own. It says "I control this address" and buys a
   * cookie that says so for a day — which is what `?reader=` pretended to be and never was.
   *
   * # Why it carries no fields
   *
   * Nothing to bind. There is no target, no amount and no text: the statement's entire content is
   * the address and the timestamp already in `head`. Binding a page or a post would be worse, not
   * better — it would mean one session per post, and therefore a wallet prompt per post.
   *
   * That prompt-fatigue argument used to end "which is the prompt fatigue `isSingleUse` refuses for
   * reads". It no longer does: `isSingleUse` returns true for every kind, because the exemption it
   * described was reasoned from the signer's side alone. The argument is still sound HERE — one
   * session per post really would mean a prompt per post — and it is no longer a description of
   * what `isSingleUse` does.
   *
   * # What it can and cannot do if stolen
   *
   * The session it mints reads what the address already owns on chain, and nothing else. It cannot
   * publish, spend, unlock, follow or send, because every one of those spends a separate signature
   * naming its own action. That containment is why a bearer token is acceptable here and would not
   * be anywhere else in this union.
   */
  | { kind: 'read-content' }
  /**
   * Publishing a post.
   *
   * This was the one write that named an address and never proved it. The route compared the
   * `author` field in the request body against the vault's owner read from chain — but a vault's
   * owner is public, so anyone could read it, put it in the body, and publish as that creator. A
   * check against a value the caller supplies is not a check.
   *
   * Bound to the content by hash rather than by text, for the reason `send-encrypted` gives: a
   * post body is long, and a wallet prompt showing kilobytes is a prompt nobody reads. `access` is
   * bound too — without it a signature for a paid post could be replayed to publish the same words
   * for free, or the reverse.
   */
  | {
      kind: 'publish';
      handle: string;
      title: string;
      access: string;
      contentSha256: string;
      /**
       * What this post is sold as. Empty strings when it is not sold at all.
       *
       * `access` alone was bound, which stops a paid post being replayed as free — and stops
       * nothing about *what* is being charged. A captured publish could be replayed with an
       * attacker's own content key and price, creating a post under the victim's handle whose
       * paywall points wherever the attacker chose. The signature authorised the words and the
       * access level; it did not authorise the thing readers must buy.
       */
      contentKey: string;
      price: string;
    }
  /**
   * Naming a creator vault, and describing it.
   *
   * Same defect as publishing had: the route compared `owner` from the request body against the
   * vault's owner read from chain, and a vault's owner is public. Anyone could rename anyone's
   * vault. The name and description are bound because they are the whole payload — a signature
   * that authorised only "some change to this vault" would authorise every future one.
   *
   * `coinType` is bound for a sharper reason than completeness. It is not cosmetic: `checkout/tip`
   * and `checkout/unlock` read it back off the profile and use it as the **generic type argument**
   * for `tip<T>` and `unlock<T>`. Replaying a captured rename with a different coin silently
   * repoints every payment quote for that vault at the wrong instantiation, and they then abort on
   * chain — a signature that said "rename this vault" being spent to break its payments.
   */
  | { kind: 'name-vault'; vaultId: string; name: string; bio: string; coinType: string }
  /**
   * Setting the display name on an account.
   *
   * The route asked the chain "does this address hold this handle", which is a real question with
   * a definite answer — and no answer at all to "is the caller this address". Both are needed.
   */
  | { kind: 'set-profile'; handle: string; name: string }
  /**
   * Setting the perks a creator promises the people who tip them.
   *
   * The whole payload is bound, by digest rather than by text. A perk list is up to six titles and
   * six paragraphs, and a wallet prompt showing all of it is a prompt nobody reads — the same
   * reasoning `publish` and `send-encrypted` give for hashing their bodies.
   *
   * Binding it matters more here than the size suggests. These are promises made in a creator's
   * name, published on their page. A signature that authorised only "change my perks" would
   * authorise every later change too, so a captured one could be replayed to publish an offer the
   * creator never made — and the reader has no contract to check it against, because this is the
   * one thing on the site no contract enforces.
   *
   * `supportersFirst` is bound for the same reason: it is a public statement about how a person
   * answers their messages, and nobody else may make it on their behalf.
   */
  | { kind: 'set-perks'; handle: string; perksSha256: string; supportersFirst: boolean }
  /**
   * Declaring that an address is a machine — the half signed by the machine.
   *
   * # Two signatures, and neither party can do this alone
   *
   * This action is one half of a pair. The agent signs `declare-agent`, naming the operator; the
   * operator signs `declare-operator`, naming the agent. `POST /api/agents/declare` verifies both
   * independently, against two different addresses, and refuses a declaration carrying one.
   *
   * That is not belt-and-braces, it is the whole mechanism. A register where one party writes the
   * entry records what people said about each other: a human could declare a competitor's address
   * to be a bot, or declare their own bot to be a human, and nothing could contradict either. With
   * both halves required, the record is self-certifying — a reader rebuilds these bytes from the
   * stored row and checks them against two public keys, trusting this deployment for nothing.
   *
   * `.sign()` on an agent can only ever produce this half. The other is signed by a human's key,
   * which the agent package does not hold and must never be given.
   *
   * # What is bound, and the attack each binding closes
   *
   * `operator` is in the statement because otherwise the operator address would be the one field a
   * captured signature could be re-pointed at. The agent would have signed "I am operated by
   * someone", and whoever carried that signature to the route would choose by whom — which is the
   * declaration with its only load-bearing field removed.
   *
   * The agent's own address needs no field of its own: it is already in the shared head, and
   * `verifyAction` asserts the recovered key belongs to it. Both addresses are therefore inside the
   * signed bytes, which is what the pairing requires.
   *
   * `model` and `purpose` are bound because they are the entire public content of the register.
   * Unbound, two honest signatures could be filed against a description neither party agreed to —
   * an agent truthfully declared, described as something it is not. They are bound as plain text
   * rather than by digest, unlike `publish` and `set-perks`: both are short by construction, and a
   * wallet prompt that shows a hash where it could have shown the words is a prompt that tells the
   * signer nothing about what they are signing.
   */
  | { kind: 'declare-agent'; operator: string; model: string; purpose: string }
  /**
   * The other half: the operator signing that they answer for this machine.
   *
   * A separate action, not the same statement signed twice, and the separation is deliberate. The
   * verb differs and the head's address differs, so an operator's signature cannot be filed as the
   * agent's half, or the reverse. Without that, one keypair could produce two verifying signatures
   * and the pair would be one assertion counted twice.
   *
   * The route refuses `agent === operator` for the same reason, and `db/023_agent_accounts.sql`
   * refuses it again as a CHECK constraint, because a constraint outlives the route that fed it.
   *
   * This is the half that carries the accountability. The agent's signature says what a program is;
   * this one says who is answerable for it, and it is the one that costs somebody something to
   * give.
   */
  | { kind: 'declare-operator'; agent: string; model: string; purpose: string }
  /**
   * Attaching media to a post.
   *
   * Bound to the bytes by hash, so a signature cannot be reused to attach a different file to the
   * same post. Nothing in the interface calls this route today, which makes it surface with no
   * purpose — a signature requirement is the cheapest way to close it without deleting a feature
   * somebody may be about to build.
   */
  | { kind: 'upload'; postId: string; fileSha256: string }
  /**
   * Funding a wallet through the card on-ramp.
   *
   * The signer is the wallet that will receive the funds. That is the whole content of the claim:
   * this proves the caller controls the address they are asking us to deliver to, which is what
   * separates a visitor buying their own coins from somebody minting payment sessions against a
   * stranger's address on our merchant account.
   *
   * It deliberately does NOT require an account, a session or a redeemed pass. Anyone holding a
   * Sui address can sign this, including a person who has never used this site and holds nothing —
   * which is exactly the visitor this door exists for, and re-closing the door to them would be
   * the wrong trade.
   *
   * # `network` and `origin`, and why they are here and not in the head
   *
   * Every other statement in this file binds neither, so bytes signed against a staging, testnet,
   * local or forked deployment verify identically against production, and a page that is not ours
   * can present text a wallet renders as ours. Both are bound here so this statement cannot be
   * harvested somewhere else and spent here.
   *
   * They sit in the body rather than the shared head because moving them into the head rotates
   * every statement at once and invalidates signatures in flight. This is the shape the rest
   * should take when they are rotated deliberately; it is not a reason to leave them unbound now.
   */
  | { kind: 'onramp'; walletAddress: string; network: string }
  /**
   * Storing the agent's mind: one encrypted blob, fronted by the platform's WAL.
   *
   * Bound to the CIPHERTEXT by hash and by length, both computed by the server from the bytes it
   * received — a signature over `sha256` cannot be reused to store different bytes under the same
   * label, and `bytes` (a decimal string, as every amount on the wire is) is what the platform
   * pays for. `label` names the mind (an agent may keep
   * more than one); the server keeps every version and hands back the newest.
   *
   * The plaintext is never seen here. The agent encrypts to its own registered X25519 key before
   * signing this, so what the statement binds is what Walrus stores: bytes nobody but the agent
   * can open.
   */
  | { kind: 'remember'; label: string; sha256: string; bytes: string };

/**
 * The exact bytes a client must sign.
 *
 * Rebuilt on the server from the request, never taken from it. The text is included for a comment
 * so a signature authorises *that* comment — otherwise one signature would authorise an unlimited
 * number of them.
 */
export function statementFor(
  action: Action,
  address: string,
  timestampMs: number,
  origin: string,
): string {
  /*
    `origin` binds the statement to the deployment that asked for it.

    Without it these bytes are portable. Every field above describes the ACTION and none describes
    WHERE it was requested, so a signature collected by any other instance of this software — a
    staging deployment, a preview URL, a local run, a fork — verifies identically against
    production. `used_signatures` does not close that: the ledger is per-database, so a signature
    spent elsewhere is unspent here. For `read-content` the prize is a day-long session for an
    address the collector does not control.

    WHAT THIS DOES NOT FIX, stated because the opposite is easy to assume: it is not a defence
    against phishing. A hostile page writes this line itself, and a wallet signs the text it is
    given. Binding the origin gives a careful reader something to compare against the site they are
    actually on, and gives a wallet that displays the requesting origin something to contradict. It
    is a mechanical fix for cross-deployment replay and a human aid against phishing, and those are
    different strengths.

    The network is deliberately NOT bound. It would have to reach the browser, and this application
    ships no client configuration at all — a decision `app/api/seal`, `app/api/deployment` and
    `app/api/zklogin/session` each record, each saying a `NEXT_PUBLIC_` variable would quietly
    reverse it. Origin is the stronger discriminator anyway: two deployments on the same network
    still differ by origin, while two origins on different networks differ by both.
  */
  const head = `Weir\naddress: ${address}\nissued: ${timestampMs}\norigin: ${origin}`;
  switch (action.kind) {
    case 'comment':
      return `${head}\naction: comment\npost: ${action.postId}\ntext: ${action.text}`;
    case 'follow':
      return `${head}\naction: ${action.following ? 'follow' : 'unfollow'}\ncreator: ${action.handle}`;
    case 'send':
      return `${head}\naction: send\nto: ${action.to}\ntext: ${action.text}\npreview: ${action.preview}\npaid: ${action.paid}`;
    case 'send-encrypted':
      return `${head}\naction: send encrypted\nto: ${action.to}\nciphertext-sha256: ${action.ciphertextSha256}`;
    case 'read':
      return `${head}\naction: read\nthread with: ${action.other}`;
    case 'read-content':
      return `${head}\naction: read content`;
    // Nothing may sit between `case` and `return` here: two tests read these cases out of this
    // source with a regex that expects them adjacent, and a comment in the gap makes the case
    // invisible to it — the statement then goes unpinned, which is the one thing this must not be.
    case 'publish':
      return `${head}\naction: publish\ncreator: ${action.handle}\naccess: ${action.access}\ntitle: ${action.title}\ncontent-sha256: ${action.contentSha256}\nkey: ${action.contentKey}\nprice: ${action.price}`;
    case 'name-vault':
      return `${head}\naction: name vault\nvault: ${action.vaultId}\nname: ${action.name}\nbio: ${action.bio}\ncoin: ${action.coinType}`;
    case 'set-profile':
      return `${head}\naction: set profile\nhandle: ${action.handle}\nname: ${action.name}`;
    case 'set-perks':
      return `${head}\naction: set perks\nhandle: ${action.handle}\nperks-sha256: ${action.perksSha256}\nsupporters-first: ${action.supportersFirst ? 'yes' : 'no'}`;
    case 'declare-agent':
      return `${head}\naction: declare agent\noperated by: ${action.operator}\nmodel: ${action.model}\npurpose: ${action.purpose}`;
    case 'declare-operator':
      return `${head}\naction: declare operator\noperating: ${action.agent}\nmodel: ${action.model}\npurpose: ${action.purpose}`;
    case 'upload':
      return `${head}\naction: upload\npost: ${action.postId}\nfile-sha256: ${action.fileSha256}`;
    case 'onramp':
      return `${head}\naction: fund wallet\nwallet: ${action.walletAddress}\nnetwork: ${action.network}`;
    case 'remember':
      return `${head}\naction: remember\nlabel: ${action.label}\nciphertext-sha256: ${action.sha256}\nbytes: ${action.bytes}`;
  }
}

/**
 * Does spending this action consume its signature?
 *
 * Everything that changes state does. A signature authorises one post, one message, one follow —
 * not an unlimited number of them for the next ten minutes, which is what freshness alone allowed.
 *
 * `read` is spent too, since the reversal recorded inside the function below — the manifest
 * points agents at this doc, and until 2026-09-02 it still described the older rule, under which
 * a read could be replayed within its window while the server refused the replay. Every kind is
 * single-use; a client that wants to read on a timer takes a `read-content` session once a day
 * rather than re-signing. (`read-content` mints that session cookie: replaying it would hand a
 * second session to whoever captured the statement, which is why it was always spent.)
 *
 * # Exported, but the decision is still not yours
 *
 * This was private to `lib/identity.ts` while the formatter lived there. It is exported now because
 * the formatter moved into a package, and a rule that cannot be read cannot be published — the
 * agent manifest tells machine clients which statements are re-usable, and a manifest that guesses
 * would tell an agent it may batch writes on one prompt. **Publishing the fact is a different act
 * from sharing the decision.** Only `verifyAction` may call this to decide whether a row is spent;
 * everything else may only report what it says.
 */
/**
 * The `access` value a publish statement binds, with the subscriber tier folded in.
 *
 * A subscriber post is sealed to a tier (`seal_approve_subscription` grants `subscription.tier >=
 * tier`), and the tier decides who can read — so it must be inside the signature, or a relay could
 * lower it to zero and open a premium post to the cheapest seat. Rather than a new statement line
 * (which every signer, verifier and drift test would have to move to at once), the tier rides on
 * the `access` line: `subscribers` for tier 0, exactly as before, `subscribers:2` for tier 2. A
 * public or paid post never carries one. Both sides — the browser, the agent, the route — build
 * the value here, which is the only reason it can be trusted to match.
 */
export function accessStatement(access: 'public' | 'paid' | 'subscribers', tier?: number): string {
  if (access !== 'subscribers' || tier === undefined || tier === 0) return access;
  if (!Number.isInteger(tier) || tier < 0) throw new RangeError(`a tier must be a non-negative integer; received ${String(tier)}`);
  return `subscribers:${tier}`;
}

/** The inverse of {@link accessStatement}: what a route receives on the wire, split back. */
export function parseAccessStatement(value: string): { access: 'public' | 'paid' | 'subscribers'; tier: number } | null {
  if (value === 'public' || value === 'paid') return { access: value, tier: 0 };
  if (value === 'subscribers') return { access: value, tier: 0 };
  const m = /^subscribers:([1-9]\d{0,3})$/.exec(value);
  return m === null ? null : { access: 'subscribers', tier: Number(m[1]) };
}

export function isSingleUse(action: Action): boolean {
  /*
    Every kind, including `read`.

    `read` was exempt, and the argument for the exemption was good: spending it would demand a
    wallet prompt per refresh, and training people to approve prompts without reading them is worse
    than the replay it prevents. The note in `db/011_signature_replay.sql` finishes with "replaying
    a read grants exactly the access the signer already had".

    That sentence is true of the SIGNER and false of an INTERCEPTOR, and the exemption was reasoned
    entirely from one of the two parties. The same bytes in somebody else's hands return that
    address's inbox — the thread list, the message bodies, the notification feed — for the whole ten
    minutes the statement stays fresh. It grants the attacker what the signer had, not the signer
    what they already held.

    THE COST IT AVOIDS WAS NOT BEING PAID. `Notifications.load()` and both read paths in
    `Messages.tsx` call `sign()` on every invocation and cache nothing, and `load()` is bound to an
    explicit button rather than a timer. No client in this repository has ever reused a read
    signature, so spending them costs exactly zero additional prompts. The exemption was protecting
    a price nobody was being charged.

    What it does cost: a retried POST — a flaky network, a double click — now fails the second time
    with a signature error rather than silently succeeding twice. That is the same behaviour every
    write on this site already has.
  */
  void action;
  return true;
}

/**
 * Lines in the shared head — `Weir`, `address:`, `issued:`, `origin:` — before the action begins.
 *
 * Exported because a test was slicing the head off with a hand-written `3`, which is this number
 * copied. When the head grew by a line that copy became silently wrong: it left `origin:` in the
 * action lines and the assertion failed on a statement that was correct. One number, one place.
 */
export const HEAD_LINES = 4;

/**
 * One rendering of every action kind, with every interpolated field emptied.
 *
 * The input to {@link STATEMENT_SHAPES}, and the only hand-maintained thing left in this file. It
 * is safe to hand-maintain for a reason the old duplicated table was not: it is a `Record` over
 * `Action['kind']`, so a kind added to the union and forgotten here fails `tsc` rather than
 * quietly going undescribed. The *text* is never written out — it comes from `statementFor`.
 *
 * Two kinds print a **word** where every other prints a slot, so both branches are listed. An agent
 * handed one form and told it was the only one would sign `following: true` and be refused as a
 * forgery.
 */
const SHAPE_SAMPLES: Readonly<Record<Action['kind'], readonly Action[]>> = {
  comment: [{ kind: 'comment', postId: '', text: '' }],
  follow: [
    { kind: 'follow', handle: '', following: true },
    { kind: 'follow', handle: '', following: false },
  ],
  send: [{ kind: 'send', to: '', text: '', preview: '', paid: '' }],
  'send-encrypted': [{ kind: 'send-encrypted', to: '', ciphertextSha256: '' }],
  read: [{ kind: 'read', other: '' }],
  'read-content': [{ kind: 'read-content' }],
  publish: [
    { kind: 'publish', handle: '', title: '', access: '', contentSha256: '', contentKey: '', price: '' },
  ],
  'name-vault': [{ kind: 'name-vault', vaultId: '', name: '', bio: '', coinType: '' }],
  'set-profile': [{ kind: 'set-profile', handle: '', name: '' }],
  'set-perks': [
    { kind: 'set-perks', handle: '', perksSha256: '', supportersFirst: true },
    { kind: 'set-perks', handle: '', perksSha256: '', supportersFirst: false },
  ],
  'declare-agent': [{ kind: 'declare-agent', operator: '', model: '', purpose: '' }],
  'declare-operator': [{ kind: 'declare-operator', agent: '', model: '', purpose: '' }],
  upload: [{ kind: 'upload', postId: '', fileSha256: '' }],
  onramp: [{ kind: 'onramp', walletAddress: '', network: '' }],
  remember: [{ kind: 'remember', label: '', sha256: '', bytes: '' }],
};

/**
 * The lines one kind emits, in source order, gathered across its branches.
 *
 * Line by line rather than variant by variant, so `follow` reads `['action: follow',
 * 'action: unfollow', 'creator: ']` — both verbs where they occur, not one whole statement after
 * the other. That ordering is the only reason this is worth reading.
 */
function shapeOf(variants: readonly Action[]): readonly string[] {
  const rendered = variants.map((action) => statementFor(action, '', 0, '').split('\n').slice(HEAD_LINES));
  const width = Math.max(...rendered.map((lines) => lines.length));
  const out: string[] = [];
  for (let i = 0; i < width; i += 1) {
    for (const lines of rendered) {
      const line = lines[i];
      if (line !== undefined && !out.includes(line)) out.push(line);
    }
  }
  return out;
}

/**
 * Every action kind, and the literal lines its statement emits, in order.
 *
 * A description for agent authors: what an implementer should expect to see in the prompt their
 * wallet shows, without reading a switch statement. Fixed text appears whole (`action: comment`);
 * a field that carries a value appears as its prefix and a trailing space (`post: `).
 *
 * # It is derived now, and that is the point of this file
 *
 * It used to be written out by hand, on the stated grounds that "a check that derives its
 * expectation from the code it is checking asserts nothing" — which was correct while it was one
 * half of a drift test between two implementations. There is one implementation now. A hand-copy
 * of its output would be a fourth place for the format to live and the only place it could be
 * wrong, so it is computed from `statementFor` and cannot disagree with what an agent signs.
 *
 * **Changed by that derivation:** `set-perks` now lists `supporters-first: yes` and
 * `supporters-first: no` where the hand table listed the prefix `supporters-first: `. The hand
 * table was inconsistent with its own rule — it named both of `follow`'s rendered verbs and then
 * hid `set-perks`' rendered words behind a slot. Nothing asserted the old value; nothing reads this
 * at runtime.
 */
export const STATEMENT_SHAPES: Readonly<Record<Action['kind'], readonly string[]>> = Object.freeze(
  Object.fromEntries(
    Object.entries(SHAPE_SAMPLES).map(([kind, variants]) => [kind, shapeOf(variants)]),
  ) as Record<Action['kind'], readonly string[]>,
);
