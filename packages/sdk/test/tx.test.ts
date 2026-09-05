// Built-by: @projectx.sui · Co-authored-by: Claude
/**
 * Shape tests for constructed transactions.
 *
 * A programmable transaction is an untyped, positional boundary — no compiler checks that
 * `moveCall` arguments are in the right order. Swapping two same-typed `u64`s builds, signs, and
 * then does the wrong thing.
 *
 * So these tests read the constructed transaction back and assert its shape: the target, the
 * argument count, the type parameters, and — where two same-typed arguments sit next to each other
 * — the actual encoded values, in order.
 */

import { describe, expect, it } from 'vitest';
import { Transaction } from '@mysten/sui/transactions';
import type { ProjectXSocialConfig } from '../src/config.js';
import * as tx from '../src/tx.js';

/*
  `packageId` and `latestPackageId` are deliberately DIFFERENT here, matching mainnet after the
  key-registry upgrade. Setting them equal would make every assertion below pass whichever field a
  builder used — and the whole point of the split is that a call target must be the latest package
  while a type tag must stay the original.
*/
const CONFIG: ProjectXSocialConfig = {
  network: 'mainnet',
  grpcUrl: 'https://example.invalid',
  packageId: '0xc5c833991ed1123d70b1001c0bcdb01ec5728b09f25dfc42a0edaf16005d404d',
  latestPackageId: '0xa7fd154039f77780f808c7262511a9f4a860620d57e17b58e0e2ca010e1d214d',
  platformId: '0x3f695b2c32714e2359c4bb9515598d8dd765b216148c5b8fa818073d52b50f36',
  registryId: '0x1a3fb4ac25458d7524be064a2b7e1586ccd9ed09c0d5b351621e3b101e1203a0',
};

const SENDER = '0xda784b6c20c5995f6b719a20a26eddee5ec971c8ecec890e61c8b4634dd1715d';
const VAULT = '0x1111111111111111111111111111111111111111111111111111111111111111';
const CAP = '0x2222222222222222222222222222222222222222222222222222222222222222';
const ACCOUNT = '0x3333333333333333333333333333333333333333333333333333333333333333';

interface MoveCall {
  kind: 'MoveCall';
  target: string;
  typeArguments: string[];
  arguments: unknown[];
}

interface SerializedTx {
  inputs: Array<{ value?: { Pure?: number[] } }>;
  transactions: Array<{ kind: string } & Partial<MoveCall>>;
}

function parse(t: Transaction): SerializedTx {
  return JSON.parse(t.serialize()) as SerializedTx;
}

function moveCalls(t: Transaction): MoveCall[] {
  return parse(t).transactions.filter((c): c is MoveCall => c.kind === 'MoveCall');
}

function kinds(t: Transaction): string[] {
  return parse(t).transactions.map((c) => c.kind);
}

/** The module and function halves of a fully-qualified target. */
function split(target: string): { package: string; module: string; function: string } {
  const [pkg, module, fn] = target.split('::');
  return { package: pkg!, module: module!, function: fn! };
}

/**
 * Decode the pure input referenced by argument `argIndex` of move call `callIndex` as a u64.
 *
 * A serialized pure input carries **no type tag**, so nothing here can verify that the bytes at a
 * position really are a u64; the length check below only rejects an obviously wrong width. Position
 * is the whole contract, which is why the Move signature is quoted at every builder and why the
 * layout is asserted argument by argument below rather than by scanning.
 */
function u64Arg(t: Transaction, callIndex: number, argIndex: number): bigint {
  const parsed = parse(t);
  const call = parsed.transactions.filter((c) => c.kind === 'MoveCall')[callIndex] as
    | MoveCall
    | undefined;
  if (call === undefined) throw new Error(`no move call at index ${callIndex}`);

  const argument = call.arguments[argIndex] as { kind?: string; index?: number } | undefined;
  if (argument?.kind !== 'Input' || argument.index === undefined) {
    throw new Error(`argument ${argIndex} is not a pure input (it is ${argument?.kind ?? 'absent'})`);
  }

  const bytes = parsed.inputs[argument.index]?.value?.Pure;
  if (bytes === undefined) throw new Error(`input ${argument.index} is not pure`);
  if (bytes.length !== 8) {
    throw new Error(`input ${argument.index} is ${bytes.length} bytes, not a u64`);
  }

  let n = 0n;
  for (let i = 7; i >= 0; i -= 1) n = (n << 8n) | BigInt(bytes[i]!);
  return n;
}

