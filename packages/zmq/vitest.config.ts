import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // pnpm runs each package's tests in parallel, and Vitest's default module
    // cache is shared at the workspace root, where concurrent runs can race.
    fsModuleCachePath: fileURLToPath(new URL('./node_modules/.vitest-cache', import.meta.url)),
    environment: 'node',
    include: ['test/**/*.{test,spec}.ts'],
    exclude: ['node_modules', 'lib', 'test/regtest/**'],
    // Two packages run at once; keep the workspace at four workers in total.
    maxWorkers: 2,
  },
})
