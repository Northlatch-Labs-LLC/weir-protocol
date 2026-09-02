#!/usr/bin/env python3
"""Refuse a commit that would publish a credential.

Run standalone, or as `.git/hooks/pre-commit` via `core.hooksPath`. Exits non-zero if anything
is found.

    python3 scripts/scan-secrets.py              what is staged right now (the pre-commit gate)
    python3 scripts/scan-secrets.py --all        every tracked file (the pre-push / audit gate)
    python3 scripts/scan-secrets.py --paths a b  named files, for a mutation test
    python3 scripts/scan-secrets.py --selftest   prove both directions of every validated rule

**Never prints a secret.** A finding is identified by a truncated SHA-256, so two findings can be
told apart and matched against a source without the value reaching a terminal, a log, a CI
transcript or a screen recording. There is no `--show` flag and there must never be one: a masking
regex that assumed a format has already leaked a token on this estate, and a prefix of a private
key is still a prefix of a private key (`packages/daemon/src/config.ts` says the same thing about
`assertSignerConfigured`, for the same reason).

Three independent checks, because no one of them is sufficient:

  1. Path     — a file whose NAME says it holds key material must never be staged at all.
  2. Shape    — regexes for credentials that look like credentials wherever they appear, each
                followed by whatever the format lets us VERIFY rather than merely match.
  3. Identity — exact containment of values read from this checkout's live `.env` and key files.
                This is the one that matters: it catches a real key pasted into a comment, a
                README, or a test.

# Validate where the format validates, and say so where it does not

A shape rule answers "does this look like a key?". Several of these formats answer the real
question — "is this a key?" — on their own, because they carry an integrity property. Where one
does, this file checks it and reports only on success. Where one does not, the rule stays a shape
match and its comment says so plainly, so a reader never assumes a check that was not made.

That distinction was paid for. `packages/daemon/test/config.test.ts` holds a fixture that is a
`suiprivkey1` prefix followed by filler: 72 characters where a real Sui key is 70, and a checksum
that does not verify. The first version of this scanner reported it, which would have refused every
push in the repository over a value that is not a credential — and a guard that fires on a
known-good fixture is `--no-verify`d within a day, taking the real checks with it. An allowlist
entry would have silenced that one string and left the next fixture to fire. A checksum answers it
for every value, for ever, and without a human ever looking at one.

**Validation only ever RESTRICTS a rule to what the format guarantees.** No rule is tightened on an
assumption — a narrowed alphabet or a length from a blog post — because the cost of being wrong
there is a real credential that stops being caught, which is the failure direction that matters.

# Precision is the whole point

A scanner that cries wolf gets `--no-verify` and then it protects nothing. Every rule below is
either anchored to a credential-specific prefix, or anchored to a variable NAME that marks the
value secret. There is deliberately NO general entropy rule and no "64 hex characters" rule: in
this repository a 64-character hex string is overwhelmingly a Sui object id or a digest, both of
which are public on-chain facts that BELONG in source. `.env.example` is committed here precisely
because those ids are public.

Known non-findings, each checked against this tree before the rule was written:

  - `packages/daemon/test/config.test.ts` holds a `suiprivkey1`-prefixed test fixture. It is 72
    characters where a real key is 70 and its checksum does not verify, so it is not a finding —
    decided by arithmetic, not by an allowlist entry and not by anyone reading it.
  - `pnpm-lock.yaml` carries base64 integrity hashes, at least one of which begins `eyJ`. The JWT
    rule requires all three dot-separated segments, which a hash does not have, and then requires
    the first to decode to a JOSE header.
  - `.github/workflows/ci.yml` sets `PROJECTX_DATABASE_URL` to a Postgres URL with the password
    `ci` against `localhost`. A credential that only exists inside a job's own service container
    is not a transferable one, so URL rules skip local hosts.
  - `docker-compose.yml` writes `${POSTGRES_PASSWORD}`. An interpolated value is a reference, not
    a secret.
  - `.env.example`, `packages/daemon/.env.example` and `packages/sdk/.env.example` are COMMITTED
    BY DESIGN and CI copies the root one to `packages/web/.env.local`. They are exempt from the
    "no .env-shaped file may be staged" rule and subjected to a stricter one instead: every
    secret-named variable in them must be EMPTY.

# Suppressing a finding

Add `"<path>:<label>:<digest>": "<reason>"` to `scripts/secret-allowlist.json`. A suppression with
an empty reason is refused by this script — waiving the gate is a visible, reviewable act.

**A live credential is never allowlisted.** The remedy for a committed key is rotation at the
provider followed by removal; recording its digest here would turn the one gate that noticed into
the reason nobody notices again.
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

# ── the tree ────────────────────────────────────────────────────────────────────────────────────

def toplevel() -> Path:
    out = subprocess.run(['git', 'rev-parse', '--show-toplevel'],
                         capture_output=True, text=True)
    if out.returncode != 0:
        raise SystemExit('scan-secrets: not inside a git work tree. Refusing to run.')
    return Path(out.stdout.strip())


ROOT = toplevel()
ALLOWLIST = ROOT / 'scripts' / 'secret-allowlist.json'

# Never walked. `git ls-files` already excludes everything ignored, so none of these should appear
# — this is the belt to that set of braces, and it is what keeps the scan survivable in a pnpm
# workspace where an accidentally-tracked build directory would otherwise be tens of thousands of
# files and the hook would simply be turned off.
SKIP_DIRS = {'node_modules', '.next', '.next-verify', '.next-ci', 'build', 'dist', '.git',
             'coverage', '.pnpm-store', '.turbo'}

# Read far enough to find anything real, and stop. A lockfile is the largest text file here by an
# order of magnitude and sits comfortably inside this.
MAX_BYTES = 4 * 1024 * 1024

# ── 1. path rules ───────────────────────────────────────────────────────────────────────────────

# `.env` in any package of the workspace, not just at the root. This repository is a pnpm workspace
# with packages/{web,daemon,sdk}; a single-app path assumption would miss two of the three.
ENV_SHAPED = re.compile(r'(^|/)\.env($|\.)')

# The committed examples. They carry the live mainnet object ids — public data, and CI copies the
# root one into place so the web tests have a configured deployment to read.
ENV_EXEMPT = re.compile(r'(^|/)\.env\.(example|sample|template|defaults)$')

KEY_SHAPED = re.compile(
    r'(^|/)('
    r'[^/]*\.(key|pem|p12|pfx|jks|keystore|asc|gpg)'
    r'|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?'
    r'|signer\.json'
    r'|sui\.keystore'
    r'|secrets?\.env'
    r'|[^/]*test-wallet[^/]*\.json'
    r'|[^/]*(credentials|service[-_]account)[^/]*\.json'
    r')$',
    re.I,
)

# `.secrets/` is already gitignored and holds the throwaway subscribe-path address. A rule here too,
# because "already ignored" is a state a `git add -f` or a rewritten .gitignore can end.
SECRET_DIR = re.compile(r'(^|/)\.secrets(/|$)')

# ── 2a. validators — what each format can actually prove about itself ───────────────────────────

# Bech32's data part cannot contain 1, b, i or o, so this is the real alphabet rather than [a-z0-9].
# It is also what keeps the literal `suiprivkey1...` written in packages/daemon/.env.example from
# matching: dots are not bech32.
BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
BECH32 = '[' + BECH32_CHARSET + ']'


def _bech32_polymod(values: list) -> int:
    """BIP-173's checksum polynomial. Thirty lines of stdlib; no dependency, no network."""
    generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]
    chk = 1
    for value in values:
        top = chk >> 25
        chk = ((chk & 0x1ffffff) << 5) ^ value
        for i in range(5):
            if (top >> i) & 1:
                chk ^= generator[i]
    return chk


