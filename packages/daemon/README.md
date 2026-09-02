# Harvest daemon

Calls `stake_vault::harvest` once per epoch per vault: withdraws matured tranches and stakes at
most one new rung. `harvest` is **permissionless** — it takes no capability, so this key can do
nothing except spend its own gas. A leak costs the float and nothing else.

## Run it

```bash
pnpm dry-run          # discovery, decoding and every decision, against mainnet. No key. No gas.
pnpm start            # in-process loop, for a foreground operator watching it work
node src/main.ts --once   # one tick, then exit — the mode to run under a supervisor
pnpm journal          # what it has actually been doing
```

`--dry-run` needs no signing key, no journal and no database. That is the mode to reach for first:
a daemon you cannot run harmlessly is one nobody verifies before pointing it at real money.

## Supervise it, do not loop it

The in-process loop exists for watching. In production run `--once` under something that restarts:
`deploy/projectx-harvest.service` + `.timer` for systemd, `deploy/io.protocolx.harvest.plist` for
launchd. The supervisor is better at restarting than this process is at not dying, and a crash under
`--once` costs one tick rather than every future one.

**Exit codes are the interface with the supervisor.**

| Code | Meaning | Restart? |
|---|---|---|
| 0 | tick completed, or a clean shutdown on a signal | on schedule |
| 1 | misconfigured | **no** — a human must change something |
| 2 | another instance holds the lock | **no** — this one is redundant |
| 3 | the run failed for a reason that may pass | yes |

`RestartPreventExitStatus=1 2` in the systemd unit is what stops a misconfigured daemon restarting
into a loop that looks like activity in the logs.

## The journal is not optional for a live run

Every tick is recorded to Postgres before it starts and updated when it finishes. A daemon spending
real gas with no record of what it did is one you can only trust, and nothing else in this system
asks to be trusted.

```bash
createdb projectx_daemon
psql -d projectx_daemon -f db/001_journal.sql
psql -d projectx_daemon -f db/002_audit_anchor.sql
```

**The gap between the two writes is the useful part.** A crash, an OOM kill or a power cut leaves a
row still marked `running`, and that is the only evidence afterwards that the daemon died mid-tick.
Without it, "crashed" and "never started" look identical, and they need different responses. The
next startup reports any it finds.

## The single-instance lock

Opening the journal takes a Postgres **session** advisory lock. A second daemon exits 2 rather than
running alongside.

This is a money guard, not a correctness one. `harvest` is permissionless and the contract refuses a
second rung in an epoch, so two instances cannot corrupt anything — the loser simply pays gas, every
tick, for a transaction that changes nothing. Supervisors make this *more* likely, because
restarting something that has not actually died is what supervisors do.

A session lock rather than a pid file, because the database releases it when the connection drops: a
crashed daemon frees it automatically, a hung one does not. Both are the behaviour you want. A pid
file survives the process that wrote it, so a machine that loses power leaves a lock nobody holds.

## What it will not do

- **It does not retry inside a tick.** A failed harvest is left for the next one, which re-reads
  state and decides again. Retrying would act on a snapshot already known to be stale — and since
  `harvest` is permissionless, the thing that "failed" may have been someone else succeeding first.
- **It does not cancel work at shutdown.** SIGTERM lets the tick finish, bounded by a 30s grace.
  Nothing here can safely interrupt a transaction that may already be in flight; killing between
  signing and executing leaves one whose fate is unknown.
- **It does not walk unbounded.** Discovery and the tick both have hard ceilings, and hitting one is
  reported as `truncated` rather than passed off as a complete list.

## Verified

Against mainnet, 15 Aug 2026, package `0xa7fd1540…14d`:

- dry run with no key, no journal, no gas — epoch 1220, 1 vault, decided skip
- live run, journalled, exit 0, recorded `1 seen / 0 harvested / 1 skipped`
- a second instance while the first ran: exit **2**, with the message explaining the gas cost
- SIGTERM during the hour-long sleep: woke early, shut down cleanly, exit 0
- `kill -9`: the advisory lock was released by the server, `pg_locks` back to 0
- a run left `running` was found and reported by the next startup

101 unit tests, 18 journal tests against real Postgres. Fourteen mutations run against the
supervisor and the journal; twelve killed. The two survivors are documented in place as
defence-in-depth rather than dressed up with tests that would not have caught anything.
