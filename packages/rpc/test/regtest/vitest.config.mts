import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

// The live regtest smoke test; scripts/regtest-smoke.sh starts the node and runs this.
export default defineConfig({
  test: {
    fsModuleCachePath: fileURLToPath(new URL('../../node_modules/.vitest-cache', import.meta.url)),
    environment: 'node',
    root: fileURLToPath(new URL('../..', import.meta.url)),
    include: ['test/regtest/**/*.test.ts'],
    testTimeout: 60_000,
    maxWorkers: 1,
  },
})
