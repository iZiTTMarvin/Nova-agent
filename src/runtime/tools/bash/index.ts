/**
 * bash 工具入口 — ToolExecutor 实现
 *
 * 与原有 bashTool.ts 的区别：
 * 1. 使用 `spawn(shell, args)` 替代 `exec(command)`，可控制 shell 类型
 * 2. 使用 `OutputAccumulator` 替代 `stdoutBuffer += chunk`，支持流式截断与临时文件溢出
 * 3. 超时改为毫秒精度（默认 120s，最大 300s），对齐 Kilocode
 * 4. 新增 `workdir` 参数（相对路径），无需再写 `cd xxx && ...`
 * 5. 渐进式终止：Unix SIGTERM→3s→SIGKILL，Windows taskkill
 * 6. 工具描述按 shell 平台动态生成（参见 prompt.ts）
 * 7. 默认执行后端可替换：通过 `BashOperations` 接口注入（便于测试 / 远程执行）
 */
import { resolve, relative, isAbsolute } from 'path'
import type { ChildProcess } from 'child_process'
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import { snapshotWorkspace, snapshotMtimes, diffSnapshots } from '../../checkpoints/snapshot'
import { join } from 'path'
import { getShellConfig, getShellEnv, killProcessTree, spawnShell, waitForChildProcess } from './shell'
import { OutputAccumulator } from './output-accumulator'
import { renderBashDescription } from './prompt'
import type { BashOperations, BashToolParams } from './types'

/** 默认超时（毫秒）。 */
const DEFAULT_TIMEOUT_MS = 120_000
/** 最大超时（毫秒）。 */
const MAX_TIMEOUT_MS = 300_000

/**
 * 注入默认执行后端（用于测试 / 自定义环境）。
 * 传入 null 恢复为内建 spawn 后端。
 */
let defaultOperations: BashOperations | null = null

/**
 * 工具描述懒缓存。第一次访问 `bashTool.description` 时渲染，后续命中缓存。
 * `setBashEnvironment()` 会清空缓存让自定义 shellPath 生效。
 */
let descriptionCache: string | null = null

export function setBashOperations(ops: BashOperations | null): void {
  defaultOperations = ops
  descriptionCache = null
}

/** 清空描述缓存（在 shellPath / binDirs 变化时调用）。 */
export function invalidateBashDescriptionCache(): void {
  descriptionCache = null
}

/**
 * bash 工具 — 在工作区中执行 shell 命令
 *
 * 工具描述按 `ShellConfig.name + platform` 渲染，懒加载到 `description` getter。
 */
