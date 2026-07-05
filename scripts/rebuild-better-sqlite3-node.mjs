/**
 * 将 better-sqlite3 重编为当前系统 Node ABI（供 test:memory-integration 使用）。
 * 执行后需再跑 rebuild:native:electron 恢复 Electron ABI。
 */
import { spawnSync } from 'child_process'

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npmCmd, ['rebuild', 'better-sqlite3'], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

if (result.status !== 0) {
  process.exit(result.status ?? 1)
}

console.log('[rebuild:native:node] better-sqlite3 已按当前 Node ABI 重编')