def _hrp_expand(hrp: str) -> list:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def bech32_verify(text: str) -> bool:
    """True only for a well-formed bech32 string whose checksum verifies.

    Six characters of checksum: a string that is not an encoding of anything passes with
    probability 2^-30. That is the difference between "looks like a key" and "is a key", and it
    is decided here without the value ever being displayed.
    """
    if not (8 <= len(text) <= 90):
        return False
    if text != text.lower():
        return False  # bech32 forbids mixed case; these are lowercase by construction
    sep = text.rfind('1')  # '1' is not in the data alphabet, so the last one is the separator
    if sep < 1 or sep + 7 > len(text):
        return False
    hrp, data = text[:sep], text[sep + 1:]
    if any(not (33 <= ord(c) <= 126) for c in hrp):
        return False
    try:
        values = [BECH32_CHARSET.index(c) for c in data]
    except ValueError:
        return False
    return _bech32_polymod(_hrp_expand(hrp) + values) == 1


def _convertbits(data: list, frombits: int, tobits: int) -> list | None:
    """5-bit groups back to bytes. None if the padding is not the canonical zero padding."""
    acc = bits = 0
    ret: list = []
    maxv = (1 << tobits) - 1
    max_acc = (1 << (frombits + tobits - 1)) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            return None
        acc = ((acc << frombits) | value) & max_acc
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            ret.append((acc >> bits) & maxv)
    if bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return ret


