/**
 * bashTool — Shell 命令执行工具
 * 在工作目录下执行 shell 命令，采集 stdout/stderr 输出
 * 支持超时自动终止和取消信号
 */
import { exec, execFile } from 'child_process'
import type { ExecException } from 'child_process'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import { snapshotWorkspace, snapshotMtimes, diffSnapshots } from '../checkpoints/snapshot'
import { join } from 'path'

/** 默认超时时间（毫秒），防止命令无限运行 */
const DEFAULT_TIMEOUT = 30_000

export const bashTool: ToolExecutor = {
  name: 'bash',
  description:
    '在工作区中执行 shell 命令并返回输出。' +
    '支持运行构建、测试、lint 等开发命令。' +
    '注意：危险命令（sudo、rm -rf 等）会被权限系统拦截。',
  executionMode: 'sequential',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令'
      },
      timeout: {
        type: 'number',
        description: '超时时间（秒），默认 30 秒。超过后命令将被强制终止。'
      }
    },
    required: ['command']
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const command = args.command as string

    if (!command || !command.trim()) {
      return { success: false, output: '', error: '缺少 command 参数' }
    }

    const timeoutMs = parseTimeout(args.timeout)

    // bash 执行前：对工作区拍内容快照（用于对比 bash 造成的文件变更）
    const beforeSnapshot = context.checkpointManager
      ? snapshotWorkspace(context.workingDir)
      : null

    return new Promise<ToolResult>((resolve) => {
      let stdoutBuffer = ''
      let stderrBuffer = ''
      let settled = false
      let terminationReason: 'timeout' | 'cancelled' | null = null
      let abortHandler: (() => void) | null = null
      let fallbackTimer: ReturnType<typeof setTimeout> | null = null

      const timeoutHandle = setTimeout(() => {
        requestTermination('timeout')
      }, timeoutMs)

      const cleanup = () => {
        clearTimeout(timeoutHandle)
        if (fallbackTimer) {
          clearTimeout(fallbackTimer)
        }
        if (context.abortSignal && abortHandler) {
          context.abortSignal.removeEventListener('abort', abortHandler)
        }
      }

      const finish = (result: ToolResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      const child = exec(
        command,
        {
          cwd: context.workingDir,
          env: { ...process.env },
          maxBuffer: 10 * 1024 * 1024, // 10MB 输出缓冲
          windowsHide: true
        },
        (error: ExecException | null, stdout: string, stderr: string) => {
          // bash 执行完毕后：对比快照，将变更记录到 checkpoint
          if (beforeSnapshot && context.checkpointManager) {
            try {
              const afterMtimes = snapshotMtimes(context.workingDir)
              const changes = diffSnapshots(beforeSnapshot, afterMtimes)

              /**
               * 同一条 bash 命令里，文件可能先被修改、再被删除，或者新增后再次改写。
               * 这里按优先级去重，避免同一路径同时写进多个 manifest 列表。
               */
              const deletedSet = new Set(changes.deleted)
              const addedSet = new Set(changes.added)
              const modifiedSet = new Set(
                changes.modified.filter(relPath => !deletedSet.has(relPath) && !addedSet.has(relPath))
              )
              for (const relPath of modifiedSet) {
                const entry = beforeSnapshot.get(relPath)
                if (entry) {
                  context.checkpointManager.recordBashChange(
                    join(context.workingDir, relPath),
                    entry.content,
                    false
                  )
                }
              }
              for (const relPath of addedSet) {
                context.checkpointManager.recordBashChange(
                  join(context.workingDir, relPath),
                  '',
                  true
                )
              }
              for (const relPath of deletedSet) {
                const entry = beforeSnapshot.get(relPath)
                if (entry) {
                  context.checkpointManager.recordBashChange(
                    join(context.workingDir, relPath),
                    entry.content,
                    false,
                    true
                  )
                }
              }
            } catch (e) {
              // 快照对比失败不影响命令结果返回
              console.error('bash 快照对比失败:', e)
            }
          }

          const combinedOutput = combineOutput(
            stdoutBuffer || stdout || '',
            stderrBuffer || stderr || ''
          )

          if (terminationReason === 'timeout') {
            finish({
              success: false,
              output: combinedOutput,
              error: `命令执行超时（${timeoutMs / 1000} 秒），已强制终止`
            })
            return
          }

          if (terminationReason === 'cancelled') {
            finish({
              success: false,
              output: combinedOutput,
              error: '命令已被用户取消'
            })
            return
          }

          if (error) {
            finish({
              success: false,
              output: combinedOutput,
              error: error.message
            })
            return
          }

          finish({
            success: true,
            output: combinedOutput || '(命令执行成功，无输出)'
          })
        }
      )

      child.stdout?.setEncoding('utf8')
      child.stdout?.on('data', (chunk) => {
        stdoutBuffer += chunk
      })

      child.stderr?.setEncoding('utf8')
      child.stderr?.on('data', (chunk) => {
        stderrBuffer += chunk
      })

      // 关闭 stdin，防止命令等待输入
      child.stdin?.end()

      const requestTermination = (reason: 'timeout' | 'cancelled') => {
        if (terminationReason || settled) return
        terminationReason = reason

        void terminateProcessTree(child.pid).finally(() => {
          fallbackTimer = setTimeout(() => {
            const combinedOutput = combineOutput(stdoutBuffer, stderrBuffer)
            finish({
              success: false,
              output: combinedOutput,
              error: reason === 'timeout'
                ? `命令执行超时（${timeoutMs / 1000} 秒），已强制终止`
                : '命令已被用户取消'
            })
          }, 1500)
        })
      }

      // 监听取消信号，终止整个命令进程树
      if (context.abortSignal) {
        abortHandler = () => requestTermination('cancelled')
        if (context.abortSignal.aborted) {
          abortHandler()
          return
        }
        context.abortSignal.addEventListener('abort', abortHandler, { once: true })
      }
    })
  }
}

