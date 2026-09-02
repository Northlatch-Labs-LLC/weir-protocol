// Built-by: @projectx.sui /|\ · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * Normalising the names an allow-list is compared against.
 *
 * # The defect this file exists to prevent
 *
 * An allow-list is a string comparison, and on Sui the same thing has several spellings. A
 * simulation of a real mainnet transfer, measured on `@mysten/sui` 2.27.1 on 2026-08-31, reported
 * its coin type as:
 *
 * ```
 * 0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI
 * ```
 *
 * while every human, every config file and every line of `packages/sdk/src/tx.ts` writes
 * `0x2::sui::SUI`. A policy that stores what a human wrote and compares it with what the node
 * said **matches nothing**. That is not a rule that fails loudly; it is a ceiling that never
 * applies, an allow-list that never admits, and — depending on which side of the comparison the
 * default sits — either an agent that can do nothing or an agent that can do anything.
 *
 * So both sides go through here. Not one: **both**, always, at every comparison site.
 *
 * # What is normalised, and what deliberately is not
 *
 * Addresses fold to `0x` plus 64 lower-case hex digits — the padded form the chain itself uses.
 * Module and function names are Move identifiers and are **case-sensitive**; `::SUI` and `::sui`
 * name different things and lower-casing them would silently merge two types. Only the leading
 * address is folded, and generic parameters inside `<>` are folded recursively, because
 * `Coin<0x2::sui::SUI>` and `Coin<0x000…2::sui::SUI>` are the same type and must compare equal.
 *
 * # Malformed input is never repaired
 *
 * Everything here returns `null` rather than a best guess. A normaliser that quietly repairs
 * nonsense produces a name that matches an allow-list entry by accident, which is the one failure
 * mode an allow-list has no defence against. A `null` reaches a rule that denies.
 */

/** `0x` followed by 1..64 hex digits, and nothing else. */
const ADDRESS_SHAPE = /^0x[0-9a-fA-F]{1,64}$/;

/**
 * Fold a Sui address to `0x` + 64 lower-case hex digits.
 *
 * Returns `null` for anything that is not an address: no prefix, too long, non-hex, empty.
 * A caller must treat `null` as "this cannot be compared", never as "no address".
 */
export function normaliseAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!ADDRESS_SHAPE.test(trimmed)) return null;
  const digits = trimmed.slice(2).toLowerCase();
  return `0x${digits.padStart(64, '0')}`;
}

/**
 * Fold a fully-qualified Move type, including any generic parameters.
 *
 * `0x2::coin::Coin<0x2::sui::SUI>` and its padded spelling normalise to the same string. Primitive
 * type parameters (`u64`, `bool`, `address`, `vector<u8>`) carry no address and pass through
 * unchanged apart from whitespace.
 *
 * Returns `null` if any address component is malformed or the `<>` nesting does not balance.
 */
export function normaliseType(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const open = trimmed.indexOf('<');
  if (open === -1) return normaliseTypeHead(trimmed);

  if (!trimmed.endsWith('>')) return null;
  const head = normaliseTypeHead(trimmed.slice(0, open));
  if (head === null) return null;

  const params = splitTypeParameters(trimmed.slice(open + 1, -1));
  if (params === null) return null;

  const normalisedParams: string[] = [];
  for (const param of params) {
    const normalised = normaliseType(param);
    if (normalised === null) return null;
    normalisedParams.push(normalised);
  }

  return `${head}<${normalisedParams.join(',')}>`;
}

/**
 * The `address::module::name` part of a type, with no generics.
 *
 * A bare primitive (`u64`, `bool`, `address`, `signer`) is a legal type parameter and carries no
 * address, so it is returned as written. Anything with `::` in it must have a valid address in
 * front, or this returns `null`.
 */
function normaliseTypeHead(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const parts = trimmed.split('::');
  if (parts.length === 1) {
    // A primitive type parameter. Restricted to the known set rather than accepting any bare
    // word, because an unknown bare word is far more likely to be a typo in a policy file than a
    // type — and a typo that normalises successfully lands in an allow-list.
    return PRIMITIVE_TYPES.has(trimmed) ? trimmed : null;
  }
  if (parts.length !== 3) return null;

  const [address, moduleName, typeName] = parts as [string, string, string];
  const normalisedAddress = normaliseAddress(address);
  if (normalisedAddress === null) return null;
  if (!IDENTIFIER.test(moduleName) || !IDENTIFIER.test(typeName)) return null;

  // Module and type names are case-sensitive Move identifiers. See the file header.
  return `${normalisedAddress}::${moduleName}::${typeName}`;
}

/**
 * Fold a Move call target, `address::module::function`.
 *
 * Separate from {@link normaliseType} because a call target may never carry generics — the type
 * arguments of a `MoveCall` are a distinct field with a distinct allow-list, and accepting
 * `pkg::mod::fn<T>` here would let a policy author write a target that can never match anything
 * the simulator reports, which is a rule that silently does nothing.
 */
export function normaliseTarget(value: string): string | null {
  if (value.includes('<') || value.includes('>')) return null;
  return normaliseTypeHead(value);
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PRIMITIVE_TYPES = new Set([
  'bool',
  'u8',
  'u16',
  'u32',
  'u64',
  'u128',
  'u256',
  'address',
  'signer',
]);

/**
 * Split `A,B<C,D>,E` on top-level commas only.
 *
 * Splitting on every comma would tear `Coin<A,B>` in half and produce two type names that are
 * each malformed, which the caller would then reject — turning a legal nested generic into a
 * refusal. Returns `null` when the angle brackets do not balance.
 */
function splitTypeParameters(inner: string): string[] | null {
  const out: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') {
      depth -= 1;
      if (depth < 0) return null;
    } else if (ch === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }

  if (depth !== 0) return null;
  out.push(inner.slice(start));
  return out.every((s) => s.trim() !== '') ? out : null;
}
