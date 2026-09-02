# `@projectx-social/signer`

The custody boundary. Four adapters that hold a key at four different distances from this process,
one wrapper that will not let any of them sign a transaction that has not been simulated and
judged, and a hash-chained record of every decision either way.

---

## Read this first: there is no key rotation, and there cannot be

`sui-contracts/sources/account.move` declares:

```move
/// A registered identity. Soulbound — see the module documentation.
public struct SocialAccount has key { … }
```

`key` only. **No `store`.** The module's own header says only that module can move one, and the
module offers no function that does. `Subscription` and `Unlock` in `entitlement.move` are the
same shape.

So a weir account **cannot be transferred**, and the consequence is the whole reason this package
exists:

> **A leaked agent key is unrecoverable.** There is no rotation. The handle is lost. Every
> entitlement ever bought with that key is lost, because none of them can move to a new address.

This desk previously wrote that an agent has "no long-lived credential, nothing to leak". **That
was false.** The Ed25519 private key *is* the long-lived credential. Per-request signatures stop
replay; they do nothing whatsoever about key theft.

### Custody tiers are damage limitation, not a fix

Say it plainly, because the difference matters when someone is deciding how much to spend on
custody: none of the tiers below recover an account. They reduce the chance of theft and the
damage it does. They do not undo it.

| Tier | Key lives | Recovers a leaked key | What it actually buys |
|---|---|---|---|
| `LocalKeypairSigner` | this process's heap | no | nothing. Correct for a funded-at-the-ceiling agent carrying pocket money; wrong for anything else. |
| `MultiSigSigner` | split across members | no | **the operator can sweep the coins** out of a compromised agent without ever holding the agent's key. |
| `KmsSigner` (stub) | outside the process | no | raises the cost of *key* theft. Does nothing about a compromised caller who can invoke the KMS. |
| `ReadOnlySigner` | nowhere | n/a | a signer that cannot sign, and says so loudly instead of being a `null` somebody's `if` skips. |

### The multisig floor, precisely

A multisig of **(agent hot key, operator cold key) at threshold 1**:

- either party can act alone, so the agent is not slowed down and the operator needs no
  coordination in an emergency;
- when the agent key leaks, the operator **sweeps the address** immediately rather than waiting to
  see what the attacker does;
- **the address is still fixed and the handle still cannot move.** The attacker holds a key that
  satisfies the threshold, so they can spend too — this is a race the operator can now enter, not
  a lock they can turn.

Raising the threshold to 2 stops the attacker spending and also stops the agent operating
unattended, which is the point of an agent. The design accepts the first cost and refuses the
second; an operator who wants the other trade sets the weights.

**The account must be opened at the multisig address from the beginning.** A multisig address is
not either member's address, and because the account is soulbound, an account opened at the hot
key's address can never be moved under multisig custody afterwards. This is a decision made once,
before the handle is minted, and it cannot be revisited.

Both compatibility questions this raised were answered by execution, in
`test/custody-compat.test.ts`, and both are **yes**:

- `verifyPersonalMessageSignature` in `@mysten/sui` 2.27.1 accepts a MultiSig signature and
  resolves it to the multisig address — so `verifyAction`, the door every agent write goes
  through, works unchanged.
- `@mysten/seal` 1.4.6's `SessionKey` accepts a multisig signer and a secp256r1 signer — so a
  multisig agent can read the paid content it bought.

---

## Two bounds on spending, and they are independent on purpose

### Bound one: the chain enforces it

`sui-contracts/sources/creator.move:568-572`:

```move
/// Take exactly `price` from `payment`, returning the change.
fun take_price<T>(payment: &mut Coin<T>, price: u64, ctx: &mut TxContext): Coin<T> {
    assert!(payment.value() >= price, EInsufficientPayment);
    payment.split(price, ctx)
}
```

The contract takes **exactly the price** and hands back the change. So the coin you hand in is a
hard ceiling on what that call can cost — whatever the vault says the price is, whatever a
manipulated feed reports, and whatever an injected instruction talked the agent into.

```ts
import { boundedPayment } from '@projectx-social/signer';

const payment = boundedPayment(tx, { source: tx.gas, ceiling: 2_500_000n });
// hand `payment` to creator::unlock — the contract cannot take more than the coin holds
```

`subscribe`, `renew` and `unlock` all route through `take_price`. **`tip` does not** — it takes the
coin entire, which is right for a tip and is exactly why the bound is stated as *the coin holds no
more than the ceiling* rather than *the contract takes no more*. Funded at the ceiling, a tip costs
the ceiling and not one MIST more.

This bound does **not** cover gas. Gas comes from the gas coin.

### Bound two: we enforce it

`PolicySigner` simulates, evaluates against `@projectx-social/policy`, records, and only then
signs. It sees things the chain cannot — a call target, a transfer recipient, a rolling spend
window across many transactions.

### Why both

- Bound one holds even if our policy file is wrong, our ledger is stale, our evaluator has a bug,
  or the process signing is not the one we think it is.
- Bound two holds even if the coin was funded wrongly.

A ceiling enforced by the chain beats one enforced by our own code. Having both means one failure
on either side is not a loss. **Do not collapse them into one.**

---

## Using it

