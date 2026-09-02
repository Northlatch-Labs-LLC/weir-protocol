// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * `LocalKeypairSigner` — a private key in this process's memory.
 *
 * # This is the tier with no protection, and it must be labelled as such
 *
 * The key is in the heap. It is in a core dump, in a heap snapshot, in whatever a debugger
 * attached to this process can read, and in the file it was loaded from. Because a weir account
 * is soulbound (see `signer.ts`), theft of that key is permanent and unrecoverable: no rotation,
 * handle lost, entitlements lost. This adapter is correct for a funded-at-the-ceiling agent
 * carrying pocket money and wrong for anything else. `MultiSigSigner` is the floor for an agent
 * holding a handle worth keeping.
 *
 * # Two loaders, because the two encodings fail differently
 *
 * `sui keytool export` produces a bech32 `suiprivkey1…` string that names its own scheme.
 * `~/.sui/sui_config/sui.keystore` is a JSON array of base64 `flag || 32 bytes`. Both are read
 * here, and neither is guessed at: a raw 32-byte hex string is **refused**, because it is
 * indistinguishable by inspection from a public key, an object id and a transaction digest, and a
 * loader that accepts every 32-byte thing will one day be handed the wrong one. That rule is
 * `packages/agent/src/keys.ts`'s and it is kept.
 *
 * # A failed decode never quotes its input
 *
 * The input to a key parser is a private key. Crypto libraries routinely include the offending
 * value in a parse error, so every failure message below is written by hand and the underlying
 * message is **discarded** rather than wrapped. Losing the library's detail is the point: the one
 * fact a caller must never get in a log aggregator is the string itself.
 */

import { readFile } from 'node:fs/promises';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { Secp256r1Keypair } from '@mysten/sui/keypairs/secp256r1';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import type { Keypair } from '@mysten/sui/cryptography';
import { fail, ok, type Reading } from '@projectx-social/sdk';
import type { SerializedSignature, Signer, SignerScheme } from './signer.js';

/** The two schemes this adapter can hold. `multisig` is not a keypair and is not one of them. */
type KeypairScheme = Extract<SignerScheme, 'ed25519' | 'secp256r1'>;

/**
 * Wrap a Sui keypair.
 *
 * The keypair is captured in the closure and is not a property of the returned object. A caller
 * who logs a `Signer` prints an address and a scheme; there is no accessor anywhere on it that
 * returns key material, and adding one would defeat the only protection this tier has.
 */
function fromKeypair(keypair: Keypair, scheme: KeypairScheme): Signer {
  const address = keypair.toSuiAddress();
  return {
    address,
    scheme,
    signPersonalMessage: async (bytes) => {
      try {
        const { signature } = await keypair.signPersonalMessage(bytes);
        return ok<SerializedSignature>(signature);
      } catch (error) {
        void error; // may quote key material
        return fail('transport', `local ${scheme} signer ${address}`, 'signing failed');
      }
    },
    signTransaction: async (bytes) => {
      try {
        const { signature } = await keypair.signTransaction(bytes);
        return ok<SerializedSignature>(signature);
      } catch (error) {
        void error;
        return fail('transport', `local ${scheme} signer ${address}`, 'signing failed');
      }
    },
  };
}

/**
 * Load from a bech32 `suiprivkey1…` secret.
 *
 * The scheme comes from the encoding itself rather than from a parameter, so a secp256r1 key
 * cannot be loaded as Ed25519 and silently produce a signer for an address nobody controls.
 */
export function localKeypairSignerFromSecret(secret: string): Reading<Signer> {
  const source = 'local keypair signer';
  const trimmed = secret.trim();
  if (trimmed === '') {
    return fail('unconfigured', source, 'the signing secret is empty.');
  }

  let parsed: { scheme: string; secretKey: Uint8Array };
  try {
    parsed = decodeSuiPrivateKey(trimmed);
  } catch (error) {
    void error; // can quote the key
    return fail(
      'unconfigured',
      source,
      'the signing secret could not be decoded as a bech32 Sui private key (suiprivkey1…). ' +
        'Its value is deliberately not shown.',
    );
  }

  return fromParsed(parsed.scheme, parsed.secretKey, source);
}