# 'suiprivkey' + '1' + 53 data characters + 6 checksum characters. The 53 carry 33 bytes: one
# signature-scheme flag and a 32-byte key.
SUI_PRIVKEY_LEN = 70
SUI_PRIVKEY_BYTES = 33


def is_sui_private_key(text: str, _blob: str = '') -> bool:
    """Checksum-verified, correct length, and a payload that decodes to exactly 33 bytes.

    The scheme flag byte is deliberately NOT constrained to the three schemes Sui defines today.
    A fourth would make every key of that type invisible to this scanner, and a missed credential
    is worse than an extra finding.

    Both the whole match and its first 70 characters are tried, so a key butted up against more
    alphabet characters — inside a longer token, or a URL — is still caught.
    """
    for candidate in (text[:SUI_PRIVKEY_LEN], text):
        if len(candidate) != SUI_PRIVKEY_LEN or not bech32_verify(candidate):
            continue
        data = [BECH32_CHARSET.index(c) for c in candidate[candidate.rfind('1') + 1:-6]]
        payload = _convertbits(data, 5, 8)
        if payload is not None and len(payload) == SUI_PRIVKEY_BYTES:
            return True
    return False


def is_jwt(text: str, _blob: str = '') -> bool:
    """The first segment must be base64url that decodes to a JSON object carrying `alg`.

    Real validation, not a shape: every JWT has a JOSE header and every JOSE header has `alg`.
    Three dot-separated base64-ish runs occur in ordinary data; a decodable header does not.
    """
    header = text.split('.')[0]
    try:
        raw = base64.urlsafe_b64decode(header + '=' * (-len(header) % 4))
        obj = json.loads(raw)
    except Exception:
        return False
    return isinstance(obj, dict) and 'alg' in obj


# The documented field set of a Google service-account key. `private_key` holds a PEM block, so a
# complete one is caught twice over — the PEM rule below is the backstop if this file is truncated
# or reshaped and the field set no longer matches.
SA_FIELDS = ('type', 'project_id', 'private_key_id', 'private_key', 'client_email')


def is_service_account_key(_text: str, blob: str = '') -> bool:
    """Structure, not a checksum: the whole documented field set must be present.

    Parsed as JSON when the file is JSON, so `"type": "service_account"` appearing in prose or in
    a schema fragment is not a finding. Falls back to requiring every field name when the object is
    embedded in something larger — a fixture, a heredoc, a Terraform variable.
    """
    try:
        obj = json.loads(blob)
        if isinstance(obj, dict):
            return obj.get('type') == 'service_account' and all(f in obj for f in SA_FIELDS)
    except Exception:
        pass
    return all('"%s"' % f in blob for f in SA_FIELDS)


def is_not_templated(text: str, _blob: str = '') -> bool:
    """`_authToken=${NPM_TOKEN}` is the correct way to write it, and must not be a finding."""
    value = text.split('=', 1)[1].strip() if '=' in text else text
    return not TEMPLATED.search(value)


# ── 2b. shape rules ─────────────────────────────────────────────────────────────────────────────
#
# (label, regex, validator). A validator of None means the format offers nothing to verify and the
# rule can only match a shape — stated per rule below rather than left for a reader to assume.
#
# No mnemonic rule. "Twelve consecutive lowercase words" is the shape of English prose, not of a
# seed phrase, and this project's signer is bech32-encoded (see packages/daemon/src/config.ts) and
# never a mnemonic.

