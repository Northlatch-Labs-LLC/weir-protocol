# `@projectx-social/policy`

A pure evaluator with **zero dependencies and no I/O**. It takes what a simulation observed, what
an operator wrote down, and what the agent has already spent, and returns allow, or a reason.

```ts
evaluate(simulatedEffects, policyDoc, ledgerState)
//  -> { allow: true }
//  |  { allow: false, reason: string, ruleId: RuleId }
```

It signs nothing, reads nothing, and remembers nothing. `@projectx-social/signer` is its only
caller that matters, and it is the only place in this repository where a signature is produced.

---

## Zero dependencies is a security property, not a preference

This package is the last thing that says no before a signature exists. Every line it runs must be
a line in this repository. A transitive dependency here would be code with a vote on whether an
agent may spend, arriving through a lockfile bump nobody read.

It also performs **no I/O and reads no clock**. The current time is an input (`LedgerState.nowMs`),
so an evaluation is a pure function of its three arguments — which means a decision recorded in an
audit trail can be replayed years later and must reach the same verdict. A rule that read
`Date.now()` internally could not be replayed at all.

---

## Every rule is mutation-tested

A policy engine whose rules have never been shown to change an outcome is decoration, and
decoration that is trusted is worse than nothing.

`test/mutation.test.ts` therefore does two things for **every** rule: it asserts the full rule set
refuses a transaction that violates exactly that rule *and names that rule*, then deletes the rule
and asserts the remaining ten now permit the same transaction. Step two is the one that matters —
without it, a rule sitting behind another that happened to fire first would look tested.

Each fixture violates **exactly one** rule. A fixture that violated two would leave the other still
refusing after a deletion, and the mutation test would report a passing rule that had in fact been
removed. A test that cannot fail is not a test.

If a rule is added without a fixture, `covers every rule exactly once` fails the build. An untested
rule cannot enter the list quietly.

| Rule | What it refuses | Proven by deleting it |
|---|---|---|
| `policy-version` | a document from a schema this evaluator does not understand | ✅ |
| `sender-mismatch` | a simulation belonging to a different address than the policy governs | ✅ |
| `command-kind` | a `Publish`, an `Upgrade`, or any kind with no rule of its own | ✅ |
| `move-call-target` | `claim_earnings` called by an agent authorised only to buy | ✅ |
| `type-argument` | an allowed function instantiated at a coin type never permitted | ✅ |
| `transfer-recipient` | the purchased object transferred to a stranger instead of home | ✅ |
| `object-input` | an attacker's `CreatorVault` substituted for the one the principal authorised | ✅ |
| `gas-budget` | a gas budget above the ceiling | ✅ |
| `balance-evidence` | a simulation whose balance changes were never requested | ✅ |
| `amount-wellformed` | an amount `BigInt` would silently read as zero | ✅ |
| `coin-type-unlisted` | an outflow in a coin type with no configured ceiling | ✅ |
| `outflow-ceiling` | a spend that fits alone but breaches the rolling window total | ✅ |

---

## Everything is an allow-list, and there is no wildcard

There is no `"*"`, no `allowAll`, and no way to express "any target" or "any recipient". That is
the most important decision in this package and it is worth the inconvenience.

The scenario this exists for is an agent choosing what to buy from text somebody else wrote.
Prompt injection does not need a new capability — it only needs one the operator left open because
narrowing it was tedious. A deny-list asks the author to enumerate the attacks; an allow-list asks
them to enumerate the job. Only one of those is a list an author can finish.

The concrete case on this protocol: **an agent authorised to buy must not be able to call
`creator::claim_earnings`.** Both live in the same module of the same package, both are `public
fun`, and nothing on chain distinguishes them. `allowedTargets` is where that distinction is made,
and a wildcard would erase it in one character.

### The noun, not just the verb

`allowedTargets` bounds which function runs; `allowedObjects` bounds **which objects it runs on**,
and until that list existed the second question had no answer at all. `creator::unlock` takes
`vault: &mut CreatorVault<T>` (`sui-contracts/sources/creator.move:661`), and that one argument
decides whose earnings the payment lands in. Swap it and every other rule still passes: the
permitted target, the permitted coin type, the `Unlock` transferred home to the agent, the spend
inside the rolling ceiling. Vault creation is open to anyone for 29 SUI, so the destination is
attacker-supplied, cheap and repeatable — a ceiling caps one drain, it does not stop one.

