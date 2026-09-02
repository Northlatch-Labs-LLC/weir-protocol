// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
import { defineConfig } from 'vitest/config';

/*
  Journal tests. They need a real Postgres, because the thing being tested is a *database*
  behaviour — a session advisory lock released on disconnect — that no mock can exhibit. A fake
  lock that returns true would pass every test here and let two daemons run.

  Run separately so a developer without Postgres still gets the unit suite, and so a database
  outage does not turn into a failing unit suite people learn to ignore.

    createdb projectx_daemon_test
    psql -d projectx_daemon_test -f db/001_journal.sql
    psql -d projectx_daemon_test -f db/002_audit_anchor.sql
    PROJECTX_DAEMON_TEST_DATABASE_URL=… pnpm test:db
*/
export default defineConfig({
  test: { include: ['test/**/*.db.test.ts'], fileParallelism: false, testTimeout: 20_000 },
});