SHAPES = [
    # VERIFIED. Checksum, length and payload size all decided in-process. This is the rule that
    # matters most here and it is also the only one weir's own fixtures can trip.
    ('bech32 Sui private key',
     re.compile(r'suiprivkey1' + BECH32 + r'{40,}'),
     is_sui_private_key),

    # SHAPE ONLY — a PEM header has no checksum, and the body may legitimately be encrypted,
    # truncated in a diff, or wrapped. No validation is attempted because every form of it that
    # could be parsed is still a private key, and the marker itself is a 27-character literal that
    # does not occur by accident. Precision is already ~1.
    ('PEM private key',
     re.compile(
         r'-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----'),
     None),

    # SHAPE ONLY. The account id is recoverable from an AWS key id, but AWS publishes no checksum
    # and no verifier, and the alphabet is not narrowed to base32 here on the strength of
    # reverse-engineering: a real key containing a character outside an assumed alphabet would stop
    # being caught, and that is the wrong way to be wrong.
    ('AWS access key id',
     re.compile(r'\b(?:AKIA|ASIA)[0-9A-Z]{16}\b'),
     None),

    # SHAPE ONLY, with the documented fixed length (39 characters: `AIza` plus 35) asserted by the
    # regex itself. Google publishes no checksum for these.
    ('Google API key',
     re.compile(r'\bAIza[0-9A-Za-z_-]{35}\b'),
     None),

    # SHAPE ONLY. The `GOCSPX-` prefix is documented; the total length is not consistently
    # published, so none is asserted rather than guessing one that would cause a miss.
    ('Google OAuth client secret',
     re.compile(r'\bGOCSPX-[0-9A-Za-z_-]{20,}\b'),
     None),

    # VALIDATED structurally. The daemon's VMs authenticate with the instance's own service account
    # and never a key file — see packages/daemon/deploy/provision-social-vm.sh — so a real one in
    # this tree is a mistake by construction.
    ('GCP service-account key file',
     re.compile(r'"type"\s*:\s*"service_account"'),
     is_service_account_key),

    # VALIDATED. All three segments must be present AND the header must decode to JSON with `alg`.
    # pnpm-lock.yaml carries a base64 integrity hash beginning `eyJ`; the segment requirement
    # already excludes it, and the header decode excludes the next one nobody has seen yet.
    ('JSON Web Token',
     re.compile(r'\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}'),
     is_jwt),

    # The finding is the ASSIGNMENT, not the token: registry tokens have no common format to check.
    # The one thing worth deciding is whether a value was written at all, since the correct form of
    # this line interpolates an environment variable.
    ('npm auth token',
     re.compile(r'_authToken\s*=\s*\S{8,}'),
     is_not_templated),

    # SHAPE ONLY, deliberately. GitHub's token format does carry a CRC32 checksum in its last six
    # characters, and it is NOT implemented here: verifying it requires an exact agreement about
    # the base62 encoding that cannot be confirmed without a real token to test against, and an
    # implementation that is subtly wrong silently stops catching real tokens. These have never
    # been a false-positive source in this repository, so the checksum would buy precision that is
    # already there at the price of the failure direction that matters.
    ('GitHub token',
     re.compile(r'\bgh[pousr]_[0-9A-Za-z]{30,}\b'),
     None),

    # SHAPE ONLY. Slack publishes no checksum.
    ('Slack token',
     re.compile(r'\bxox[abprs]-[0-9A-Za-z-]{10,}'),
     None),
]

# A URL that carries a password in its authority section, before the host. Written without a
# literal example on purpose: an example of this shape in a comment is itself a match, and the
# first thing a scanner must not do is refuse the commit that installs it.
URL_CRED = re.compile(r'\b[a-z][a-z0-9+.-]*://([^\s/:@]+):([^\s/@"\']+)@([^\s/:?#"\']+)')

# A host reachable only from inside the same machine, job or compose network.
LOCAL_HOSTS = {'localhost', '127.0.0.1', '::1', '0.0.0.0',
               'postgres', 'db', 'database', 'host.docker.internal'}

# ── 3. name-anchored rule: a secret-named variable holding a literal ────────────────────────────

# The names that actually carry credentials in this repository. Everything else in a .env here is
# public config — package ids, registry ids, grpc and aggregator URLs, a suggested validator — and
# comparing those produces noise that trains people to ignore the scanner.
SECRET_NAME = re.compile(
    r'PRIVATE_KEY$|PRIVKEY|PASSWORD|SECRET|SEED$|MNEMONIC|(^|_)KEY$|DATABASE_URL$|TOKEN$'
)

