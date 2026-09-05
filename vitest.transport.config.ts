import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: { include: ['tests/integration/model/transportHttpFaults.test.ts'] }
})
