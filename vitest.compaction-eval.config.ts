import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

process.env.NODE_ENV = 'development'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@runtime': resolve('src/runtime'),
      '@main': resolve('src/main'),
      '@renderer': resolve('src/renderer')
    }
  },
  test: {
    include: ['tests/eval/compaction/**/*.test.ts'],
    sequence: { concurrent: false }
  }
})
