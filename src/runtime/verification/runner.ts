/**
 * 验证命令执行器
 *
 * 在工作目录下执行验证命令，采集输出，返回结构化结果。
 * 与 bashTool 共享类似的 exec 模式，但不引入 checkpoint 逻辑。
 */
import { exec } from 'child_process'
import type { VerificationResult, VerificationCommandType } from './types'

/** 验证命令默认超时 60 秒 */
const DEFAULT_TIMEOUT_MS = 60_000

/** 最大输出截断长度，避免超长日志污染 */
const MAX_OUTPUT_LENGTH = 4000

/**
 * 执行验证命令
 *
 * @param command 要执行的 shell 命令
 * @param type 命令类型（test/lint/build）
 * @param workingDir 工作目录
 * @param options 可选的 abortSignal
 * @returns 结构化验证结果
 */
export function runVerificationCommand(
  command: string,
  type: VerificationCommandType,
  workingDir: string,
  options?: { abortSignal?: AbortSignal }
): Promise<VerificationResult> {
  return new Promise((resolve) => {
    const startTime = Date.now()
    let settled = false
    let abortHandler: (() => void) | null = null

    const finish = (result: VerificationResult) => {
      if (settled) return
      settled = true
      if (options?.abortSignal && abortHandler) {
        options.abortSignal.removeEventListener('abort', abortHandler)
      }
      resolve(result)
    }

    const child = exec(
      command,
      {
        cwd: workingDir,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        timeout: DEFAULT_TIMEOUT_MS
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime
        const output = truncateOutput(combineOutput(stdout, stderr))

        const exitCode = error ? (error as NodeJS.ErrnoException & { code?: number }).code ?? 1 : 0

        finish({
          command,
          type,
          success: !error,
          output,
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          durationMs
        })
      }
    )

    child.stdin?.end()

    if (options?.abortSignal) {
      abortHandler = () => {
        child.kill('SIGTERM')
        setTimeout(() => {
          child.kill('SIGKILL')
        }, 2000)

        finish({
          command,
          type,
          success: false,
          output: '验证已被取消',
          exitCode: null,
          durationMs: Date.now() - startTime
        })
      }

      if (options.abortSignal.aborted) {
        abortHandler()
        return
      }

      options.abortSignal.addEventListener('abort', abortHandler, { once: true })
    }
  })
}

function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = []
  if (stdout.trim()) parts.push(stdout.trim())
  if (stderr.trim()) parts.push(`[stderr] ${stderr.trim()}`)
  return parts.join('\n')
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_LENGTH) return output
  return output.slice(0, MAX_OUTPUT_LENGTH) + '\n...(输出过长，已截断)'
}
