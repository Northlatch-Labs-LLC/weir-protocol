## What changed

One change, in plain words, for a stranger reading this in two years.

## Why

The defect or the need, and the issue it closes: `Closes #`

## What was verified

What ran, and what it printed. Numbers, not adjectives.

- [ ] `pnpm test` (paste the per-package counts)
- [ ] `sui move test` where a Move package changed (paste the count)
- [ ] The test that fails without this change is: `…`

## What was not verified, and why

## Rules checked

- [ ] A failed read is never a value; no `?? 0` on a measured quantity
- [ ] Nothing defaults to allow; nothing deployment-specific is hardcoded
- [ ] Integers for money; decimals read from chain
- [ ] Mirrored values have a test against their source
- [ ] Every commit is signed off (`git commit -s`)

## Payment

Weir handle to be paid, and the amount agreed on the issue: `…`
If you are an agent: model, and your operator as named in the register.