# Files where `NAME=value` or `NAME: value` means configuration. Deliberately not .ts/.json: in
# source the shape and identity rules do the work, and a `"password"` JSON key in a fixture is not
# a credential.
CONFIG_SHAPED = re.compile(
    r'(^|/)(\.env[^/]*|Dockerfile[^/]*|[^/]*\.(ya?ml|sh|toml|properties|ini|cfg))$'
)

ASSIGN = re.compile(r'^\s*(?:export\s+|-\s+)?([A-Z][A-Z0-9_]{2,})\s*[:=]\s*(.+?)\s*$')

# A value that is a reference, a template or a stand-in — never the thing itself.
TEMPLATED = re.compile(
    r'\$\{|\$\(|\$[A-Za-z_]|%[sdv]|<[^>]*>|\.\.\.|`|^"?\s*$'
    r'|(?i:\byour[-_ ]|\bchange[-_ ]?me\b|\bexample\b|\bplaceholder\b|\bredacted\b|\bxxx+\b)'
)

MIN_LITERAL = 12


def is_local_url(value: str) -> bool:
    m = URL_CRED.search(value)
    return bool(m) and m.group(3).split(':')[0].lower() in LOCAL_HOSTS


def carries_no_credential(value: str) -> bool:
    """True when a connection string demonstrably holds nothing worth protecting.

    The identity rule compares every tracked file against values read from a live .env, and it is
    the strongest of the three checks -- the only one that catches a real key pasted into a
    comment. It was also indiscriminate: any secret-NAMED variable became a comparison value
    whatever it held. `PROJECTX_DATABASE_URL` matches SECRET_NAME, so a passwordless local DSN
    entered the set, and the documented local setup command in db/README.md then read as a live
    secret leak. It blocked a real push.

    That is not a near miss, it is the failure mode this scanner cannot survive: a guard that
    fires on a value everybody knows is harmless gets --no-verify'd within a day, and the real
    checks leave with it. So the fix is here rather than in the README -- the README documents the
    correct command, and editing it would leave the classifier wrong for the next person who
    follows the setup.

    A DSN qualifies only when BOTH are true: no password component at all, and no network host.
    A Unix-socket connection string has neither. Anything with a password, or reaching a host over
    a network, is still compared -- the narrowing is deliberate and small.
    """
    if not re.match(r'^[a-z][a-z0-9+.-]*://', value):
        return False
    if URL_CRED.search(value):
        return False  # carries user:password@ -- a credential by construction
    authority = value.split('://', 1)[1].split('/')[0]
    if authority == '':
        return True   # postgresql:///db?host=/var/run/... -- a socket, no host, no password
    return authority.split(':')[0].lower() in LOCAL_HOSTS


# ── helpers ─────────────────────────────────────────────────────────────────────────────────────

