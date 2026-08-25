/**
 * bash 工具入口 — ToolExecutor 实现
 *
 * 与原有 bashTool.ts 的区别：
 * 1. 使用 `spawn(shell, args)` 替代 `exec(command)`，可控制 shell 类型
 * 2. 使用 `OutputAccumulator` 替代 `stdoutBuffer += chunk`，支持流式截断与临时文件溢出
 * 3. 前台等待有让出边界（默认 120s）：到点进程仍存活则登记为持久会话（processRegistry）
 *    并返回 ref，由 shell_session 工具续操作，而不是强制终止
 * 4. 新增 `workdir` 参数（相对路径），无需再写 `cd xxx && ...`
 * 5. 渐进式终止：Unix SIGTERM→3s→SIGKILL，Windows taskkill
 * 6. 工具描述按 shell 平台动态生成（参见 prompt.ts）
 * 7. 默认执行后端可替换：通过 `BashOperations` 接口注入（便于测试 / 远程执行）
 */
import { resolve } from 'path'
import { existsSync } from 'fs'
import { canonicalizeExistingPath, isPathWithinRoot } from '../../permissions/pathAccess'
import { readFile, stat } from 'fs/promises'
import type { ChildProcess } from 'child_process'
import type { ToolExecutor, ToolContext, ToolResult } from '../types'
import {
  snapshotWorkspace,
  snapshotMtimes,
  diffSnapshots,
  type WorkspaceSnapshot,
  type MtimeSnapshot
} from '../../checkpoints/snapshot'
import { join } from 'path'
import { getShellConfig, getShellEnv, killProcessTree, spawnShell, waitForChildProcess } from './shell'
import { OutputAccumulator } from './output-accumulator'
import { renderBashDescription } from './prompt'
import { OutputSink } from '../OutputSink'
import { sha256File, buildArtifactRef } from '../../artifacts/artifactRef'
import { processRegistry, ProcessSessionError } from '../../process'
import { StreamOutputSanitizer } from './outputSanitizer'
import type { BashOperations, BashToolParams } from './types'
import { resolveToolArg } from '../toolArgResolver'
import { isDestructiveBashCommand } from './classifyCommand'
import { acquireWriterLeaseOrConflict } from '../../workspace'

/** 前台等待边界：到点进程仍存活则登记为持久会话并返回 ref。模型不可见的时间旋钮一律不给。 */
const DEFAULT_YIELD_AFTER_MS = 120_000
// 宿主级覆盖（E2E / 运维），与 NOVA_STALL_DEBUG 等既有旋钮同类；不设置则用默认边界。
const envYieldMs = Number(process.env['NOVA_BASH_YIELD_BOUNDARY_MS'])
let yieldAfterMs =
  Number.isFinite(envYieldMs) && envYieldMs > 0 ? envYieldMs : DEFAULT_YIELD_AFTER_MS
let persistentShellEnabled = true

/**
 * 部署级开关（~/.nova/settings.json 的 persistentShellSessions）：关闭后退回旧语义——
 * 边界到点强制终止。删除条件：量化门数据与 E2E 稳定运行一个完整发布周期后移除开关。
 */
export function setPersistentShellEnabled(enabled: boolean): void {
  persistentShellEnabled = enabled
}

