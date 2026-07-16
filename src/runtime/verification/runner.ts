/**
 * 验证命令执行器
 *
 * 在工作目录下执行验证命令，采集输出，返回结构化结果。
 * 与 bashTool 共享类似的 exec 模式，但不引入 checkpoint 逻辑。
 */
import { exec, execFile } from 'child_process'
import { existsSync } from 'fs'
import { delimiter, dirname, join } from 'path'
import type { VerificationExecutionOptions, VerificationResult, VerificationCommandType } from './types'

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
  options?: VerificationExecutionOptions
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
        timeout: resolveTimeout(options)
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime
        const output = truncateOutput(combineOutput(stdout, stderr))

        const executionError = error as (NodeJS.ErrnoException & {
          code?: number
          killed?: boolean
          signal?: string
        }) | null
        const rawExitCode = executionError ? executionError.code ?? 1 : 0
        const exitCode = typeof rawExitCode === 'number' ? rawExitCode : 1
        const timedOut = Boolean(executionError?.killed && executionError.signal)

        finish({
          command,
          type,
          success: !error,
          output,
          exitCode: typeof exitCode === 'number' ? exitCode : 1,
          durationMs,
          ...(timedOut ? { timedOut: true } : {})
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
          durationMs: Date.now() - startTime,
          cancelled: true
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

/**
 * 执行已经拆分为 argv 的验证命令，不经过 shell 解释。
 * 受控工作流应使用此入口，避免参数中的命令替换或环境变量展开变成第二条命令。
 */
export function runVerificationExecutable(
  executable: string,
  args: string[],
  displayCommand: string,
  type: VerificationCommandType,
  workingDir: string,
  options?: VerificationExecutionOptions
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

    const invocation = resolveExecutableInvocation(executable, args)
    if (!invocation) {
      finish({
        command: displayCommand,
        type,
        success: false,
        output: `无法安全定位 ${executable} 的可执行入口`,
        exitCode: 1,
        durationMs: Date.now() - startTime
      })
      return
    }
    const child = execFile(
      invocation.executable,
      invocation.args,
      {
        cwd: workingDir,
        env: { ...process.env },
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true,
        ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
        timeout: resolveTimeout(options)
      },
      (error, stdout, stderr) => {
        const durationMs = Date.now() - startTime
        const output = truncateOutput(combineOutput(stdout, stderr))
        const executionError = error as (NodeJS.ErrnoException & {
          code?: number
          killed?: boolean
          signal?: string
        }) | null
        const rawExitCode = executionError ? executionError.code ?? 1 : 0
        const exitCode = typeof rawExitCode === 'number' ? rawExitCode : 1
        const timedOut = Boolean(executionError?.killed && executionError.signal)

        finish({
          command: displayCommand,
          type,
          success: !error,
          output,
          exitCode,
          durationMs,
          ...(timedOut ? { timedOut: true } : {})
        })
      }
    )

    child.stdin?.end()

    if (options?.abortSignal) {
      abortHandler = () => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 2000)
        finish({
          command: displayCommand,
          type,
          success: false,
          output: '验证已被取消',
          exitCode: null,
          durationMs: Date.now() - startTime,
          cancelled: true
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

function resolveExecutableInvocation(
  executable: string,
  args: string[]
): { executable: string; args: string[]; windowsVerbatimArguments?: boolean } | null {
  if (process.platform !== 'win32' || !/^(?:npm|npx|pnpm|yarn)$/i.test(executable)) {
    return { executable, args }
  }

  const manager = executable.toLowerCase()
  const nodeDir = dirname(process.execPath)
  const npmExecPath = process.env.npm_execpath
  const managerOnPath = resolvePackageManagerOnPath(manager)
  if (managerOnPath) {
    if (/\.cmd$/i.test(managerOnPath)) {
      const commandProcessor = process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
      if (existsSync(commandProcessor)) {
        return {
          executable: commandProcessor,
          args: ['/d', '/s', '/c', quoteWindowsCommand([managerOnPath, ...args])],
          windowsVerbatimArguments: true
        }
      }
    } else {
      return { executable: managerOnPath, args }
    }
  }
  const candidates = manager === 'npm'
    ? [npmExecPath, join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : manager === 'npx'
      ? [
          npmExecPath ? join(dirname(npmExecPath), 'npx-cli.js') : undefined,
          join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
        ]
      : [join(nodeDir, 'node_modules', 'corepack', 'dist', `${manager}.js`)]
  const cliPath = candidates.find((candidate): candidate is string =>
    typeof candidate === 'string' && existsSync(candidate)
  )
  if (!cliPath) return null
  return { executable: process.execPath, args: [cliPath, ...args] }
}

/**
 * 打包 Electron 不携带 npm-cli.js；Windows 上优先执行用户环境中真实可用的命令包装器。
 * 只接受 PATH 中的 .cmd/.exe 文件，避免通过 shell 解析命令文本。
 */
function resolvePackageManagerOnPath(manager: string): string | null {
  const pathValue = process.env.PATH ?? process.env.Path
  if (!pathValue) return null
  for (const directory of pathValue.split(delimiter)) {
    const root = directory.trim()
    if (!root) continue
    for (const extension of ['.cmd', '.exe', '']) {
      const candidate = join(root, `${manager}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function quoteWindowsCommand(argv: string[]): string {
  return `"${argv.map(arg => `"${arg.replace(/"/g, '""')}"`).join(' ')}"`
}

function resolveTimeout(options?: VerificationExecutionOptions): number {
  const timeoutMs = options?.timeoutMs
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS
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