export const bashTool: ToolExecutor = {
  name: 'bash',
  /**
   * 工具描述：懒缓存。AgentLoop 每轮都会拉取工具定义，
   * 缓存可避免每次都重跑 Shell 发现（existsSync）。
   * `setBashEnvironment()` 会清空缓存，让自定义 shellPath 生效。
   */
  get description(): string {
    if (descriptionCache === null) {
      descriptionCache = renderBashDescription(getShellConfig().name, process.platform)
    }
    return descriptionCache
  },
  executionMode: 'sequential',
  maxResultSizeChars: 50_000,
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: '要执行的 shell 命令'
      },
      timeout: {
        type: 'number',
        description: '超时（毫秒），默认 120000（2 分钟），最大 300000（5 分钟）。'
      },
      workdir: {
        type: 'string',
        description: '相对于 workingDir 的工作目录（可选），不填则在 workingDir 执行。'
      },
      description: {
        type: 'string',
        description: '5-10 词的简短描述（可选），帮助 UI 展示。'
      }
    },
    required: ['command']
  },

  async execute(
    args: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolResult> {
    const params = parseBashParams(args)
    if ('error' in params) {
      return { success: false, output: '', error: params.error }
    }

    const { command, timeoutMs, workdir } = params
    let cwd: string
    try {
      cwd = resolveWorkdir(context.workingDir, workdir)
    } catch (e) {
      return { success: false, output: '', error: (e as Error).message }
    }

    const shellConfig = getShellConfig(context.shellPath)
    const env = getShellEnv(context.binDirs ?? [])

    // 拍快照（如果存在 checkpointManager）
    const beforeSnapshot = context.checkpointManager
      ? snapshotWorkspace(context.workingDir)
      : null

    // 收集子进程输出
    const accumulator = new OutputAccumulator()

    // 终止原因追踪
    let terminationReason: 'timeout' | 'cancelled' | null = null
    let exitCode: number | null = null
    const capturedChildRef: { child: ChildProcess | null } = { child: null }
    let execError: Error | null = null

    // 内部 AbortController：把"用户取消"和"超时"统一编码为 abort 事件
    const internalController = new AbortController()
    const userSignal = context.abortSignal

    if (userSignal) {
      if (userSignal.aborted) {
        terminationReason = 'cancelled'
        internalController.abort()
      } else {
        userSignal.addEventListener(
          'abort',
          () => {
            terminationReason = 'cancelled'
            internalController.abort()
          },
          { once: true }
        )
      }
    }

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null
    if (timeoutMs > 0 && !internalController.signal.aborted) {
      timeoutHandle = setTimeout(() => {
        terminationReason = 'timeout'
        internalController.abort()
      }, timeoutMs)
    }

    // 选择执行后端
    const ops: BashOperations = defaultOperations ?? createLocalBashOperations(shellConfig)

    try {
      const result = await ops.exec(command, cwd, {
        onData: (chunk) => accumulator.append(chunk),
        signal: internalController.signal,
        env,
        onChild: (cp) => { capturedChildRef.child = cp }
      })
      exitCode = result.exitCode
    } catch (err) {
      // 兜底：exec 后端本身报错（如 spawn ENOENT）
      execError = err instanceof Error ? err : new Error(String(err))
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      // 兜底杀进程：后端未必响应 abort；确保不留后台进程
      const cp = capturedChildRef.child
      if (cp && cp.exitCode === null && cp.signalCode === null) {
        void killProcessTree(cp.pid ?? undefined)
      }
    }

    // 区分"exec 后端抛错"和"超时/取消"——后者通过 internalController.signal 走 kill 路径，
    // spawn 自身会因 signal abort 而 reject（错误信息 "The operation was aborted"），
    // 我们需要把它映射回 terminationReason 对应的用户提示。
    if (execError) {
      const aborted = internalController.signal.aborted
      if (aborted) {
        // signal abort 路径 → 维持 terminationReason（'timeout' 或 'cancelled'）
        // exit code 用 null（进程未正常退出）
        accumulator.finish()
        const snapshot = accumulator.snapshot()
        await accumulator.closeTempFile()
        recordCheckpoint(beforeSnapshot, context)
        return composeResult(null, terminationReason, timeoutMs, snapshot)
      }
      // 非 abort 错误：spawn ENOENT 等
      accumulator.finish()
      recordCheckpoint(beforeSnapshot, context)
      return { success: false, output: '', error: `命令执行失败: ${execError.message}` }
    }

    accumulator.finish()
    const snapshot = accumulator.snapshot()
    await accumulator.closeTempFile()

    recordCheckpoint(beforeSnapshot, context)

    return composeResult(exitCode, terminationReason, timeoutMs, snapshot)
  }
}

/** 兼容导出：让老测试 / 外部代码可以拿到动态描述。 */
export function getBashDescription(context: { shellPath?: string } = {}): string {
  const cfg = getShellConfig(context.shellPath)
  return renderBashDescription(cfg.name, process.platform)
}

// ── 内部工具 ──────────────────────────────────────────

function parseBashParams(args: Record<string, unknown>):
  | { error: string }
  | { command: string; timeoutMs: number; workdir: string | undefined } {
  const command = typeof args.command === 'string' ? args.command : ''
  if (!command.trim()) {
    return { error: '缺少 command 参数' }
  }
  const timeoutMs = parseTimeout(args.timeout)
  const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
    ? args.workdir
    : undefined
  return { command, timeoutMs, workdir }
}

function resolveWorkdir(workingDir: string, workdir: string | undefined): string {
  if (!workdir) return workingDir
  // 边界校验：workdir 解析后必须仍在 workingDir 内，
  // 防止 workdir='/etc' 或 '../../..' 逃逸工作区造成破坏。
  // 注：path.relative 在 Windows 上对盘符大小写不敏感（C:\ 与 c:\ 视为同盘），
  // 因此无需对盘符大小写做特殊处理。
  const resolved = resolve(workingDir, workdir)
  const rel = relative(workingDir, resolved)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`workdir "${workdir}" 逃逸工作区边界，已拒绝执行`)
  }
  return resolved
}

function parseTimeout(value: unknown): number {
  if (typeof value === 'number' && value > 0) {
    return Math.min(value, MAX_TIMEOUT_MS)
  }
  return DEFAULT_TIMEOUT_MS
}