describe('openAccount', () => {
  const t = tx.openAccount({ config: CONFIG }, { handle: 'alice', referrer: null });
  const call = moveCalls(t)[0]!;

  it('targets account::open', () => {
    const t3 = split(call.target);
    expect(t3.module).toBe('account');
    expect(t3.function).toBe('open');
  });

  it('passes five arguments: platform, registry, handle, referrer, clock', () => {
    // The Move signature takes five before `ctx`, which the runtime supplies.
    expect(call.arguments).toHaveLength(5);
  });

  it('takes no type parameters', () => {
    expect(call.typeArguments).toEqual([]);
  });
});

describe('addTier', () => {
  // price and periodMs are adjacent u64s — the exact swap this file exists to catch.
  const PRICE = 10_000_000n;
  const PERIOD = 2_592_000_000n; // 30 days
  const t = tx.addTier(
    { config: CONFIG },
    {
      coinType: '0x2::sui::SUI',
      vaultId: VAULT,
      capId: CAP,
      name: 'Monthly',
      price: PRICE,
      periodMs: PERIOD,
    },
  );

  it('targets creator::add_tier with the coin type parameter', () => {
    const call = moveCalls(t)[0]!;
    expect(split(call.target).module).toBe('creator');
    expect(split(call.target).function).toBe('add_tier');
    expect(call.typeArguments).toEqual(['0x2::sui::SUI']);
  });

  it('encodes price before period, not the other way round', () => {
    // add_tier(vault, cap, name, price, period_ms) — price is argument 3, period argument 4.
    // If these were swapped the transaction would still build and sign, and would sell a
    // subscription priced at 2.59 billion units lasting 10 milliseconds.
    expect(u64Arg(t, 0, 3)).toBe(PRICE);
    expect(u64Arg(t, 0, 4)).toBe(PERIOD);
  });

  it('places the tier name at argument 2, before both numbers', () => {
    // Pins the whole layout rather than only the two numbers. If an argument were inserted or
    // removed, the price and period assertions above could still pass against the wrong slots
    // while this one fails — which is the point of checking a third position.
    const parsed = parse(t);
    const call = parsed.transactions.filter((c) => c.kind === 'MoveCall')[0] as MoveCall;
    const nameArg = call.arguments[2] as { kind: string; index: number };
    const bytes = parsed.inputs[nameArg.index]!.value!.Pure!;

    // BCS string: a ULEB128 length followed by UTF-8 bytes.
    expect(bytes[0]).toBe('Monthly'.length);
    expect(Buffer.from(bytes.slice(1)).toString('utf8')).toBe('Monthly');
  });

  it('passes five arguments', () => {
    expect(moveCalls(t)[0]!.arguments).toHaveLength(5);
  });
});

describe('subscribe', () => {
  const t = tx.subscribe(
    { config: CONFIG },
    {
      coinType: '0x2::sui::SUI',
      vaultId: VAULT,
      accountId: ACCOUNT,
      tierIndex: 0n,
      paymentCoin: (() => {
        const inner = new Transaction();
        return inner.gas;
      })(),
      sender: SENDER,
    },
  );

  it('targets creator::subscribe with six arguments', () => {
    const call = moveCalls(t)[0]!;
    expect(split(call.target).function).toBe('subscribe');
    // platform, vault, account, tier_index, payment, clock
    expect(call.arguments).toHaveLength(6);
  });

  it('returns the change to the sender rather than dropping it', () => {
    // `subscribe` returns Coin<T>. An unused return value aborts the transaction, so the builder
    // must dispose of it — this asserts it actually does.
    expect(kinds(t).filter((k) => k === 'TransferObjects')).toHaveLength(1);
  });
});

