import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// 真实 API 缓存门禁：显式运行（npm run test:live-cache）、key 门控、会花钱。
// 与默认套件完全隔离；无 key 的 provider 自动跳过。
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
    include: ['tests/live/**/*.spec.ts'],
    testTimeout: 300_000,
    hookTimeout: 60_000,
    // 真实网络请求不模拟计时；顺序执行便于阅读请求序列
    sequence: { concurrent: false }
  }
})