/** 仅供测试注入让出边界，避免真等 120 秒；恢复默认也调用它传入 120_000。 */
export function setBashYieldBoundaryForTests(ms: number): void {
  yieldAfterMs = ms
}

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
      // 模型残留传 timeout 会被静默忽略：validateAndRepairToolArgs 只遍历
      // args 与 schema.properties 的交集键，未声明的键不参与校验也不报错。
      command: {
        type: 'string',
        description: '要执行的 shell 命令'
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

    const { command, workdir } = params
    let cwd: string
    try {
      cwd = resolveWorkdir(context.workingDir, workdir)
    } catch (e) {
      return { success: false, output: '', error: (e as Error).message }
    }

    const shellConfig = getShellConfig(context.shellPath)
    const env = getShellEnv(context.binDirs ?? [])

    // 破坏性命令（写文件 / 删文件 / 改 git 等）需获取写者租约，
    // 避免并发 run 同时改同一工作区；纯读命令不获取，保持并发友好。
    // 透传 abortSignal：run 取消时立即出队，避免持租者释放后把租约授予已死掉的 run。
    if (isDestructiveBashCommand(command)) {
      const conflict = await acquireWriterLeaseOrConflict({
        runId: context.resourceOwnerRunId ?? context.runId,
        workspaceRoot: context.workspaceRoot ?? context.workingDir,
        abortSignal: context.abortSignal
      })
      if (conflict) return conflict
    }

    // 拍快照（如果存在 checkpointManager）
    const beforeSnapshot = context.checkpointManager
      ? await snapshotWorkspace(context.workingDir, { abortSignal: context.abortSignal })
      : null

    // 大输出优先落到会话 artifact 目录，便于 ArtifactStore 认领
    const targetDir = context.artifactStore && context.sessionId
      ? context.artifactStore.getArtifactsDir(context.sessionId)
      : undefined
    const accumulator = new OutputAccumulator({ targetDir })

    // 终止原因追踪
    let terminationReason: 'timeout' | 'cancelled' | null = null
    let exitCode: number | null = null
    const capturedChildRef: { child: ChildProcess | null } = { child: null }
    let execError: Error | null = null

    // 内部 AbortController：把"用户取消"和"边界强制终止"统一编码为 abort 事件
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

    // 输出喂送可切换：前台阶段进 accumulator；让出后改喂持久会话
    let feed: (chunk: Buffer) => void = (chunk) => accumulator.append(chunk)

    let yieldTimer: ReturnType<typeof setTimeout> | null = null
    const yieldPromise = new Promise<'yield'>(resolve => {
      yieldTimer = setTimeout(() => resolve('yield'), yieldAfterMs)
    })
    // 让出后的进程由 registry 与清理路径负责，finally 的兜底杀树守卫据此跳过
    let yielded = false

    // 选择执行后端
    const ops: BashOperations = defaultOperations ?? createLocalBashOperations(shellConfig)

    try {
      const execPromise = ops.exec(command, cwd, {
        onData: (chunk) => feed(chunk),
        signal: internalController.signal,
        env,
        onChild: (cp) => { capturedChildRef.child = cp }
      })
      // 让出路径在竞速胜出后可能先去做别的 await，原 promise 的拒绝若恰落在
      // 那个窗口会无人消费；先挂一个中性 catch，派生链各自另行处理。
      void execPromise.catch(() => {})

      // 与让出边界竞速：先退出走原收尾；到点仍存活则登记为持久会话
      const outcome = await Promise.race([
        execPromise.then(r => ({ kind: 'exit' as const, exitCode: r.exitCode })),
        yieldPromise.then(() => ({ kind: 'yield' as const }))
      ])

      if (outcome.kind === 'yield') {
        if (yieldTimer) {
          clearTimeout(yieldTimer)
          yieldTimer = null
        }
        const cp = capturedChildRef.child

        if (cp && (cp.exitCode !== null || cp.signalCode !== null)) {
          // 边界竞态：定时器触发时进程恰好已退出 → 不注册，按 exit 分支同一收尾内联交付
          const r = await execPromise.catch(() => null)
          exitCode = r?.exitCode ?? null
        } else if (internalController.signal.aborted || !persistentShellEnabled || !cp || !context.sessionId || !context.runId) {
          // 不登记：用户已取消（杀树进行中）/ 开关关闭 / 后端未暴露 child / 缺归属身份——退回边界强制终止
          if (terminationReason === null) terminationReason = 'timeout'
          internalController.abort()
          await execPromise.catch(() => null)
        } else {
          // 登记为持久会话。先同步切换喂送目标再收尾 accumulator：
          // closeTempFile 的 await 窗口内到达的输出进 backlog，绝不丢弃
          const sanitizer = new StreamOutputSanitizer()
          let backlog = ''
          let sessionTarget: ReturnType<typeof processRegistry.register> | null = null
          feed = (chunk) => {
            const text = sanitizer.push(chunk)
            if (sessionTarget) sessionTarget.append(text)
            else backlog += text
          }
          accumulator.finish()
          const preYieldSnapshot = accumulator.snapshot()
          const seed = StreamOutputSanitizer.sanitize(preYieldSnapshot.content)
          // 预让出窗口的溢出文件随之关闭；未认领的残留由启动 GC 按 nova-bash- 前缀清扫
          await accumulator.closeTempFile()

          try {
            const handle = processRegistry.register({
              owner: { sessionId: context.sessionId, runId: context.runId },
              source: (context.resourceOwnerRunId !== undefined && context.resourceOwnerRunId !== context.runId)
                ? 'subagent-run'
                : 'main-run',
              command,
              workdir: cwd,
              destructive: isDestructiveBashCommand(command),
              seedOutput: seed,
              killTree: () => killProcessTree(cp.pid ?? undefined),
              writeStdin: async (data) => { cp.stdin?.write(data) },
              interrupt: process.platform === 'win32'
                ? undefined
                : (() => { try { return cp.kill('SIGINT') } catch { return false } }),
              // 终结前排空净化器滞留的无尾换行行（REPL 提示符），由 registry 在 settle 前入账
              flushPendingOutput: () => sanitizer.flush(),
              child: cp,
              checkpointBaseline: beforeSnapshot
            })

            sessionTarget = handle
            if (backlog.length > 0) {
              handle.append(backlog)
              backlog = ''
            }
            execPromise.then(r => handle.settle(r.exitCode)).catch(() => handle.settle(null))
            yielded = true

            try {
              await recordSessionBoundary(handle.ref, context)
            } catch (e) {
              // 记账失败不阻断会话交付；基线保持原值，下次边界重记
              console.error('bash 会话边界 checkpoint 记账失败:', e)
            }

            const sessionId = context.sessionId
            const { page, state, exitCode: sessionExitCode } =
              processRegistry.readPage(handle.ref, sessionId)

            let output = page.text
            if (output.length === 0) output = '(尚无输出)'
            if (page.hasMore) {
              output += '\n[输出未读完，继续用 shell_session 的 read 动作读取]'
            }
            let artifactId: string | undefined
            if (page.spill) {
              const claimed = await claimSpillArtifact(page.spill, context)
              artifactId = claimed.artifactId
              if (claimed.line) output += `\n${claimed.line}`
            }
            // 让出前就已超阈值的输出同样按既有溢出管道认领，全文不因转会话而丢失
            if (preYieldSnapshot.truncated && preYieldSnapshot.fullOutputPath) {
              const preClaimed = await claimSpillArtifact(
                { path: preYieldSnapshot.fullOutputPath, totalBytes: preYieldSnapshot.totalBytes },
                context
              )
              artifactId = artifactId ?? preClaimed.artifactId
              if (preClaimed.line) output += `\n${preClaimed.line}`
            }
            output += state === 'running'
              ? `\n[进程仍在运行 ref: ${handle.ref} —— 用 shell_session 工具的 read 继续观察输出，write 写入输入（自带换行），stop 终止]`
              : `\n[进程已退出 ref: ${handle.ref}，可用 shell_session read 收取剩余输出]`

            return {
              success: true,
              output,
              processHandle: { ref: handle.ref, state },
              ...(state === 'exited' && sessionExitCode !== null ? { exitCode: sessionExitCode } : {}),
              ...(artifactId ? { artifactId } : {})
            }
          } catch (e) {
            if (!(e instanceof ProcessSessionError)) throw e
            // 容量超限：明确报错，不静默淘汰已登记的会话；退回边界终止语义收尾
            terminationReason = 'timeout'
            internalController.abort()
            await execPromise.catch(() => null)
            await recordCheckpoint(beforeSnapshot, context)
            const { output, artifactId, truncationMeta } = await buildOutputWithArtifact(
              preYieldSnapshot,
              context
            )
            return {
              success: false,
              output,
              error: e.message,
              ...(artifactId ? { artifactId } : {}),
              ...(truncationMeta ? { truncationMeta } : {})
            }
          }
        }
      } else {
        exitCode = outcome.exitCode
      }
    } catch (err) {
      // 兜底：exec 后端本身报错（如 spawn ENOENT）
      execError = err instanceof Error ? err : new Error(String(err))
    } finally {
      if (yieldTimer) {
        clearTimeout(yieldTimer)
        yieldTimer = null
      }
      // 兜底杀进程：后端未必响应 abort；让出后的进程归 registry 管，此处不得杀
      if (!yielded) {
        const cp = capturedChildRef.child
        if (cp && cp.exitCode === null && cp.signalCode === null) {
          void killProcessTree(cp.pid ?? undefined)
        }
      }
    }

    // 区分"exec 后端抛错"和"边界终止/取消"——后者通过 internalController.signal 走 kill 路径，
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
        await recordCheckpoint(beforeSnapshot, context)
        return composeResult(null, terminationReason, yieldAfterMs, snapshot, context)
      }
      // 非 abort 错误：spawn ENOENT 等
      accumulator.finish()
      await recordCheckpoint(beforeSnapshot, context)
      return { success: false, output: '', error: `命令执行失败: ${execError.message}` }
    }

    accumulator.finish()
    const snapshot = accumulator.snapshot()
    await accumulator.closeTempFile()

    await recordCheckpoint(beforeSnapshot, context)

    return composeResult(exitCode, terminationReason, yieldAfterMs, snapshot, context)
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
  | { command: string; workdir: string | undefined } {
  // 参数名别名兼容：command 可能被模型写成 cmd / shell / run
  const command = resolveToolArg(args, 'command') ?? ''
  if (!command.trim()) {
    return { error: '缺少 command 参数' }
  }
  const workdir = typeof args.workdir === 'string' && args.workdir.length > 0
    ? args.workdir
    : undefined
  return { command, workdir }
}

