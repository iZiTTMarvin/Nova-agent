import type { HostFns } from '../../host'
import type { VerifyResult, VerificationCheck } from './types'

export const VERIFY_COMMANDS = [
  { name: 'typecheck', command: 'npx tsc --noEmit' },
  { name: 'test', command: 'npx vitest run' },
  { name: 'build', command: 'npm run build' }
] as const

function evidence(stdout: string, stderr: string): string {
  const combined = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  if (combined.length <= 8_000) return combined || '无输出'
  return `${combined.slice(0, 7_999)}…`
}

export async function runVerify(host: HostFns): Promise<VerifyResult | null> {
  host.progress('verify', 'started')
  const checks: VerificationCheck[] = []

  for (const command of VERIFY_COMMANDS) {
    host.progress('verify', 'info', { message: `执行 ${command.name}: ${command.command}` })
    let result: Awaited<ReturnType<HostFns['bash']>>
    try {
      result = await host.bash(command.command)
    } catch (error) {
      result = {
        exitCode: -1,
        stdout: '',
        stderr: error instanceof Error ? error.message : String(error)
      }
    }
    const check: VerificationCheck = {
      name: command.name,
      command: command.command,
      exitCode: result.exitCode,
      passed: result.exitCode === 0,
      evidence: evidence(result.stdout, result.stderr)
    }
    checks.push(check)
    host.log(`${command.name}: ${check.passed ? 'pass' : 'fail'}\n${check.evidence}`)
  }

  const failedChecks = checks.filter((check) => !check.passed).map((check) => check.name)
  const result: VerifyResult = {
    passed: failedChecks.length === 0,
    checks,
    failedChecks
  }
  host.progress('verify', result.passed ? 'completed' : 'failed', {
    message: result.passed
      ? 'typecheck、test、build 全部通过'
      : `失败检查：${failedChecks.join('、')}`
  })
  return result
}
