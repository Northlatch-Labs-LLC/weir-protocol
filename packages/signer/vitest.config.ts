// Built-by: @projectx.sui · Co-authored-by: Kaela <kaela@projectxprotocol.dev>
import { defineConfig } from 'vitest/config';

/*
  This file exists for one reason: `globalSetup`. The include pattern below is what vitest was
  already discovering by default, written down so adding the hook does not silently change which
  files run.

  `@projectx-social/sdk` is consumed as compiled JavaScript and its `dist` is gitignored, so it
  survives a branch switch holding another commit's behaviour. The root `test` script rebuilds it
  first; `npx vitest run` inside this package does not, and that is the ordinary way to run one
  package's tests while working on it. See `scripts/sdk-freshness.mjs`.
*/
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../scripts/sdk-freshness.mjs'],
  },
});
