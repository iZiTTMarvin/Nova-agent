import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

/** 记忆 FTS5 集成测试专用配置（加载 better-sqlite3 原生模块） */
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
    include: ['tests/integration/**/*.test.ts']
  }
})