/**
 * Load one key from a Sui CLI keystore by the address it controls.
 *
 * # Why the address is required rather than an index
 *
 * A keystore is an ordered JSON array and the order changes whenever a key is added or removed.
 * An index selects a different key after any such edit, silently, and the first evidence would be
 * a transaction signed by the wrong address. The address is the stable name and it is the one an
 * operator can check against the policy document, so it is the only selector offered.
 *
 * Nothing about the file's other entries is reported. A failure says the address was not found,
 * never how many keys were present or what they were — that is a keystore inventory, and it does
 * not belong in a log.
 */
export async function localKeypairSignerFromKeystore(args: {
  readonly path: string;
  readonly address: string;
}): Promise<Reading<Signer>> {
  const source = `Sui keystore ${args.path}`;

  let contents: string;
  try {
    contents = await readFile(args.path, 'utf8');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // A missing keystore is `unconfigured`, not a transport fault: retrying will not create it.
    return fail('unconfigured', source, `could not be read: ${detail}`);
  }

  let entries: unknown;
  try {
    entries = JSON.parse(contents);
  } catch (error) {
    void error; // a parse error can quote the file, which is a list of private keys
    return fail('malformed', source, 'is not valid JSON. Its contents are deliberately not shown.');
  }

  if (!Array.isArray(entries)) {
    return fail('malformed', source, 'is not a JSON array of base64 key entries.');
  }

  const wanted = normalise(args.address);
  if (wanted === null) {
    return fail('unconfigured', source, `${JSON.stringify(args.address)} is not a Sui address.`);
  }

  for (const entry of entries) {
    if (typeof entry !== 'string') continue;

    let raw: Uint8Array;
    try {
      raw = Uint8Array.from(Buffer.from(entry, 'base64'));
    } catch (error) {
      void error;
      continue;
    }
    // `flag || 32 bytes`. Anything else is not a keystore entry; skip it rather than reporting
    // its length, which would leak the file's structure.
    if (raw.length !== 33) continue;

    const scheme = FLAG_TO_SCHEME[raw[0]!];
    if (scheme === undefined) continue;

    const candidate = fromParsed(scheme, raw.slice(1), source);
    if (!candidate.ok) continue;
    if (normalise(candidate.value.address) === wanted) return candidate;
  }

  return fail(
    'not-found',
    source,
    `holds no key for ${wanted}. Nothing about the other entries is reported by design.`,
  );
}

/**
 * Flag byte to scheme, for the two schemes this adapter supports.
 *
 * `0x00` is Ed25519 and `0x02` is Secp256r1, per Sui's `SIGNATURE_SCHEME_TO_FLAG`. `0x01`
 * (Secp256k1) is deliberately absent: it is a valid Sui scheme, but nothing in this repository
 * uses it, and an adapter that quietly supported a scheme no policy or test covers is a code path
 * that has never been exercised holding a private key.
 */
const FLAG_TO_SCHEME: Record<number, KeypairScheme | undefined> = {
  0x00: 'ed25519',
  0x02: 'secp256r1',
};

function fromParsed(
  scheme: string,
  secretKey: Uint8Array,
  source: string,
): Reading<Signer> {
  try {
    if (scheme === 'ED25519' || scheme === 'ed25519') {
      return ok(fromKeypair(Ed25519Keypair.fromSecretKey(secretKey), 'ed25519'));
    }
    if (scheme === 'Secp256r1' || scheme === 'secp256r1') {
      return ok(fromKeypair(Secp256r1Keypair.fromSecretKey(secretKey), 'secp256r1'));
    }
  } catch (error) {
    void error; // can quote the key
    return fail('malformed', source, `a ${scheme} key could not be loaded.`);
  }

  return fail(
    'unconfigured',
    source,
    `signature scheme ${JSON.stringify(scheme)} is not supported by LocalKeypairSigner. ` +
      `Only ed25519 and secp256r1 are, and adding one means adding tests for it, not a branch.`,
  );
}

/** Local address folding, so keystore lookup is not defeated by a padding difference. */
function normalise(address: string): string | null {
  const trimmed = address.trim();
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(trimmed)) return null;
  return `0x${trimmed.slice(2).toLowerCase().padStart(64, '0')}`;
}
