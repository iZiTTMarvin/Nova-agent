import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

// 测试必须使用 React development build：
// react 19.2 的 `act` 只存在于 development 构建；若宿主环境 NODE_ENV=production，
// react 会加载 production build 导致 `act is not a function`。
// 在 vitest 配置加载前固定为 development，不依赖调用方环境。
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
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // 集成测试与记忆评测加载 better-sqlite3 原生模块，仅由 test:memory-integration 执行；Electron E2E 由 Playwright 独立执行；
    // live 是 key 门控的真实 API 缓存门禁，仅由 test:live-cache 显式执行。
    exclude: ['tests/integration/**', 'tests/eval/**', 'tests/e2e/**', 'tests/live/**']
  }
})