describe('withdrawStake', () => {
  const t = tx.withdrawStake(
    { config: CONFIG },
    { vaultId: VAULT, accountId: ACCOUNT, amount: 5_000_000_000n, recipient: SENDER },
  );

  it('includes SuiSystemState even though the buffer might have covered it', () => {
    // Omitting it would make exactly the large withdrawals fail — the ones that matter most.
    const call = moveCalls(t)[0]!;
    expect(split(call.target).function).toBe('withdraw');
    expect(call.arguments).toHaveLength(4);

    const serialized = JSON.stringify(parse(t).inputs);
    // Normalised to the full 32-byte form by the builder.
    expect(serialized).toContain(
      '0x0000000000000000000000000000000000000000000000000000000000000005',
    );
  });

  it('transfers the withdrawn coin to the recipient', () => {
    expect(kinds(t).filter((k) => k === 'TransferObjects')).toHaveLength(1);
  });
});

describe('harvest', () => {
  const t = tx.harvest({ config: CONFIG }, { vaultId: VAULT });

  it('takes only the vault and the system state — it is permissionless', () => {
    const call = moveCalls(t)[0]!;
    expect(split(call.target).module).toBe('stake_vault');
    expect(split(call.target).function).toBe('harvest');
    // No capability argument. Anyone may call it; that is the liveness guarantee.
    expect(call.arguments).toHaveLength(2);
  });
});

describe('composing into one transaction', () => {
  it('appends to a supplied transaction rather than starting a new one', () => {
    const shared = new Transaction();
    tx.addTier(
      { config: CONFIG, tx: shared },
      { coinType: '0x2::sui::SUI', vaultId: VAULT, capId: CAP, name: 'A', price: 1n, periodMs: 86_400_000n },
    );
    tx.addTier(
      { config: CONFIG, tx: shared },
      { coinType: '0x2::sui::SUI', vaultId: VAULT, capId: CAP, name: 'B', price: 2n, periodMs: 86_400_000n },
    );
    expect(moveCalls(shared)).toHaveLength(2);
  });
});

describe('every builder targets the latest package, never the original', () => {
  /*
    The trap this closes, found while upgrading mainnet to add `key_registry`.

    Sui does not resolve a package id to its newest version. A `moveCall` at the ORIGINAL address
    executes the ORIGINAL bytecode — so a module added in an upgrade is simply absent, and a
    behaviour changed in an upgrade silently does not apply. Meanwhile struct and event type tags
    keep the original address forever, so both ids are needed and they are one character apart in
    the config object.

    A builder that reached for `packageId` would keep working today, against last version's code,
    and would break the day a fix shipped. This asserts the target instead of trusting the reader.
  */
  const builders: Array<[string, () => Transaction]> = [
    ['openAccount', () => tx.openAccount({ config: CONFIG }, { handle: 'someone' })],
    [
      'addTier',
      () =>
        tx.addTier(
          { config: CONFIG },
          { coinType: '0x2::sui::SUI', vaultId: VAULT, capId: CAP, name: 'M', price: 1n, periodMs: 2n },
        ),
    ],
    [
      'setContentPrice',
      () =>
        tx.setContentPrice(
          { config: CONFIG },
          { coinType: '0x2::sui::SUI', vaultId: VAULT, capId: CAP, contentKey: new Uint8Array([1]), price: 1n },
        ),
    ],
    ['harvest', () => tx.harvest({ config: CONFIG }, { vaultId: VAULT })],
    [
      'claimRebate',
      () => tx.claimRebate({ config: CONFIG }, { vaultId: VAULT, accountId: ACCOUNT, recipient: SENDER }),
    ],
    [
      'publishEncryptionKey',
      () =>
        tx.publishEncryptionKey(
          { config: CONFIG },
          { keyRegistryId: VAULT, x25519Public: new Uint8Array(32).fill(7) },
        ),
    ],
    ['revokeEncryptionKey', () => tx.revokeEncryptionKey({ config: CONFIG }, { keyRegistryId: VAULT })],
  ];

  it.each(builders)('%s', (_name, build) => {
    const calls = moveCalls(build());
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.target.startsWith(`${CONFIG.latestPackageId}::`)).toBe(true);
      expect(call.target.startsWith(`${CONFIG.packageId}::`)).toBe(false);
    }
  });
});

