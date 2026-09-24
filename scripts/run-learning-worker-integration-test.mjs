/**
 * 学习 DB Worker 集成测试：Node ABI 重编 → vitest → 恢复 Electron ABI。
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
    ['exec', '--', 'vitest', 'run', '--config', 'vitest.learning-worker.config.ts'],
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
}

process.exit(exitCode)