Refusing shared objects wholesale is not the fix: `unlock` also takes the `Platform` and the
`Clock`, both shared and both mandatory, so that rule would deny the call it exists to permit and
be switched off within a day. The discrimination is by **id**. A policy author writes four to six:
the vault ids the agent may buy from, the `Platform`, the `Clock` (`0x6` — the short spelling is
normalised against the padded id the node reports), and the agent's own `SocialAccount`, whose id
is stable because `account.move:174` transfers it with `key` and no `store`.

**The honest limit:** a `Coin` object's id changes with every split and merge, so an agent paying
from a discrete owned coin will be refused here every time, naming an id nobody could have listed.
Pay by splitting the gas coin instead — its result is a command *result*, never an input.

There is also no `allowWithWarning`, no `override` and no `force`. A caller who wants a different
answer must change the policy document — which is hashed into every audit entry, so the widening
is visible afterwards at the exact entry where it first took effect. A runtime override would be
invisible in precisely the record that exists to make it visible.

---

## Five traps this package is built around

**`BigInt('')` is `0n`.** So is `BigInt(' ')`. An unreadable amount silently becoming a zero
outflow is a transaction that spends and reports that it did not. Every amount is shape-checked
with a regular expression *before* `BigInt` is called, and a rejected string returns `null`, never
a default.

**`Number` loses precision above 2^53.** A `u64` reaches 18_446_744_073_709_551_615;
`Number.MAX_SAFE_INTEGER` is two thousand times smaller. Every amount here is a `bigint`.

**The same coin type has several spellings.** A live mainnet simulation reported
`0x0000…0002::sui::SUI` where every human and every config file writes `0x2::sui::SUI`. A policy
that stores one and compares it with the other **matches nothing** — a ceiling that never applies
and an allow-list that never admits. Both sides go through `normaliseType`, always. Module and type
names stay case-sensitive, because Move's are.

**An empty list and an absent one are different facts.** `balanceChanges: []` means the node was
asked and reported none. It does not mean the node was not asked. `balanceChangesObserved` is a
required, separate boolean and `balance-evidence` refuses when it is false, because one of those
states is "this moves no money" and the other is "we do not know what this moves".

**Absence means opposite things on the two sides, and both readings are the strict one.** An
absent `objectInputs` is *evidence* nobody gathered, so `object-input` refuses it outright. An
absent `allowedObjects` is *authority* nobody granted, so the same rule reads it as the empty list
and permits no object at all. `canonicalPolicyJson` still encodes the two apart — `null` for a
document written before objects were bounded, `[]` for one that bounds none — because they are
different policies and an audit trail must not show them as the same one.

---

## The ceiling is cumulative, and the window rolls

A per-transaction limit stops one large payment and does nothing about a thousand small ones. An
agent driven by someone else's text is not limited to one attempt, and the cheapest attack on a
per-transaction cap is a loop.

So ceilings are cumulative over a window of `[nowMs - periodMs, nowMs]`, inclusive at both ends —
excluding the boundary would open a one-millisecond hole a loop could be timed against. The window
**rolls**; a calendar period resetting at midnight has a moment an attacker can wait for and then
spend two full allowances across.

**On SUI, gas counts.** The node reports gas as an ordinary outflow: a one-MIST self-transfer
measured live produced a balance change of `-1088000`, essentially all of it gas. Set the SUI
ceiling high enough to cover it, and bound gas separately with `maxGasBudgetMist`.

### The ledger is an input, and the honest limitation

`LedgerState` is passed in. This package persists nothing — where spend is stored is a decision
with consequences a library cannot see. **The ceiling is therefore only as good as the caller's
record-keeping:** sign without recording the spend, and the next evaluation sees a smaller total.

The chain-level bound described in `@projectx-social/signer`'s README — funding the input coin at
the ceiling so `creator::take_price` physically cannot take more — does not depend on this ledger
and does not fail with it. That is the whole reason there are two bounds, and why they must stay
independent.

---

## Every rule fails closed

A rule that cannot decide — a malformed address, an unparseable amount, a name that does not
normalise, a command kind that did not exist when this was written — **refuses**. None of them
return "pass" on input they did not understand.

That is the property that makes an unrecognised future command kind, a renamed client-library
field, or a corrupted policy file a refusal rather than a signature.
