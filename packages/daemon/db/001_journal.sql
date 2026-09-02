-- Built-by: @projectx.sui /|\ · Co-authored-by: Claude
-- The harvest daemon's run journal.
--
-- # Why a daemon that spends gas needs one
--
-- Without it, "is it running?" is answered by looking at a terminal, and "did it harvest vault X
-- last epoch?" cannot be answered at all. A process that signs mainnet transactions unattended and
-- keeps no record is one you have to trust rather than check — and the whole point of the rest of
-- this system is that nothing has to be trusted.
--
-- # A run is written twice, and the gap between the writes is the useful part
--
-- A row is inserted when a tick starts, with outcome 'running', and updated when it ends. So a
-- crash, an OOM kill or a power cut leaves a 'running' row behind, and a stale one is the signal
-- that the daemon died mid-tick. There is no other way to distinguish "crashed" from "never
-- started" after the fact, and they need different responses.

CREATE TABLE IF NOT EXISTS daemon_runs (
  id                  bigserial PRIMARY KEY,
  started_at_ms       bigint  NOT NULL,
  ended_at_ms         bigint,
  mode                text    NOT NULL CHECK (mode IN ('live', 'dry-run')),
  -- The signer's address, never its key. Recorded so a journal read shows which key was spending.
  signer              text    NOT NULL,
  epoch               bigint,
  vaults_seen         integer NOT NULL DEFAULT 0,
  harvested           integer NOT NULL DEFAULT 0,
  skipped             integer NOT NULL DEFAULT 0,
  failed              integer NOT NULL DEFAULT 0,
  -- Both ceilings are recorded, always. A partial list treated as complete is how the newest
  -- vaults stop being harvested with nothing going red.
  discovery_truncated boolean NOT NULL DEFAULT false,
  tick_truncated      boolean NOT NULL DEFAULT false,
  outcome             text    NOT NULL CHECK (outcome IN ('running', 'ok', 'failed')),
  failure_kind        text,
  failure_detail      text,

  -- A finished run must say how it finished, and an unfinished one must not pretend to have.
  CONSTRAINT finished_runs_are_complete CHECK (
    outcome = 'running' OR ended_at_ms IS NOT NULL
  ),
  CONSTRAINT failed_runs_say_why CHECK (
    outcome <> 'failed' OR (failure_kind IS NOT NULL AND failure_detail IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS daemon_runs_started_idx ON daemon_runs (started_at_ms DESC);
-- Finding a stuck run is the commonest health query, so it gets its own partial index rather than
-- scanning history that grows forever.
CREATE INDEX IF NOT EXISTS daemon_runs_running_idx
  ON daemon_runs (started_at_ms DESC) WHERE outcome = 'running';

-- Per-vault outcomes. One row per vault per run, so "when did this vault last harvest, and what
-- did it decide the other times" is a query rather than a grep through logs that have rotated.
CREATE TABLE IF NOT EXISTS daemon_harvests (
  run_id   bigint NOT NULL REFERENCES daemon_runs (id) ON DELETE CASCADE,
  vault_id text   NOT NULL,
  epoch    bigint NOT NULL,
  -- 'harvested' | 'skipped' | 'failed', matching the engine's three outcomes exactly. A vault that
  -- could not be read is NOT a vault with nothing to do, and merging them loses that.
  outcome  text   NOT NULL CHECK (outcome IN ('harvested', 'skipped', 'failed')),
  reason   text   NOT NULL,
  digest   text,
  error    text,
  at_ms    bigint NOT NULL,

  PRIMARY KEY (run_id, vault_id),

  -- A harvest that claims success must name the transaction, or it is a claim nobody can check.
  CONSTRAINT harvests_name_their_transaction CHECK (
    outcome <> 'harvested' OR digest IS NOT NULL
  ),
  CONSTRAINT failures_say_why CHECK (outcome <> 'failed' OR error IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS daemon_harvests_vault_idx ON daemon_harvests (vault_id, at_ms DESC);
