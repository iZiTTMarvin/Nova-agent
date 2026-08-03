/**
 * dev 启动自校验：node_modules 重建若跳过 lifecycle scripts（--ignore-scripts、
 * 宿主环境异常等），electron 二进制与 better-sqlite3 原生绑定会静默缺失，
 * 运行期表现为难懂的 native bindings 堆栈。在 dev 入口最早处失败并给出精确修复命令。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const checks = [
  {
    path: join(root, 'node_modules', 'electron', 'path.txt'),
    fix: 'node node_modules/electron/install.js'
  },
  {
    path: join(root, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
    fix: 'npm run rebuild:native:electron'
  }
]

const missing = checks.filter((check) => !existsSync(check.path))
if (missing.length === 0) {
  process.exit(0)
}

console.error('[verify-native-bootstrap] 原生依赖缺失（node_modules 重建时 lifecycle scripts 可能被跳过）：')
for (const item of missing) {
  console.error(`  缺失：${item.path}`)
  console.error(`  修复：${item.fix}`)
}
process.exit(1)