function resolveWorkdir(workingDir: string, workdir: string | undefined): string {
  if (!workdir) return workingDir
  const workspaceReal = canonicalizeExistingPath(workingDir)
  if (!workspaceReal.ok) {
    throw new Error(`工作区路径无法解析`)
  }
  const resolved = resolve(workingDir, workdir)
  const resolvedReal = canonicalizeExistingPath(resolved)
  if (!resolvedReal.ok) {
    throw new Error(`workdir "${workdir}" 不存在或无法解析`)
  }
  if (!isPathWithinRoot(workspaceReal.path, resolvedReal.path)) {
    throw new Error(`workdir "${workdir}" 逃逸工作区边界，已拒绝执行`)
  }
  return resolvedReal.path
}

async function recordCheckpoint(
  beforeSnapshot: WorkspaceSnapshot | null,
  context: ToolContext
): Promise<void> {
  if (!beforeSnapshot || !context.checkpointManager) return
  try {
    const afterMtimes = await snapshotMtimes(context.workingDir, { abortSignal: context.abortSignal })
    await recordCheckpointChanges(beforeSnapshot, afterMtimes, context)
  } catch (e) {
    console.error('bash 快照对比失败:', e)
  }
}

/** 把 baseline 与当前 mtimes 之间的改动喂给 checkpoint（提炼自原 recordCheckpoint，行为不变） */
export async function recordCheckpointChanges(
  baseline: WorkspaceSnapshot,
  mtimes: MtimeSnapshot,
  context: ToolContext
): Promise<void> {
  const checkpointManager = context.checkpointManager
  if (!checkpointManager) return
  const changes = diffSnapshots(baseline, mtimes)

  const deletedSet = new Set(changes.deleted)
  const addedSet = new Set(changes.added)
  const modifiedSet = new Set(
    changes.modified.filter(relPath => !deletedSet.has(relPath) && !addedSet.has(relPath))
  )
  for (const relPath of modifiedSet) {
    const entry = baseline.get(relPath)
    // entry.content 可能为 undefined（超大文件跳过内容读取），跳过 backup 但仍记录到 manifest
    if (entry) {
      checkpointManager.recordBashChange(
        join(context.workingDir, relPath),
        entry.content ?? Buffer.alloc(0),
        false
      )
    }
  }
  for (const relPath of addedSet) {
    checkpointManager.recordBashChange(
      join(context.workingDir, relPath),
      Buffer.alloc(0),
      true
    )
  }
  for (const relPath of deletedSet) {
    const entry = baseline.get(relPath)
    if (entry) {
      checkpointManager.recordBashChange(
        join(context.workingDir, relPath),
        entry.content ?? Buffer.alloc(0),
        false,
        true
      )
    }
  }
}

