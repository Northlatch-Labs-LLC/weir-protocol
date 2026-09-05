-- Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
-- 002: the audit chain's head, anchored per run.
--
-- # Why the head hash lives here and not in the log file
--
-- The harvest signer records every decision — each harvest it signed and each transaction it
-- refused — in a hash-chained audit log. A chain catches an edit, a reorder or a deletion of any
-- entry, because every entry commits to the one before it. It does NOT catch somebody who rewrites
-- the whole chain and recomputes every hash, because nothing outside the chain remembers what the
-- head used to be. This table is that outside memory: one row per run, written by the daemon into a
-- database the daemon process does not administer, holding the head at the end of the run and how
-- many decisions led to it. A chain presented later that does not end at the recorded head, or
-- holds a different count, is not the chain this run produced.
--
-- # Additive
--
-- A new table with a foreign key to the run. Nothing in 001 changes; a daemon built before this
-- migration keeps working against a database that has it, and a database without it makes the
-- anchor write fail loudly rather than the harvest fail at all (the harvest is already done and
-- journaled by then — see the order of writes in src/index.ts).

CREATE TABLE IF NOT EXISTS daemon_audit_anchors (
  run_id         bigint  PRIMARY KEY REFERENCES daemon_runs (id) ON DELETE CASCADE,
  -- The signer whose chain this is. Recorded so a chain can be matched to a key, never the key.
  signer         text    NOT NULL,
  -- 64 lowercase hex characters: sha256 of the last entry, or the genesis value of 64 zeros when
  -- the run decided nothing. A row with any other shape is not a head and is refused here.
  head_hash      text    NOT NULL CHECK (head_hash ~ '^[0-9a-f]{64}$'),
  entries        integer NOT NULL CHECK (entries >= 0),
  -- Whether the chain verified from genesis to head at the moment it was anchored. An anchor of a
  -- chain that already failed verification is still worth writing — it says so.
  intact         boolean NOT NULL,
  recorded_at_ms bigint  NOT NULL,

  -- Zero decisions can only end at genesis, and a non-empty chain never does.
  CONSTRAINT empty_chains_end_at_genesis CHECK (
    (entries = 0) = (head_hash = repeat('0', 64))
  )
);
