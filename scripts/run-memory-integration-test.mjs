/**
 * 记忆集成测试包装：Node ABI 重编 → 跑 vitest → finally 恢复 Electron ABI。
 * 集成测试失败时也必须恢复，避免 better-sqlite3 停在 Node ABI 导致 dev 报 NODE_MODULE_VERSION。
 */
import { spawnSync } from 'child_process'

const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const shell = process.platform === 'win32'

function runNodeScript(scriptPath) {
  const result = spawnSync(process.execPath, [scriptPath], { stdio: 'inherit' })
  return result.status ?? 1
}

function runNpm(scriptName, extraArgs = []) {
  const result = spawnSync(npmCmd, ['run', scriptName, ...extraArgs], {
    stdio: 'inherit',
    shell
  })
  return result.status ?? 1
}

function runVitestIntegration() {
  const result = spawnSync(
    npmCmd,
    ['exec', '--', 'vitest', 'run', '--config', 'vitest.memory-integration.config.ts'],
    { stdio: 'inherit', shell }
  )
  return result.status ?? 1
}

let exitCode = 0

try {
  exitCode = runNodeScript('scripts/rebuild-better-sqlite3-node.mjs')
  if (exitCode !== 0) {
    process.exit(exitCode)
  }

  exitCode = runVitestIntegration()
} finally {
  const rebuildCode = runNpm('rebuild:native:electron')
  if (exitCode === 0 && rebuildCode !== 0) {
    exitCode = rebuildCode
  }
  console.log(
    rebuildCode === 0
      ? '[test:memory-integration] 已恢复 Electron ABI'
      : '[test:memory-integration] 警告：恢复 Electron ABI 失败，请手动 npm run rebuild:native:electron'
  )
}

process.exit(exitCode)
