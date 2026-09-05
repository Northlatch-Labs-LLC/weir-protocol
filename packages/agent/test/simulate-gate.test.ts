// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
/**
 * The gate between this agent and a signature, exercised directly.
 *
 * # Why this suite exists
 *
 * `simulateAndExecute` was written believing `Transaction.build({ client })` simulates internally
 * and throws first, so the explicit simulation was a second gate that would "often never be
 * reached". **The opposite is true for every transaction this package builds.** From
 * `@mysten/sui` 2.27.1, `src/client/core-resolver.ts:155-160`:
 *
 * ```ts
 * async function setGasBudget(transactionData, client, simulateExpiration) {
 *   if (transactionData.gasData.budget) {
 *     return;                                  // early return. Nothing is simulated.
 *   }
 *   const simulateResult = await client.core.simulateTransaction({ ... });
 * ```
 *
 * `build()` only dry-runs when it has to *compute* a budget. `simulateAndExecute` always sets one,
 * because an unattended signer with no gas ceiling has an unbounded spend that never appears as an
 * error. So the early return is taken every time, `build()` makes no network call, and the explicit
 * branch below is not a backstop — **it is the only thing standing between a Move abort and a
 * signed transaction.** It was also the only branch with no test.
 *
 * Measured before this suite was written: a fully-specified transaction with a gas budget set,
 * built against a client whose every method throws on contact, produced 211 bytes and zero client
 * calls. The `TrippedClient` below is that measurement turned into a fixture.
 *
 * # Nothing here touches a network
 *
 * The transaction carries an explicit sender, gas price, gas payment and only pure arguments, so
 * `needsTransactionResolution` (`src/transactions/resolve.ts:28`) is false and `build()` is local.
 * Every assertion is deterministic and offline.
 */