/** 与 checkpoints/snapshot.ts 的 MAX_SNAPSHOT_FILE_SIZE 同取舍：超大文件只记 mtime 不读内容 */
const CONTENT_SNAPSHOT_MAX_BYTES = 10 * 1024 * 1024

/**
 * 会话边界的滚动基线：为变化过的文件重读内容（>10MB 只记 mtime 不读内容），
 * 删除已删文件条目，其余原样保留（保留原 content 才能支撑后续回退备份）。
 */
export async function refreshCheckpointBaseline(
  baseline: WorkspaceSnapshot,
  mtimes: MtimeSnapshot,
  workingDir: string
): Promise<WorkspaceSnapshot> {
  const changes = diffSnapshots(baseline, mtimes)
  const deletedSet = new Set(changes.deleted)
  const changedSet = new Set([...changes.modified, ...changes.added])

  const next: WorkspaceSnapshot = new Map()
  for (const [relPath, entry] of baseline) {
    if (deletedSet.has(relPath) || changedSet.has(relPath)) continue
    next.set(relPath, entry)
  }
  for (const relPath of changedSet) {
    if (!mtimes.has(relPath)) continue
    const fullPath = join(workingDir, relPath)
    try {
      const fileStat = await stat(fullPath)
      if (fileStat.size > CONTENT_SNAPSHOT_MAX_BYTES) {
        next.set(relPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size })
        continue
      }
      const content = await readFile(fullPath)
      next.set(relPath, { content, mtimeMs: fileStat.mtimeMs, size: fileStat.size })
    } catch {
      // 滚动窗口内文件被删 / 不可读：不保留条目，下次 diff 视为新增
    }
  }
  return next
}

