/**
 * 运行 pack:spike 产物，检查 FTS5 trigram 冒烟退出码。
 * Windows：PowerShell `& exe; exit $LASTEXITCODE`（Start-Process -Wait 对 Electron GUI 会挂起）。
 */
import { spawnSync } from 'child_process'
import { existsSync, readdirSync } from 'fs'
import { join } from 'path'

const spikeDir = join(process.cwd(), 'release', 'spike-s0')
const unpackedExe = join(spikeDir, 'win-unpacked', 'NovaAgent-Spike.exe')

let exePath = unpackedExe
if (!existsSync(exePath)) {
  const portable = existsSync(spikeDir)
    ? readdirSync(spikeDir).find((f) => f.endsWith('.exe'))
    : undefined
  if (!portable) {
    console.error('[pack:spike:verify] 未找到 exe，请先 npm run pack:spike')
    process.exit(1)
  }
  exePath = join(spikeDir, portable)
}

console.log('[pack:spike:verify] 运行:', exePath)

function runAndGetExitCode(target) {
  if (process.platform === 'win32') {
    const escaped = target.replace(/'/g, "''")
    const ps = spawnSync(
      'powershell',
      ['-NoProfile', '-Command', `& '${escaped}'; exit $LASTEXITCODE`],
      { stdio: 'inherit', timeout: 60_000 }
    )
    if (ps.error) {
      console.error('[pack:spike:verify] 启动失败:', ps.error.message)
      process.exit(1)
    }
    return ps.status ?? 1
  }

  const result = spawnSync(target, [], { stdio: 'inherit', timeout: 60_000 })
  if (result.error) {
    console.error('[pack:spike:verify] 启动失败:', result.error.message)
    process.exit(1)
  }
  return result.status ?? 1
}

const code = runAndGetExitCode(exePath)
if (code === 0) {
  console.log('[pack:spike:verify] 通过 ✓')
} else {
  console.error('[pack:spike:verify] 失败，退出码:', code)
  process.exit(code)
}