def h(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8', 'ignore')).hexdigest()[:12]


def skipped(path: str) -> bool:
    return bool(SKIP_DIRS & set(Path(path).parts))


def git(*args: str) -> str:
    r = subprocess.run(['git', *args], capture_output=True, text=True,
                       errors='ignore', cwd=ROOT)
    return r.stdout if r.returncode == 0 else ''


def staged_paths() -> list[str]:
    out = git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
    return [p for p in out.split('\n') if p.strip() and not skipped(p)]


def tracked_paths() -> list[str]:
    out = git('ls-files')
    return [p for p in out.split('\n') if p.strip() and not skipped(p)]


def staged_blob(path: str) -> str:
    """The content git would commit, not what is on disk — they differ after a partial `git add`."""
    return git('show', ':' + path)[:MAX_BYTES]


def disk_blob(path: str) -> str:
    try:
        return (ROOT / path).read_text(encoding='utf-8', errors='ignore')[:MAX_BYTES]
    except OSError:
        return ''


# ── identity: what live credentials does this checkout actually hold? ───────────────────────────

# Workspace-wide, because a key can sit beside any package. Globs rather than a fixed list: a
# single-app path here would have covered one third of this repository.
LIVE_GLOBS = [
    '.env', '.env.local', '.env.*.local',
    'packages/*/.env', 'packages/*/.env.local', 'packages/*/.env.*.local',
    'sui-contracts/.env', 'sui-contracts/.env.local',
    '.secrets/*',
    'harvest.key', 'signer.json', '*.key', '*.pem',
    'packages/*/harvest.key', 'packages/*/signer.json', 'packages/*/*.key',
]

JSON_SECRET_VALUE = re.compile(r'"([A-Za-z_][A-Za-z0-9_]*)"\s*:\s*"([^"]{12,})"')


def live_secrets() -> dict[str, str]:
    """{value: 'FILE:WHERE'} — read for comparison only. Never staged, never printed."""
    found: dict[str, str] = {}
    seen: set[Path] = set()

    for pattern in LIVE_GLOBS:
        for p in sorted(ROOT.glob(pattern)):
            rel = str(p.relative_to(ROOT))
            if p in seen or not p.is_file() or skipped(rel) or ENV_EXEMPT.search(rel):
                continue
            seen.add(p)
            try:
                text = p.read_text(encoding='utf-8', errors='ignore')
            except OSError:
                continue

            # NAME=VALUE, secret-named only.
            for name, raw in re.findall(r'^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$', text, re.M):
                value = raw.strip().strip('"').strip("'")
                if len(value) >= MIN_LITERAL and SECRET_NAME.search(name):
                    # A value that holds no credential must not become something every tracked
                    # file is compared against. See carries_no_credential.
                    if carries_no_credential(value):
                        continue
                    found[value] = f'{rel}:{name}'

            # Raw key material, whatever the file is called. Checksum-verified here too: a
            # fixture sitting in a scratch key file must not become a value every source file in
            # the repository is then compared against.
            #
            # The NAME=VALUE pass above is the belt to this brace — a malformed or truncated key
            # written to PROJECTX_DAEMON_SIGNER_SECRET is still collected by name, because there
            # the variable, not the format, is what says it is a secret.
            for m in re.finditer(r'suiprivkey1' + BECH32 + r'{40,}', text):
                if is_sui_private_key(m.group(0)):
                    found[m.group(0)] = f'{rel}:bech32 key'

            # JSON key files: only fields whose NAME marks them secret. A 64-hex value on its own
            # is indistinguishable from an object id, and comparing those is what produced 74
            # findings and 0 secrets the last time this estate tried it.
            for name, value in JSON_SECRET_VALUE.findall(text):
                if SECRET_NAME.search(name.upper()):
                    found[value] = f'{rel}:{name}'

    return found


# ── the scan ────────────────────────────────────────────────────────────────────────────────────

def scan(path: str, blob: str, secrets: dict[str, str]) -> list[tuple[str, str, str]]:
    out: list[tuple[str, str, str]] = []

    if ENV_SHAPED.search(path) and not ENV_EXEMPT.search(path):
        out.append((path, 'env-shaped file staged', '-'))
    if KEY_SHAPED.search(path):
        out.append((path, 'key-shaped filename staged', '-'))
    if SECRET_DIR.search(path):
        out.append((path, 'file under .secrets/ staged', '-'))

    if not blob or '\x00' in blob[:8192]:
        return out  # binary: the path rules above are all that can honestly be said about it

    for label, rx, validate in SHAPES:
        for m in rx.finditer(blob):
            # A match is a candidate. Where the format can prove itself, it has to.
            if validate is not None and not validate(m.group(0), blob):
                continue
            out.append((path, label, h(m.group(0))))

    for m in URL_CRED.finditer(blob):
        password, host = m.group(2), m.group(3).split(':')[0].lower()
        if host in LOCAL_HOSTS or TEMPLATED.search(password) or len(password) < 6:
            continue
        out.append((path, 'credential inside a URL', h(password)))

    if CONFIG_SHAPED.search(path):
        for line in blob.splitlines():
            if line.lstrip().startswith('#'):
                continue
            m = ASSIGN.match(line)
            if not m:
                continue
            name, raw = m.group(1), m.group(2).strip()
            if not SECRET_NAME.search(name):
                continue
            value = raw.strip('"').strip("'")
            if len(value) < MIN_LITERAL or TEMPLATED.search(value) or is_local_url(value):
                continue
            label = f'{name} holds a literal value'
            if ENV_EXEMPT.search(path):
                # The committed examples must keep every secret entry blank. A filled-in one here
                # is the likeliest way a real key reaches this repository, because the file looks
                # safe: it is meant to be committed.
                label = f'{name} is not blank in a committed example'
            out.append((path, label, h(value)))

    for value, origin in secrets.items():
        if value in blob:
            out.append((path, f'LIVE SECRET from {origin}', h(value)))

    return out


# ── the self-test: prove both directions, on demand, for ever ───────────────────────────────────

def selftest() -> int:
    """Assert every validated rule still catches a true positive and still rejects a near-miss.

    This exists because a fix that only stops a false positive has disabled the scanner rather
    than corrected it, and nothing in the report would say so. Run it after any change to a rule.

    Every value used here is synthesised in this function. Nothing is read from the repository,
    nothing is hardcoded that could be mistaken for a credential, and the only output is a list of
    check names with PASS or FAIL — never a value.
    """
    def labels(text: str) -> set:
        return {label for _p, label, _d in scan('selftest.txt', text, {})}

    # A format-valid Sui key whose payload is 33 zero bytes: right hrp, right length, checksum
    # correct — and provably nobody's key, since the secret is zero. Built, never quoted.
    zeros = [0] * 53
    hrp = 'suiprivkey'
    poly = _bech32_polymod(_hrp_expand(hrp) + zeros + [0] * 6) ^ 1
    checksum = [(poly >> 5 * (5 - i)) & 31 for i in range(6)]
    valid_key = hrp + '1' + ''.join(BECH32_CHARSET[d] for d in zeros + checksum)

    # The shape of a test fixture: the prefix, then filler, 72 characters where a key is 70.
    # Reconstructed here; never read from the file that holds one.
    filler_key = hrp + '1' + ('qtest' * 13)[:61]

    # One character of the checksum changed. Everything else about it is still a key.
    tampered = valid_key[:-1] + ('p' if valid_key[-1] != 'p' else 'z')

    jose = base64.urlsafe_b64encode(b'{"alg":"HS256","typ":"JWT"}').decode().rstrip('=')
    body = base64.urlsafe_b64encode(b'{"sub":"selftest"}').decode().rstrip('=')
    real_jwt = f'{jose}.{body}.{"s" * 20}'
    fake_jwt = 'eyJ' + 'A' * 20 + '.' + 'B' * 20 + '.' + 'C' * 20

    account = {f: 'selftest' for f in SA_FIELDS}
    account['type'] = 'service_account'
    service_account = json.dumps(account)
    mention_only = 'The key file is the one whose "type": "service_account" field says so.'

    # These two are ASSEMBLED rather than written out. Spelled in full they would be findings in
    # this file, and the one thing a scanner must never do is refuse the commit that installs it.
    # Splitting each immediately after the token the rule anchors on is what breaks the match.
    pem_marker = '-----BEGIN ' + 'OPENSSH PRIVATE KEY' + '-----'
    npm_line = '//registry.npmjs.org/:_authToken=' + 'abc123def456ghi789'
    npm_templated = '//registry.npmjs.org/:_authToken=' + '${NPM_TOKEN}'

    checks = [
        ('bech32 key: format-valid key IS caught',
         'bech32 Sui private key' in labels(f'const k = "{valid_key}";'), True),
        ('bech32 key: generated key is 70 characters', len(valid_key) == SUI_PRIVKEY_LEN, True),
        ('bech32 key: fixture filler is NOT caught',
         'bech32 Sui private key' in labels(f'const k = "{filler_key}";'), False),
        ('bech32 key: fixture filler is 72 characters', len(filler_key) == 72, True),
        ('bech32 key: one tampered checksum character is NOT caught',
         'bech32 Sui private key' in labels(f'const k = "{tampered}";'), False),
        ('bech32 key: key butted against more alphabet IS caught',
         'bech32 Sui private key' in labels(valid_key + 'qqqq'), True),

        ('JWT: decodable JOSE header IS caught', 'JSON Web Token' in labels(real_jwt), True),
        ('JWT: three undecodable segments are NOT caught',
         'JSON Web Token' in labels(fake_jwt), False),

        ('service account: full field set IS caught',
         'GCP service-account key file' in labels(service_account), True),
        ('service account: a mention in prose is NOT caught',
         'GCP service-account key file' in labels(mention_only), False),

        ('npm token: a written value IS caught',
         'npm auth token' in labels(npm_line), True),
        ('npm token: an interpolated variable is NOT caught',
         'npm auth token' in labels(npm_templated), False),

        # Shape-only rules. They cannot validate, so what is asserted is that they still fire.
        ('PEM (shape only): still fires',
         'PEM private key' in labels(pem_marker), True),
        ('AWS (shape only): still fires',
         'AWS access key id' in labels('AKIA' + 'A' * 16), True),
        ('GitHub (shape only): still fires',
         'GitHub token' in labels('ghp_' + 'a' * 36), True),

        # The path rules do not depend on any value at all.
        ('path rule: a key-shaped filename is refused',
         'key-shaped filename staged' in {lb for _p, lb, _d in scan('harvest.key', '', {})}, True),
        ('path rule: a committed .env.example is not refused for existing',
         'env-shaped file staged' in {lb for _p, lb, _d in scan('.env.example', '', {})}, False),
    ]

    failed = 0
    for name, got, want in checks:
        ok = got is want
        failed += 0 if ok else 1
        print(f'  {"PASS" if ok else "FAIL"}  {name}')

    print()
    if failed:
        print(f'scan-secrets: SELFTEST FAILED — {failed} of {len(checks)}')
        return 1
    print(f'scan-secrets: selftest OK — {len(checks)} checks, both directions')
    return 0


def load_allowlist() -> dict[str, str]:
    """Fails closed: unreadable, or suppressed with no reason, is a failure and not a skip."""
    if not ALLOWLIST.exists():
        return {}
    try:
        data = json.loads(ALLOWLIST.read_text())
    except Exception as exc:
        raise SystemExit(f'scan-secrets: {ALLOWLIST.name} is unreadable ({exc}). Refusing to run.')
    if not isinstance(data, dict):
        raise SystemExit(f'scan-secrets: {ALLOWLIST.name} must be an object. Refusing to run.')
    entries = {k: v for k, v in data.items() if not k.startswith('_')}
    for key, reason in entries.items():
        if not isinstance(reason, str) or not reason.strip():
            raise SystemExit(
                f'scan-secrets: "{key}" is suppressed with no reason. Refusing to run.')
    return entries


def main() -> int:
    argv = sys.argv[1:]

    # Before anything else, and independent of the tree: does the scanner still catch what it is
    # supposed to catch, and still ignore what it is supposed to ignore?
    if '--selftest' in argv:
        return selftest()

    allowlist = load_allowlist()

    if '--paths' in argv:
        paths = [p for p in argv[argv.index('--paths') + 1:] if not p.startswith('--')]
        read, mode = disk_blob, 'named path'
    elif '--all' in argv:
        paths, read, mode = tracked_paths(), disk_blob, 'tracked file'
    else:
        paths, read, mode = staged_paths(), staged_blob, 'staged file'

    if not paths:
        print('scan-secrets: nothing to scan')
        return 0

    secrets = live_secrets()
    findings, suppressed = [], 0

    for path in paths:
        for finding in scan(path, read(path), secrets):
            key = '%s:%s:%s' % finding
            if key in allowlist:
                suppressed += 1
                continue
            findings.append(finding)

    note = f', {suppressed} allowlisted' if suppressed else ''
    print(f'scan-secrets: {len(paths)} {mode}(s), '
          f'{len(secrets)} live secret(s) compared{note}')

    if not findings:
        # CLEAN and DEGRADED are different answers and must not print the same word.
        #
        # The identity rule -- exact containment of a value read from a live .env -- is the strongest
        # of the three checks and the only one that catches a real key pasted into a comment. With no
        # .env present it compares against nothing and contributes nothing, and the run still printed
        # CLEAN. A checkout with no .env therefore reported the same result as a fully checked one,
        # which is how a guard convinces people it is guarding.
        if not secrets:
            print('scan-secrets: DEGRADED — no live secrets were available to compare against.')
            print('  The pattern rules ran and found nothing. The identity rule did not run at all,')
            print('  so a real credential copied out of .env would not have been caught by this run.')
            print('  This is not CLEAN. Provide the environment file, or read this as "patterns only".')
            return 0
        print('scan-secrets: CLEAN')
        return 0

    print(f'scan-secrets: BLOCKED — {len(findings)} finding(s)\n')
    for path, label, digest in findings:
        print(f'  {path}\n      {label}  (sha256:{digest})')
    print('\nNothing was committed. The value is deliberately not shown.')
    print('If this is a real credential it is compromised from the moment it was written down:')
    print('rotate it at the provider first, then remove it here. Removing it here is not the fix.')
    return 1


if __name__ == '__main__':
    sys.exit(main())
