// Built-by: @projectx.sui · Co-authored-by: Claude
import { defineConfig } from 'vitest/config';

/*
  The default suite: pure logic, config parsing, mirrored constants, supervisor behaviour. No
  network, no database — so a developer with neither still gets a meaningful run, and an outage in
  either cannot turn into a failing suite that people learn to ignore.

  `*.chain.test.ts` needs mainnet   → pnpm test:chain
  `*.db.test.ts`    needs Postgres  → pnpm test:db
*/
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/**/*.chain.test.ts', 'test/**/*.db.test.ts'],
    // Rebuild the SDK if its `dist` is stale. See `scripts/sdk-freshness.mjs` — this daemon signs
    // mainnet transactions, so testing it against a build from another commit is the worst case.
    globalSetup: ['../../scripts/sdk-freshness.mjs'],
  },
});