function recordCheckpoint(
  beforeSnapshot: ReturnType<typeof snapshotWorkspace> | null,
  context: ToolContext
): void {
  if (!beforeSnapshot || !context.checkpointManager) return
  try {
    const afterMtimes = snapshotMtimes(context.workingDir)
    const changes = diffSnapshots(beforeSnapshot, afterMtimes)

    const deletedSet = new Set(changes.deleted)
    const addedSet = new Set(changes.added)
    const modifiedSet = new Set(
      changes.modified.filter(relPath => !deletedSet.has(relPath) && !addedSet.has(relPath))
    )
    for (const relPath of modifiedSet) {
      const entry = beforeSnapshot.get(relPath)
      // entry.content 可能为 undefined（超大文件跳过内容读取），跳过 backup 但仍记录到 manifest
      if (entry) {
        context.checkpointManager.recordBashChange(
          join(context.workingDir, relPath),
          entry.content ?? Buffer.alloc(0),
          false
        )
      }
    }
    for (const relPath of addedSet) {
      context.checkpointManager.recordBashChange(
        join(context.workingDir, relPath),
        Buffer.alloc(0),
        true
      )
    }
    for (const relPath of deletedSet) {
      const entry = beforeSnapshot.get(relPath)
      if (entry) {
        context.checkpointManager.recordBashChange(
          join(context.workingDir, relPath),
          entry.content ?? Buffer.alloc(0),
          false,
          true
        )
      }
    }
  } catch (e) {
    console.error('bash 快照对比失败:', e)
  }
}

function composeResult(
  exitCode: number | null,
  terminationReason: 'timeout' | 'cancelled' | null,
  timeoutMs: number,
  snapshot: ReturnType<OutputAccumulator['snapshot']>
): ToolResult {
  const outputWithPath = appendFullOutputPath(snapshot.content, snapshot.fullOutputPath)

  if (terminationReason === 'timeout') {
    return {
      success: false,
      output: outputWithPath,
      error: `命令执行超时（${Math.round(timeoutMs / 1000)} 秒），已强制终止`
    }
  }
  if (terminationReason === 'cancelled') {
    return {
      success: false,
      output: outputWithPath,
      error: '命令已被用户取消'
    }
  }
  if (exitCode === null) {
    return {
      success: false,
      output: outputWithPath,
      error: '命令未正常退出（可能因信号终止）'
    }
  }
  if (exitCode !== 0) {
    return {
      success: false,
      output: outputWithPath,
      error: `命令退出码: ${exitCode}`
    }
  }
  return {
    success: true,
    output: outputWithPath || '(命令执行成功，无输出)'
  }
}

function appendFullOutputPath(content: string, path: string | undefined): string {
  if (!path) return content
  const tail = `\n[Full output saved to: ${path}]`
  if (content.length === 0) return tail.trimStart()
  return `${content}${tail}`
}

// ── 默认执行后端 ──────────────────────────────────────

/**
 * 内建的本地 shell 执行后端。
 *
 * 行为约定：
 * - 收到 `signal` abort → 立即调用 `killProcessTree(child.pid)` 杀整棵进程树
 * - 不区分"超时"和"用户取消"——上游通过是否 abort 自行判断
 * - 子进程的所有 stdout/stderr 都喂给 onData
 */
function createLocalBashOperations(shellConfig: ReturnType<typeof getShellConfig>): BashOperations {
  return {
    async exec(command, cwd, options) {
      const env = options.env ?? process.env
      const child = spawnShell(shellConfig, command, cwd, env, options.signal)
      options.onChild?.(child)

      let killed = false
      const killTree = () => {
        if (killed) return
        killed = true
        void killProcessTree(child.pid ?? undefined)
      }

      if (options.signal) {
        if (options.signal.aborted) {
          killTree()
        } else {
          options.signal.addEventListener('abort', killTree, { once: true })
        }
      }

      child.stdout?.on('data', (chunk: Buffer) => options.onData(chunk))
      child.stderr?.on('data', (chunk: Buffer) => options.onData(chunk))

      return new Promise<{ exitCode: number | null }>((resolve, reject) => {
        child.once('error', (err) => {
          if (options.signal) options.signal.removeEventListener('abort', killTree)
          reject(err)
        })

        waitForChildProcess(child)
          .then((code) => {
            if (options.signal) options.signal.removeEventListener('abort', killTree)
            resolve({ exitCode: code })
          })
          .catch((err) => {
            if (options.signal) options.signal.removeEventListener('abort', killTree)
            reject(err)
          })
      })
    }
  }
}

// 重新导出 BashToolParams 方便外部扩展
export type { BashToolParams }
