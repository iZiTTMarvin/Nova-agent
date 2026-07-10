#!/usr/bin/env node
/**
 * CI 可调用的 perf 门禁入口。
 * 运行 tests/perf 下 harness；失败时 process.exit(1)。
 *
 * 用法：npm run test:perf
 * 环境变量见 perfBudget.ts（NOVA_PERF_COMMIT_P95_MS 等）。
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

const child = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'tests/perf'],
  {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      // 明确标记：本进程为 perf 门禁，便于日志过滤
      NOVA_PERF_GATE: '1'
    }
  }
)

child.on('exit', (code) => {
  process.exit(code ?? 1)
})