describe('publishEncryptionKey', () => {
  // public fun publish(registry: &mut KeyRegistry, x25519_public: vector<u8>, clock: &Clock, ctx)
  it('passes the registry, the key and the clock, in that order and nothing else', () => {
    const key = new Uint8Array(32).map((_, i) => i + 1);
    const t = tx.publishEncryptionKey({ config: CONFIG }, { keyRegistryId: VAULT, x25519Public: key });
    const [call] = moveCalls(t);
    expect(call!.target).toBe(`${CONFIG.latestPackageId}::key_registry::publish`);
    expect(call!.arguments).toHaveLength(3);
    expect(call!.typeArguments).toEqual([]);

    // The key is serialised as a 32-byte vector, not as an address or a string. A `vector<u8>`
    // carries a length prefix, so the pure input is 33 bytes.
    const pure = parse(t).inputs.map((i) => i.value?.Pure).filter((p): p is number[] => Array.isArray(p));
    expect(pure.some((p) => p.length === 33 && p[0] === 32 && p[1] === 1 && p[32] === 32)).toBe(true);
  });

  it('takes no sender or owner argument — the contract reads ctx.sender()', () => {
    // If this ever gained an address argument, the substitution attack the on-chain registry
    // exists to prevent would be reachable from this client.
    const t = tx.publishEncryptionKey(
      { config: CONFIG },
      { keyRegistryId: VAULT, x25519Public: new Uint8Array(32).fill(9) },
    );
    expect(moveCalls(t)[0]!.arguments).toHaveLength(3);
  });
});

describe('the stake vault builders', () => {
  // public fun claim_creator_yield(vault: &mut StakeVault, cap: &StakeCap, amount: u64, ctx)
  it('claimCreatorYield passes vault, cap and amount, then transfers the coin back', () => {
    const t = tx.claimCreatorYield(
      { config: CONFIG },
      { vaultId: VAULT, capId: CAP, amount: 1_500_000_000n, recipient: SENDER },
    );
    const [call] = moveCalls(t);
    expect(call!.target).toBe(`${CONFIG.latestPackageId}::stake_vault::claim_creator_yield`);
    expect(call!.arguments).toHaveLength(3);
    // The returned Coin must be dealt with or the transaction aborts on an unused value.
    expect(kinds(t)).toContain('TransferObjects');
  });

  // public fun set_rebate_bps(vault: &mut StakeVault, cap: &StakeCap, rebate_bps: u64)
  it('setRebateBps passes vault, cap and bps — and returns nothing to transfer', () => {
    const t = tx.setRebateBps({ config: CONFIG }, { vaultId: VAULT, capId: CAP, rebateBps: 500n });
    const [call] = moveCalls(t);
    expect(call!.target).toBe(`${CONFIG.latestPackageId}::stake_vault::set_rebate_bps`);
    expect(call!.arguments).toHaveLength(3);
    expect(kinds(t)).not.toContain('TransferObjects');
  });

  it('both target the latest package, never the original', () => {
    for (const t of [
      tx.claimCreatorYield({ config: CONFIG }, { vaultId: VAULT, capId: CAP, amount: 1n, recipient: SENDER }),
      tx.setRebateBps({ config: CONFIG }, { vaultId: VAULT, capId: CAP, rebateBps: 0n }),
    ]) {
      for (const call of moveCalls(t)) {
        expect(call.target.startsWith(`${CONFIG.latestPackageId}::`)).toBe(true);
      }
    }
  });
});
