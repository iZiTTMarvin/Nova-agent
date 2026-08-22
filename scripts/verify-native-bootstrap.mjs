/** dev 启动前验证 Electron 与原生数据库绑定均已安装且 ABI 匹配。 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
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
if (missing.length > 0) {
  console.error('[verify-native-bootstrap] 原生依赖缺失：')
  for (const item of missing) {
    console.error(`  缺失：${item.path}`)
    console.error(`  修复：${item.fix}`)
  }
  process.exit(1)
}

const probeSource = [
  "process.stdout.write('Electron ' + process.versions.electron + ' (ABI ' + process.versions.modules + ')\\n')",
  "const Database = require('better-sqlite3')",
  "const database = new Database(':memory:')",
  'database.close()'
].join(';')
const probe = spawnSync(require('electron'), ['-e', probeSource], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  encoding: 'utf8',
  windowsHide: true
})

if (probe.status !== 0) {
  const runtime = (probe.stdout ?? '').trim() || '当前 Electron'
  const details = `${probe.error?.message ?? ''}\n${probe.stderr ?? ''}`.trim()
  const mismatch = /NODE_MODULE_VERSION (\d+)[\s\S]*NODE_MODULE_VERSION (\d+)/.exec(details)
  console.error(`[verify-native-bootstrap] ${runtime} 无法加载 better-sqlite3。`)
  if (mismatch) {
    console.error(`  当前原生绑定 ABI：${mismatch[1]}；Electron 需要 ABI：${mismatch[2]}`)
  } else if (details) {
    console.error(`  原因：${details.split(/\r?\n/).find((line) => line.trim())}`)
  }
  console.error('  修复：npm run rebuild:native:electron')
  process.exit(1)
}
