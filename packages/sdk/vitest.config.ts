// Built-by: @projectx.sui /|\ · Co-authored-by: Claude
import { defineConfig } from 'vitest/config';

// Chain tests are excluded here and run separately via `pnpm test:chain`. They need mainnet and
// would otherwise turn a network outage into a failing unit-test suite — which teaches everyone
// to ignore the suite.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['test/**/*.chain.test.ts'] },
});