import { Transaction } from '@mysten/sui/transactions';
import type { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { describe, expect, it } from 'vitest';

import { classificationOf, preconditionOf, simulateAndExecute } from '../src/index.js';
import type { AgentKey } from '../src/index.js';

const KEY: AgentKey = (() => {
  const keypair = Ed25519Keypair.generate();
  return { address: keypair.toSuiAddress(), keypair };
})();

const GAS_BUDGET = 500_000_000n;

/** A transaction that needs nothing from a node to build. See the header. */
function offlineTransaction(): Transaction {
  const tx = new Transaction();
  tx.setSender(KEY.address);
  tx.setGasPrice(1000n);
  tx.setGasPayment([
    { objectId: `0x${'2'.repeat(64)}`, version: '1', digest: '11111111111111111111111111111111' },
  ]);
  tx.moveCall({ target: `0x${'a'.repeat(64)}::creator::unlock`, arguments: [tx.pure.u64(1n)] });
  return tx;
}

interface Recorded {
  simulated: number;
  signed: number;
}

/**
 * A node that answers a simulation with `envelope` and records whether anything was ever signed.
 *
 * `signAndExecuteTransaction` returning a digest rather than throwing is deliberate: a fake that
 * threw on signing would make every "did not sign" assertion pass for the wrong reason.
 */
function client(envelope: unknown): { client: SuiGrpcClient; calls: Recorded } {
  const calls: Recorded = { simulated: 0, signed: 0 };
  const fake = {
    simulateTransaction: async () => {
      calls.simulated += 1;
      return envelope;
    },
    signAndExecuteTransaction: async () => {
      calls.signed += 1;
      return { Transaction: { digest: 'DiGeSt1111111111111111111111111111111111111' } };
    },
  };
  return { client: fake as unknown as SuiGrpcClient, calls };
}

async function run(envelope: unknown) {
  const { client: c, calls } = client(envelope);
  const reading = await simulateAndExecute({
    client: c,
    transaction: offlineTransaction(),
    key: KEY,
    gasBudgetMist: GAS_BUDGET,
    what: 'creator::unlock "k"',
  });
  return { reading, calls };
}

/** The shape measured live on mainnet, 2026-08-31: `sim.Transaction.status`, no `effects`. */
const MAINNET_SUCCESS = { Transaction: { status: { success: true, error: null } } };

describe('the simulate branch is reached, and it is the only gate', () => {
  it('setting a gas budget means build() never dry-runs — so this branch always runs', async () => {
    const { calls } = await run(MAINNET_SUCCESS);
    // Exactly one simulation, and it is ours. If `build()` were dry-running there would be a
    // second call on the client, and if this branch were unreachable there would be none.
    expect(calls.simulated).toBe(1);
  });

  it('signs only after a simulation that was shown to succeed', async () => {
    const { reading, calls } = await run(MAINNET_SUCCESS);
    expect(reading.ok).toBe(true);
    expect(calls.signed).toBe(1);
    if (reading.ok) {
      expect(reading.value.digest).toBe('DiGeSt1111111111111111111111111111111111111');
      expect(reading.value.simulation.wouldSucceed).toBe(true);
    }
  });
});

describe('an unrecognised simulation envelope REFUSES', () => {
  /*
    The defect this is the guard for, in the estate's own history: the harvest daemon read
    `transaction.effects.status` — the JSON-RPC path — against a gRPC client that answers at
    `Transaction.status`. It resolved to `undefined` on every call. Had `undefined` been treated as
    permission to proceed, every doomed transaction would have been signed. It must refuse.
  */
  it.each([
    ['an empty object', {}],
    ['a string', 'ok'],
    ['a plausible-looking envelope with no status', { Transaction: { effects: {} } }],
    ['the JSON-RPC path this transport does not use', { transaction: { status: { success: true } } }],
  ])('refuses %s and signs nothing', async (_name, envelope) => {
    const { reading, calls } = await run(envelope);
    expect(reading.ok).toBe(false);
    expect(calls.signed).toBe(0);
    if (!reading.ok) {
      expect(reading.failure.detail).toContain('no status field');
      // `malformed`, not `transport`: retrying reproduces a shape mismatch exactly.
      expect(reading.failure.kind).toBe('malformed');
      expect(classificationOf(reading.failure)).toBe('permanent');
    }
  });

  /**
   * `null` refuses the same way every other unrecognised envelope does. It did not always.
   *
   * FOUND BY THIS SUITE, THEN FIXED. `packages/sdk/src/client.ts::simulate()` read
   * `shape.Transaction?.status` after casting the response. Optional chaining guards an
   * `undefined` property, not a `null` **subject** — a node answering literally `null` raised a
   * TypeError inside the `try` and returned `fail('transport', ...)`.
   *
   * The safety property always held: nothing was signed, which is the part that matters. The
   * classification was wrong in a way that matters to an unattended loop — `transport` reads as
   * "retry me", and retrying a node that answers `null` reproduces `null` for ever. A permanent
   * condition wearing a transient's name is how a loop spins instead of alerting.
   *
   * The SDK now checks each level is an object before indexing it, so a `null` at any depth lands
   * on the same `malformed` / no-status path as `{}` or a bare string. This test asserted the
   * defect while it stood and asserts the fix now; either way it reruns rather than living in a
   * report.
   */
  it('refuses null the same way as any other unrecognised envelope', async () => {
    const { reading, calls } = await run(null);
    expect(reading.ok).toBe(false);
    expect(calls.signed).toBe(0);
    if (!reading.ok) {
      expect(reading.failure.detail).toContain('no status field');
      expect(reading.failure.kind).toBe('malformed');
      expect(classificationOf(reading.failure)).toBe('permanent');
    }
  });

  it('refuses the envelope the DELETED second reader used to accept', async () => {
    /*
      `Transaction.effects.status` was one of six paths the reader in this package used to try. The
      SDK does not read it, and it is not a shape this transport produces — it was a guess. Two
      readers of one wire format is the defect; this asserts there is now one, and that it is the
      SDK's, by asserting the shape only the deleted one accepted is refused.
    */
    const { reading, calls } = await run({ Transaction: { effects: { status: { success: true } } } });
    expect(reading.ok).toBe(false);
    expect(calls.signed).toBe(0);
  });
});

describe('a failed simulation refuses, and says whether it can clear', () => {
  const abortEnvelope = (code: number, fn: string) => ({
    Transaction: {
      status: {
        success: false,
        error: `MoveAbort in 1st command, abort code: ${code}, in '0x${'c'.repeat(64)}::${fn}' (instruction 12)`,
      },
    },
  });

  it('a paused platform is a PRECONDITION, not a permanent refusal', async () => {
    // `account::open` begins `platform.assert_can_create()`, and that assert lives at
    // platform.move:319 — so a pause surfaces as a `platform` abort, code 4.
    const { reading, calls } = await run(abortEnvelope(4, 'platform::assert_can_create'));
    expect(reading.ok).toBe(false);
    expect(calls.signed).toBe(0);
    if (!reading.ok) {
      expect(classificationOf(reading.failure)).toBe('precondition');
      expect(preconditionOf(reading.failure)?.name).toBe('creation-paused');
      expect(preconditionOf(reading.failure)?.mayClear).toBe(true);
      expect(reading.failure.detail).toContain('set_creation_paused(false)');
    }
  });

  it('the SAME abort code in `account` is permanent — the module half is load-bearing', async () => {
    // code 4 is EAlreadyRegistered here and ECreationPaused above. A table keyed on the code alone
    // would classify both the same way and be wrong once.
    const { reading } = await run(abortEnvelope(4, 'account::open'));
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(classificationOf(reading.failure)).toBe('permanent');
      expect(preconditionOf(reading.failure)).toBeNull();
      expect(reading.failure.detail).toContain('This address already has an account');
    }
  });

  it('a creator not accepting payments is a precondition', async () => {
    const { reading } = await run(abortEnvelope(4, 'creator::settle'));
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(preconditionOf(reading.failure)?.name).toBe('vault-not-accepting');
    }
  });

  it('an insufficient payment is a precondition — it clears when the wallet is funded', async () => {
    const { reading } = await run(abortEnvelope(5, 'creator::settle'));
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(preconditionOf(reading.failure)?.name).toBe('insufficient-balance');
    }
  });

  it('a self-payment is permanent', async () => {
    const { reading } = await run(abortEnvelope(13, 'creator::settle'));
    expect(reading.ok).toBe(false);
    if (!reading.ok) expect(classificationOf(reading.failure)).toBe('permanent');
  });

  it('an unlisted abort code is NOT assumed to be a precondition', async () => {
    // Under-reporting costs a retry that never happens. Over-reporting costs a loop waiting for a
    // condition that will never clear, which is worse and much harder to notice.
    const { reading } = await run(abortEnvelope(99, 'creator::settle'));
    expect(reading.ok).toBe(false);
    if (!reading.ok) {
      expect(classificationOf(reading.failure)).toBe('permanent');
      // The raw text survives whether or not we could explain it.
      expect(reading.failure.detail).toContain('abort code: 99');
    }
  });

  it('a failure with no abort in it passes the node text through unmodified', async () => {
    const { reading, calls } = await run({
      Transaction: { status: { success: false, error: 'InsufficientGas' } },
    });
    expect(reading.ok).toBe(false);
    expect(calls.signed).toBe(0);
    if (!reading.ok) expect(reading.failure.detail).toContain('InsufficientGas');
  });
});

describe('the bytes simulated are the bytes signed', () => {
  it('a transaction survives the BCS round trip byte-for-byte, with no client', async () => {
    /*
      The SDK's `simulate()` takes a `Transaction` and builds it itself. Building the original
      twice would re-resolve object references, so a version moving between the two builds would
      put a signature on bytes nobody simulated. `simulateAndExecute` therefore builds once and
      hands `Transaction.from(bytes)` to the SDK. This asserts that restoration is exact and needs
      no node — the property the guard inside `simulateAndExecute` checks at run time.
    */
    const tx = offlineTransaction();
    tx.setGasBudget(GAS_BUDGET);
    const bytes = await tx.build();
    const rebuilt = await Transaction.from(bytes).build();
    expect(Array.from(rebuilt)).toEqual(Array.from(bytes));
  });
});
