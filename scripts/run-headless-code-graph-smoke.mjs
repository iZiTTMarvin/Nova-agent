import { spawnSync } from 'node:child_process'

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'

function run(command, args, env = process.env) {
  return spawnSync(command, args, {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32'
  }).status ?? 1
}

let result = 1
try {
  if (run(npmCommand, ['run', 'rebuild:native:node']) !== 0) process.exitCode = 1
  else if (run(npmCommand, ['run', 'build:headless']) !== 0) process.exitCode = 1
  else {
    result = run(process.execPath, ['scripts/harness_eval/smoke_headless.mjs'], {
      ...process.env,
      NOVA_TEST_CODE_GRAPH: '1'
    })
    process.exitCode = result
  }
} finally {
  // Electron 与 Node 的 ABI 不同；无论 smoke 成败都恢复桌面运行时。
  const restore = run(npmCommand, ['run', 'rebuild:native:electron'])
  if (restore !== 0) process.exitCode = restore
}

