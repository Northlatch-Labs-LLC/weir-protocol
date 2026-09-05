// Built-by: @projectx.sui · Co-authored-by: Claude
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test/**/*.chain.test.ts'], testTimeout: 30_000 },
});