```ts
import { createClient, loadConfig } from '@projectx-social/sdk';
import { localKeypairSignerFromKeystore, policySigner } from '@projectx-social/signer';

const config = loadConfig(process.env);
const client = createClient(config);

const inner = await localKeypairSignerFromKeystore({
  path: `${process.env.HOME}/.sui/sui_config/sui.keystore`,
  address: agentAddress,
});
if (!inner.ok) throw new Error(inner.failure.detail);

const signer = policySigner({
  inner: inner.value,
  policy,                     // see @projectx-social/policy
  client,
  ledger: () => readSpendSinceLastPrune(),   // yours; see the note below
});

const signed = await signer.signTransaction(tx);
if (!signed.ok) {
  // A refusal is a value, not an exception. `signed.failure.detail` is written for whoever has
  // to decide whether to widen the policy.
  return;
}
await recordSpend(signed.value.effects);     // then submit signed.value.bytes + signature
```

### The ledger is yours, and the ceiling is only as good as it

`ledger` is a function, not a value, because a rolling window needs the current time and the spend
recorded since the last call. **If you sign and fail to record the spend, the next evaluation sees
a smaller total and permits more than the ceiling.** Bound one does not depend on the ledger and
does not fail with it — which is why there are two.

---

## What is recorded, and what the record proves

Every decision, allow and deny, goes into a hash-chained log. The denials matter most: a run of
`move-call-target` refusals on `claim_earnings` is the signature of a prompt-injection attempt, and
it is invisible in a log that only writes successes.

Each entry carries `{ ts, address, txDigest, policyHash, decision, reason }` plus its sequence
number and the previous entry's hash. The policy hash is there so that a policy widened later
cannot make a past decision look compliant — the widening shows up at the exact entry where it
first took effect.

**What the chain detects:** editing, reordering or deleting any entry, from that entry onward.
`test/audit.test.ts` proves each case.

**What it does not detect:** an attacker who rewrites the whole log, because they can recompute
every subsequent hash. A hash chain is tamper-*evident* against partial edits, not tamper-*proof*.
Closing that needs an anchor outside the log — `AuditLog.headHash`, written somewhere the attacker
does not control. Nothing here publishes it, because where an anchor lives is a deployment
decision. `test/audit.test.ts` asserts this limitation as explicitly as it asserts the guarantees.

The log is in memory and is not persisted. Where an audit trail is stored is a decision with
consequences a library cannot see.

---

## Findings from the client library, measured rather than read

All three were measured against mainnet on `@mysten/sui` 2.27.1 on 2026-08-31, and all three
changed the code in `src/evidence.ts`.

**1. A failing simulation is under `FailedTransaction`, not `Transaction`.** `@mysten/sui`'s gRPC
parser ends in a ternary (`src/grpc/core.ts:1597-1605`) that puts the payload under `Transaction`
on success and `FailedTransaction` on failure. `packages/sdk/src/client.ts`'s `simulate()` reads
only `Transaction?.status`, so a genuinely aborting transaction returns `fail('malformed', …)`
carrying the text *"This is a client/server shape mismatch, not a rejected transaction."* — which
for a real abort is exactly backwards. It fails **closed**, so nothing unsafe follows from it, but
the decoded abort is unreachable through it. This package reads the failure branch itself and runs
that read **before** the SDK gate, so an abort is reported as an abort.

**2. `TransferObjects.address` is an argument reference, not an address.** Measured live, a
recipient came back as `{"$kind":"Input","Input":1}`, and input 1 was `{"$kind":"Pure","Pure":
{"bytes":"2nhL…"}}` — base64 of the 32 raw address bytes. A translator reading `.address` directly
hands the recipient rule an object; the rule refuses it, every transfer is denied, and the
allow-list looks strict while testing nothing. The reference is resolved here. A recipient that is
a command *result* cannot be known before execution and becomes an explicit unresolved marker no
allow-list can match — refusing, by construction.

**3. The digest is on the effects, not on the transaction.** `Transaction.digest` was `undefined`
in every measurement; `effects.transactionDigest` carried the value. The audit entry needs it, so
this reader asks for `effects` and reads it there — and leaves it empty rather than fabricating one
when the node reported none.

**Also measured, and it affects the caller:** for a sender whose gas payment is the empty list —
the address-balance form, which is what an address with no `Coin<SUI>` objects gets — `tx.build({
client })` performs server-side gas selection that itself simulates. **An aborting transaction
therefore throws at build time, before any simulation call is reached.** `src/evidence.ts`'s
`buildBytes` catches that, decodes the abort out of the message, and classifies it `malformed`
rather than `transport` — the SDK classifies the same throw as `transport`, which tells an operator
to retry a deterministic Move abort that will reproduce for ever.

---

## What this does not protect against

**A compromised process.** Everything here runs in the same memory as the key it guards; an
attacker with code execution calls the underlying adapter directly and never passes through
`PolicySigner` at all.

`PolicySigner` bounds what a **misled** agent can do — one steered by text somebody else wrote,
which is the actual threat model of an agent that reads the internet. It does not bound what a
**compromised host** can do. Bound one, on the chain, is the one that survives this package being
bypassed entirely.

---

## Interface style

Every interface member in this package and in `@projectx-social/policy` is written as a **property
function** (`signTransaction: (bytes) => …`), never as a method (`signTransaction(bytes): …`).
TypeScript compares method parameters bivariantly and property-function parameters
contravariantly, so the method form silently accepts an implementation that demands more than the
interface promises. That hole let an under-specified implementation through on this branch once.
`test/variance.test.ts` demonstrates the runtime consequence and pins the compile-time behaviour
with `@ts-expect-error`, so a future edit back to method syntax fails `tsc --noEmit`.