/**
 * 会话边界记账：记录 baseline 以来的改动并滚动基线存回 registry。
 * bash 让出路径的初始基线经 register 入参存入；之后每次 shell_session 调用都走这里。
 */
export async function recordSessionBoundary(ref: string, context: ToolContext): Promise<void> {
  const sessionId = context.sessionId ?? ''
  const baseline = processRegistry.getCheckpointBaseline(ref, sessionId)
  if (!baseline) return
  const mtimes = await snapshotMtimes(context.workingDir, { abortSignal: context.abortSignal })
  await recordCheckpointChanges(baseline, mtimes, context)
  const next = await refreshCheckpointBaseline(baseline, mtimes, context.workingDir)
  processRegistry.updateCheckpointBaseline(ref, sessionId, next)
}

async function composeResult(
  exitCode: number | null,
  terminationReason: 'timeout' | 'cancelled' | null,
  boundaryMs: number,
  snapshot: ReturnType<OutputAccumulator['snapshot']>,
  context?: ToolContext
): Promise<ToolResult> {
  const { output: outputWithPath, artifactId, truncationMeta } = await buildOutputWithArtifact(
    snapshot,
    context
  )

  if (terminationReason === 'timeout') {
    return {
      success: false,
      output: outputWithPath,
      error: `命令执行超时（${Math.round(boundaryMs / 1000)} 秒），已强制终止`,
      ...(exitCode !== null ? { exitCode } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(truncationMeta ? { truncationMeta } : {})
    }
  }
  if (terminationReason === 'cancelled') {
    return {
      success: false,
      output: outputWithPath,
      error: '命令已被用户取消',
      ...(exitCode !== null ? { exitCode } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(truncationMeta ? { truncationMeta } : {})
    }
  }
  if (exitCode === null) {
    return {
      success: false,
      output: outputWithPath,
      error: '命令未正常退出（可能因信号终止）',
      ...(artifactId ? { artifactId } : {}),
      ...(truncationMeta ? { truncationMeta } : {})
    }
  }
  if (exitCode !== 0) {
    // 命令已正常跑完，只是返回了非零退出码。这不等于"工具故障"——
    // grep/findstr 无匹配、where 未找到、构建报错等都属于业务结果，模型需要
    // 拿到完整 stdout/stderr 才能判断是正常结果还是真错误。
    //
    // 历史问题：这里曾返回 success:false，上层 toolBatchExecutor 在失败分支会丢弃
    // output、只把 "命令退出码: N" 喂给模型，导致模型看不到任何输出而盲目重试。
    // 现在统一按"工具执行成功、命令退出码非零"处理：保留完整输出 + 退出码标注，
    // 由模型自行判断。真正的工具故障（超时 / 取消 / 信号终止 / spawn 失败）仍走
    // success:false 分支。
    return {
      success: true,
      output: prependExitCodeNotice(outputWithPath, exitCode),
      exitCode,
      ...(artifactId ? { artifactId } : {}),
      ...(truncationMeta ? { truncationMeta } : {})
    }
  }
  return {
    success: true,
    output: outputWithPath || '(命令执行成功，无输出)',
    exitCode,
    ...(artifactId ? { artifactId } : {}),
    ...(truncationMeta ? { truncationMeta } : {})
  }
}

/**
 * 把会话溢出文件认领为 artifact。文件已不存在（此前认领被搬走 / 已清理）时返回空行；
 * 无 artifactStore 或认领失败时退化为本地路径提示。
 */
export async function claimSpillArtifact(
  spill: { path: string; totalBytes: number },
  context: ToolContext
): Promise<{ artifactId?: string; line: string | null }> {
  if (!existsSync(spill.path)) return { line: null }
  if (!context.artifactStore || !context.sessionId) {
    return { line: `[完整输出已溢出保存: ${spill.path}]` }
  }
  try {
    const sha256 = await sha256File(spill.path)
    const meta = await context.artifactStore.writeFromPath(context.sessionId, spill.path, {
      toolName: 'bash',
      truncated: true
    })
    return {
      artifactId: meta.id,
      line: `[完整输出已溢出保存: ${buildArtifactRef(meta.id, sha256, spill.totalBytes)}（本地文件 ${spill.path}）]`
    }
  } catch {
    return { line: `[完整输出已溢出保存: ${spill.path}]` }
  }
}

/**
 * 构建 bash 输出文本：有 artifactStore 时用 writeFromPath + formatNotice；
 * 否则保持旧的 [Full output saved to: ...] 兜底。
 */
async function buildOutputWithArtifact(
  snapshot: ReturnType<OutputAccumulator['snapshot']>,
  context?: ToolContext
): Promise<{
  output: string
  artifactId?: string
  truncationMeta?: ToolResult['truncationMeta']
}> {
  if (
    snapshot.truncated &&
    snapshot.fullOutputPath &&
    context?.artifactStore &&
    context.sessionId
  ) {
    const sha256 = await sha256File(snapshot.fullOutputPath)
    const meta = await context.artifactStore.writeFromPath(
      context.sessionId,
      snapshot.fullOutputPath,
      { toolName: 'bash', truncated: true }
    )
    const notice = OutputSink.formatNotice({
      totalLines: snapshot.totalLines,
      totalBytes: snapshot.totalBytes,
      shownLines: snapshot.outputLines,
      artifactId: meta.id,
      sha256,
      nextOffset: snapshot.outputLines + 1
    })
    const output = snapshot.content.length > 0 ? `${snapshot.content}\n${notice}` : notice
    return {
      output,
      artifactId: meta.id,
      truncationMeta: {
        totalBytes: snapshot.totalBytes,
        totalLines: snapshot.totalLines,
        shownLines: snapshot.outputLines,
        truncated: true
      }
    }
  }

  return {
    output: appendFullOutputPath(snapshot.content, snapshot.fullOutputPath)
  }
}

/**
 * 给"退出码非零但已正常跑完"的输出加一行退出码标注。
 *
 * 标注里显式说明"非 0 不一定是错误"，避免模型一看到非零就误判为工具故障、
 * 进而盲目换命令重试。完整 stdout/stderr 原样保留在标注下方。
 */
function prependExitCodeNotice(content: string, exitCode: number): string {
  const marker = `[命令退出码: ${exitCode}（命令已执行完成；非 0 不一定是错误，请阅读下方输出判断）]`
  if (content.length === 0) return `${marker}\n(无输出)`
  return `${marker}\n${content}`
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

export { isInteractiveEntryCommand } from './interactiveEntry'