/** 终止命令对应的整个进程树，避免 shell 退出后子进程仍在后台继续运行 */
async function terminateProcessTree(pid: number | undefined): Promise<void> {
  if (!pid) return

  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      execFile(
        'taskkill',
        ['/pid', String(pid), '/t', '/f'],
        { windowsHide: true },
        () => resolve()
      )
    })
    return
  }

  const descendantPids = await listDescendantPids(pid)

  for (const childPid of descendantPids.reverse()) {
    try {
      process.kill(childPid, 'SIGKILL')
    } catch {
      // 子进程已经退出时忽略
    }
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // 进程已经退出时忽略
  }
}

/** 在类 Unix 平台上递归获取子进程树，用于逐层终止整个命令树 */
async function listDescendantPids(rootPid: number): Promise<number[]> {
  const queue = [rootPid]
  const descendants: number[] = []

  while (queue.length > 0) {
    const currentPid = queue.shift()
    if (currentPid === undefined) break

    const directChildren = await listDirectChildPids(currentPid)
    descendants.push(...directChildren)
    queue.push(...directChildren)
  }

  return descendants
}

async function listDirectChildPids(pid: number): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      ['-o', 'pid=', '--ppid', String(pid)],
      { windowsHide: true },
      (_error, stdout) => {
        const pids = stdout
          .split('\n')
          .map(line => Number.parseInt(line.trim(), 10))
          .filter(Number.isFinite)
        resolve(pids)
      }
    )
  })
}

/** 合并 stdout 和 stderr */
function combineOutput(stdout: string, stderr: string): string {
  const parts: string[] = []
  if (stdout.trim()) parts.push(stdout.trim())
  if (stderr.trim()) parts.push(`[stderr] ${stderr.trim()}`)
  return parts.join('\n')
}

/** 解析超时参数（秒 → 毫秒） */
function parseTimeout(value: unknown): number {
  if (typeof value === 'number' && value > 0) {
    return Math.min(value * 1000, 300_000) // 最大 5 分钟
  }
  return DEFAULT_TIMEOUT
}
