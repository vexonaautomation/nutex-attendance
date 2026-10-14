import { defineConfig } from 'vitest/config';
import path from 'node:path';
const r = (p: string) => path.resolve(__dirname, p);
export default defineConfig({
  resolve: {
    alias: {
      '@nutex/types': r('packages/types/src/index.ts'),
      '@nutex/validation': r('packages/validation/src/index.ts'),
      '@nutex/formula-specs': r('packages/formula-specs/src/index.ts'),
      '@nutex/sheet-connector': r('packages/sheet-connector/src/index.ts'),
      '@nutex/drive-connector': r('packages/drive-connector/src/index.ts'),
      '@nutex/report-engine': r('packages/report-engine/src/index.ts'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'apps/*/tests/**/*.test.ts', 'packages/*/tests/**/*.test.ts'],
    // every worker holds a spreadsheet formula engine in memory: fewer workers keep a normal laptop from swapping (worker RPC timeouts)
    pool: 'forks',
    poolOptions: { forks: { maxForks: 4, minForks: 1 } },
    testTimeout: 60000,
    hookTimeout: 120000,
  },
});
