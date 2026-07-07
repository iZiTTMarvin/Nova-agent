/**
 * 编排脚本 host hook 实现。
 * 每个 hook 返回纯数据；agent() never-throw（失败/超时/取消 → null）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join, relative } from 'path'
import { readdir } from 'fs/promises'
import { randomUUID } from 'crypto'
import { AgentLoop } from '../agent/AgentLoop'
import { EventBus } from '../agent/EventBus'
import { SystemPromptBuilder } from '../agent/promptBuilder/SystemPromptBuilder'
import { PermissionManager } from '../permissions/PermissionManager'
import { ToolRegistry, resolveAndValidatePath } from '../tools/ToolRegistry'
import { createReadState } from '../tools/editTool'
import { defaultSubAgentPermissionBridge } from '../tools/subAgentBridge'
import { bashTool } from '../tools/bash'
import * as Worktree from '../worktree'
import type { Mode } from '../../shared/session/types'
import type { ToolContext } from '../tools/types'
import type { AgentHookOpts, ComposeState, HostFn, WorkflowRuntimeDeps } from './types'
import { ensureRunDir, runLogPath } from './paths'
import { marshalOut } from './marshal'
import { appendJournalSync, journalKeyBase, type JournalLoad } from './journal'
import type { Semaphore } from './semaphore'
import { applyStatePatch } from './state'
import { topoSort, type TopoTask } from './topo'
import { extractJson } from './jsonExtract'

const BASE_RULES_MINIMAL = '遵守工具结果，简洁汇报。你是编排子代理，不要反问父 agent。'
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_TOOLS = ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash', 'todo_write'] as const

/** 本 run 创建的 worktree，终态时按契约清理 */
export interface OwnedWorktree {
  info: Worktree.WorktreeInfo
  baseSha: string
}

/** 挂起的 askUser：resolve 后脚本继续；null 表示取消/中止 */
export interface PendingAskUser {
  resolve: (answer: string | null) => void
  reject: (err: Error) => void
}

export interface HookContext {
  runId: string
  deps: WorkflowRuntimeDeps
  abortSignal: AbortSignal
  /** 当前 phase 名（phase() 更新） */
  currentPhase: { name: string }
  /** 写 state / 事件用 */
  onPhase: (name: string) => void
  onLog: (message: string) => void
  /** journal 缓存（resume 预载）；occ 为 per-run 计数器 */
  journal: JournalLoad
  occ: Map<string, number>
  runSem: Semaphore
  globalSem: Semaphore
  /** 本 run 拥有的 worktree，供终态 reclaim */
  ownedWorktrees: Map<string, OwnedWorktree>
  /** 可变 state.json 对象（与 runtime 共享） */
  composeState: ComposeState
  /** 挂起的 askUser（requestId → pending） */
  pendingAskUsers: Map<string, PendingAskUser>
  /** 落盘并广播 state 快照（进度面板） */
  persistState: () => void
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

function buildToolContext(
  deps: WorkflowRuntimeDeps,
  signal: AbortSignal,
  workingDir?: string
): ToolContext {
  return {
    workingDir: workingDir ?? deps.workspaceRoot,
    readState: createReadState(),
    checkpointManager: deps.checkpointManager,
    abortSignal: signal,
    supportsVision: deps.supportsVision,
    sessionId: deps.sessionId,
    eventBus: deps.parentEventBus
  }
}

/**
 * 派发隔离子 agent（复用 taskTool / runSkillFork 三层隔离样板）。
 * never-throw：任何失败返回 null。
 * @param workingDir 文件操作根目录；worktree 隔离时指向独立 worktree
 */
async function spawnAgent(
  prompt: string,
  opts: AgentHookOpts,
  ctx: HookContext,
  workingDir?: string
): Promise<string | Record<string, unknown> | null> {
  const { deps, abortSignal } = ctx
  if (isAborted(abortSignal)) return null

  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
  const permissionBridge = deps.permissionBridge ?? defaultSubAgentPermissionBridge
  // compose run 内固定 auto 语义；未指定时默认 compose
  const mode: Mode = deps.mode ?? 'compose'
  const agentCwd = workingDir ?? deps.workspaceRoot

  let agentRole = BASE_RULES_MINIMAL
  const skillName = opts.skill
  if (skillName && deps.resolveSkill) {
    const skill = deps.resolveSkill(skillName)
    if (skill) {
      agentRole = skill.body
    } else {
      agentRole = `你是编排技能 ${skillName} 的执行者。按技能职责完成任务并简洁汇报。`
    }
  }

  const allowedTools = opts.tools?.length ? opts.tools : [...DEFAULT_TOOLS]
  const subRegistry = new ToolRegistry()
  for (const name of allowedTools) {
    const tool = deps.resolveTool(name)
    if (tool) subRegistry.register(tool)
  }

  const toolSummary = subRegistry
    .getToolDefinitions()
    .map((t) => `- ${t.name}: ${t.description.split('\n')[0]}`)
    .join('\n')

  let userPrompt = prompt
  if (opts.schema) {
    userPrompt +=
      '\n\n请严格按以下 JSON Schema 返回**一个** JSON 对象（不要 markdown 围栏以外的解释）：\n' +
      JSON.stringify(opts.schema)
  }

  const frozenPrompt = SystemPromptBuilder.build({
    agentRole,
    baseRules: BASE_RULES_MINIMAL,
    projectRules: null,
    skillContext: '',
    modeInstruction: 'You are a workflow sub-agent. Be concise. Return a structured summary.',
    toolSummary
  })

  const subBus = new EventBus()
  const subPermission = new PermissionManager()
  let summary = ''
  let subMessageId = ''
  let subLoop!: AgentLoop

  const unsub = subBus.on((event) => {
    if (event.type === 'message_start') subMessageId = event.messageId
    if (event.type === 'text_delta' && event.messageId === subMessageId) {
      summary += event.delta
    }
    if (event.type === 'permission_request') {
      const bridgedId = permissionBridge.bind(event.requestId, subLoop)
      deps.parentEventBus.emit({ ...event, requestId: bridgedId })
    }
  })

  subLoop = new AgentLoop(deps.modelClient, subBus, {
    systemPrompt: frozenPrompt,
    maxToolRounds: 20,
    contextWindow: deps.contextWindow,
    supportsVision: deps.supportsVision ?? true,
    toolExecution: 'sequential'
  })

  const toolCtx = buildToolContext(deps, abortSignal, agentCwd)
  // 子 agent 文件操作全部落在 agentCwd（worktree 隔离时为独立目录）
  subLoop.setWorkingDir(agentCwd)
  subLoop.setToolRegistry(subRegistry)
  // 子 agent：compose / auto 语义（危险命令仍拦）
  subPermission.setPermissionPolicy('auto')
  subLoop.setPermissionManager(subPermission)
  subLoop.setMode(mode)
  subLoop.setReadState(toolCtx.readState.clone())

  permissionBridge.register(subLoop)

  const timeoutController = new AbortController()
  const onAbort = () => {
    try {
      subLoop.cancel()
    } catch {
      /* ignore */
    }
    timeoutController.abort()
  }
  abortSignal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(onAbort, timeoutMs)

  try {
    await Promise.race([
      subLoop.sendMessage(userPrompt),
      new Promise<void>((_, reject) => {
        timeoutController.signal.addEventListener(
          'abort',
          () => reject(new Error('agent-timeout-or-cancel')),
          { once: true }
        )
      })
    ])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
    abortSignal.removeEventListener('abort', onAbort)
    unsub()
    permissionBridge.unregister(subLoop)
    permissionBridge.clearForLoop(subLoop)
    subLoop.dispose()
  }

  if (isAborted(abortSignal)) return null
  if (subLoop.getState() === 'error' || subLoop.getState() === 'cancelled') return null

  const text = summary.trim()
  if (!text) return null

  if (opts.schema) {
    const parsed = extractJson(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return marshalOut(parsed) as Record<string, unknown>
    }
    return null
  }

  return text
}

/** skill → agentType（journal 五字段）；无 skill 时用 general */
function resolveAgentType(opts: AgentHookOpts): string {
  return opts.skill ?? 'general'
}

function compileGlob(pattern: string): RegExp {
  let regex = ''
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        regex += '(?:.*/)?'
        i += 3
      } else {
        regex += '.*'
        i += 2
      }
    } else if (pattern[i] === '*') {
      regex += '[^/]*'
      i++
    } else if (pattern[i] === '?') {
      regex += '[^/]'
      i++
    } else if ('.+^${}()|[]\\'.includes(pattern[i]!)) {
      regex += '\\' + pattern[i]
      i++
    } else {
      regex += pattern[i]
      i++
    }
  }
  return new RegExp(`^${regex}$`)
}

async function walkGlob(root: string, pattern: string): Promise<string[]> {
  const re = compileGlob(pattern.replace(/\\/g, '/'))
  const out: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const abs = join(dir, ent.name)
      const rel = relative(root, abs).replace(/\\/g, '/')
      if (ent.isDirectory()) {
        if (rel && re.test(rel)) out.push(rel)
        // 跳过常见大目录
        if (ent.name === 'node_modules' || ent.name === '.git') continue
        await walk(abs)
      } else if (ent.isFile()) {
        if (re.test(rel)) out.push(rel)
      }
    }
  }

  await walk(root)
  return out.sort()
}

/** 构建注入沙箱的 host hooks */
export function createHostHooks(ctx: HookContext): Record<string, HostFn> {
  const { deps, runId, abortSignal } = ctx
  const workspaceRoot = deps.workspaceRoot

  // 确保 log 目录；checkpoint 事务边界（write 需要）
  ensureRunDir(workspaceRoot, runId)
  const logFile = runLogPath(workspaceRoot, runId)
  if (deps.checkpointManager && !deps.checkpointManager.getCurrentMessageId()) {
    deps.checkpointManager.beginMessage(`workflow-${runId}`)
  }

  const agent: HostFn = (prompt: unknown, opts?: unknown) => {
    const o = { ...((opts ?? {}) as AgentHookOpts) }
    // 缺省 phase 取 runtime 当前 phase（journal 五字段需要）
    if (!o.phase && ctx.currentPhase.name) {
      o.phase = ctx.currentPhase.name
    }
    const promptStr = String(prompt ?? '')

    // 复用已有目录（同一 worktree 内 verify/debug）：不新建、不写 journal
    const reuseDir =
      typeof o.directory === 'string' && o.directory.trim() ? o.directory.trim() : ''
    if (reuseDir) {
      return ctx.runSem
        .run(() =>
          ctx.globalSem.run(async () => {
            try {
              return await spawnAgent(promptStr, o, ctx, reuseDir)
            } catch {
              deps.parentEventBus.emit({
                type: 'workflow_agent_failed',
                runId,
                reason: 'directory-spawn-failed'
              })
              return null
            }
          })
        )
        .catch(() => null)
    }

    // worktree 隔离：不写 journal（产物是目录，无法用结果缓存重建）
    if (o.isolation === 'worktree') {
      return ctx.runSem
        .run(() =>
          ctx.globalSem.run(async () => {
            // info 在 create 成功后立刻持有，headSha 失败时也要 reclaim，避免泄漏
            let createdDir: string | undefined
            try {
              const info = await Worktree.create(workspaceRoot, o.label ?? o.skill)
              createdDir = info.directory
              let baseSha: string
              try {
                baseSha = Worktree.headSha(info.directory)
              } catch {
                await Worktree.remove({ workspaceRoot, directory: info.directory }).catch(
                  () => undefined
                )
                createdDir = undefined
                throw new Error('worktree-head-sha-failed')
              }
              ctx.ownedWorktrees.set(info.directory, { info, baseSha })
              const value = await spawnAgent(promptStr, o, ctx, info.directory)
              const succeeded = value !== null
              const pristine =
                succeeded &&
                (await Worktree.isPristine(info.directory, baseSha).catch(() => false))
              // 失败：立即删；成功且 pristine：也删；成功有改动：保留并挂 _worktree
              if (!succeeded || pristine) {
                await Worktree.remove({ workspaceRoot, directory: info.directory }).catch(
                  () => undefined
                )
                ctx.ownedWorktrees.delete(info.directory)
                createdDir = undefined
                return succeeded ? value : null
              }
              createdDir = undefined
              const wt = {
                branch: info.branch,
                directory: info.directory,
                changed: true
              }
              if (value && typeof value === 'object' && !Array.isArray(value)) {
                return { ...(value as object), _worktree: wt }
              }
              return { _worktree: wt, result: value }
            } catch {
              // create 成功但尚未登记 ownedWorktrees 时，兜底删除刚建的目录
              if (createdDir) {
                await Worktree.remove({ workspaceRoot, directory: createdDir }).catch(
                  () => undefined
                )
                ctx.ownedWorktrees.delete(createdDir)
              }
              deps.parentEventBus.emit({
                type: 'workflow_agent_failed',
                runId,
                reason: 'worktree-spawn-failed'
              })
              return null
            }
          })
        )
        .catch(() => null)
    }

    // 共享工作区：journal 缓存 + 两层信号量
    const keyOpts = {
      agentType: resolveAgentType(o),
      model: o.model,
      schema: o.schema,
      phase: o.phase
    }
    const base = journalKeyBase(promptStr, keyOpts)
    const n = ctx.occ.get(base) ?? 0
    ctx.occ.set(base, n + 1)
    const key = base + ':' + n

    if (ctx.journal.results.has(key)) {
      return Promise.resolve(ctx.journal.results.get(key))
    }

    return ctx.runSem
      .run(() =>
        ctx.globalSem.run(async () => {
          const result = await spawnAgent(promptStr, o, ctx)
          // 失败不缓存：null 不写 journal，下次 resume 可 self-heal
          if (result !== null) {
            try {
              appendJournalSync(workspaceRoot, runId, [
                { t: 'agent', key, result, pass: ctx.journal.pass }
              ])
              ctx.journal.results.set(key, result)
            } catch {
              /* journal 写失败不阻断 agent 返回值 */
            }
          } else {
            deps.parentEventBus.emit({
              type: 'workflow_agent_failed',
              runId,
              reason: 'agent-null'
            })
          }
          return result
        })
      )
      .catch(() => null)
  }

  const phase: HostFn = (name: unknown) => {
    const title = String(name ?? '')
    ctx.currentPhase.name = title
    ctx.onPhase(title)
    deps.parentEventBus.emit({
      type: 'workflow_phase',
      runId,
      phase: title
    })
    return undefined
  }

  const log: HostFn = (...args: unknown[]) => {
    const message = args
      .map((a) => {
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
    const line = `[${new Date().toISOString()}] ${message}\n`
    try {
      appendFileSync(logFile, line, 'utf-8')
    } catch {
      /* 日志失败不打断脚本 */
    }
    ctx.onLog(message)
    deps.parentEventBus.emit({
      type: 'workflow_log',
      runId,
      message
    })
    return undefined
  }

  const read: HostFn = async (pathArg: unknown) => {
    const validated = resolveAndValidatePath(workspaceRoot, String(pathArg ?? ''))
    if (!validated.ok) throw new Error(validated.error)
    if (!existsSync(validated.path)) return null
    return readFileSync(validated.path, 'utf-8')
  }

  const write: HostFn = async (pathArg: unknown, content: unknown) => {
    const validated = resolveAndValidatePath(workspaceRoot, String(pathArg ?? ''))
    if (!validated.ok) throw new Error(validated.error)
    const abs = validated.path
    const isNew = !existsSync(abs)
    mkdirSync(dirname(abs), { recursive: true })
    if (deps.checkpointManager) {
      if (!deps.checkpointManager.getCurrentMessageId()) {
        deps.checkpointManager.beginMessage(`workflow-${runId}`)
      }
      deps.checkpointManager.backupBeforeWrite(abs, isNew)
    }
    writeFileSync(abs, String(content ?? ''), 'utf-8')
    return undefined
  }

  const exists: HostFn = async (pathArg: unknown) => {
    const validated = resolveAndValidatePath(workspaceRoot, String(pathArg ?? ''))
    if (!validated.ok) throw new Error(validated.error)
    return existsSync(validated.path)
  }

  const glob: HostFn = async (pattern: unknown) => {
    // 拒绝越界 pattern（含 .. 或绝对路径）
    const pat = String(pattern ?? '').replace(/\\/g, '/')
    if (pat.startsWith('/') || pat.includes('..') || /^[A-Za-z]:/.test(pat)) {
      throw new Error(`glob pattern escapes workspace: ${pat}`)
    }
    return walkGlob(workspaceRoot, pat)
  }

  const bash: HostFn = async (cmd: unknown) => {
    if (isAborted(abortSignal)) {
      return { exitCode: -1, stdout: '', stderr: 'cancelled', passed: false }
    }
    const command = String(cmd ?? '')
    const mode: Mode = deps.mode ?? 'compose'
    const pm = new PermissionManager()
    pm.setPermissionPolicy('auto')
    if (deps.sessionId) pm.setSessionId(deps.sessionId)
    const decision = pm.check({ toolName: 'bash', args: { command } }, mode)
    if (decision.decision === 'deny') {
      return {
        exitCode: -1,
        stdout: '',
        stderr: decision.reason ?? 'permission denied',
        passed: false
      }
    }
    // 编排 run 内固定 auto 语义直接执行；危险命令仍由 PermissionManager 拦截
    const toolCtx = buildToolContext(deps, abortSignal)
    const result = await bashTool.execute({ command }, toolCtx)
    const exitCode = result.success ? 0 : 1
    return {
      exitCode,
      stdout: result.output ?? '',
      stderr: result.error ?? '',
      passed: result.success
    }
  }

  /**
   * 阻塞等待用户选择。emit workflow_ask_user；无 UI 时由测试注入 resolver，
   * 或通过 resolveWorkflowAskUser(runId, requestId, answer) 解除。
   * cancel/abort 时返回 null，脚本不得自动推进。
   */
  const askUser: HostFn = async (req: unknown) => {
    const r = (req ?? {}) as { question?: string; options?: string[] }
    const question = String(r.question ?? '')
    const options = Array.isArray(r.options) ? r.options.map(String) : []
    const requestId = randomUUID()

    if (isAborted(abortSignal)) return null

    // 测试 / 宿主注入：直接应答，不挂起
    if (deps.askUserResolver) {
      deps.parentEventBus.emit({
        type: 'workflow_ask_user',
        runId,
        requestId,
        question,
        options
      })
      try {
        const answer = await deps.askUserResolver({ runId, requestId, question, options })
        return answer
      } catch {
        return null
      }
    }

    return new Promise<string | null>((resolve) => {
      const onAbort = () => {
        ctx.pendingAskUsers.delete(requestId)
        abortSignal.removeEventListener('abort', onAbort)
        resolve(null)
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })

      ctx.pendingAskUsers.set(requestId, {
        resolve: (answer: string | null) => {
          abortSignal.removeEventListener('abort', onAbort)
          ctx.pendingAskUsers.delete(requestId)
          resolve(answer)
        },
        reject: () => {
          abortSignal.removeEventListener('abort', onAbort)
          ctx.pendingAskUsers.delete(requestId)
          resolve(null)
        }
      })

      deps.parentEventBus.emit({
        type: 'workflow_ask_user',
        runId,
        requestId,
        question,
        options
      })
    })
  }

  /** 增量更新 state.json（脚本侧写 artifacts / tasks / failure / review 等） */
  const updateState: HostFn = (patch: unknown) => {
    if (!patch || typeof patch !== 'object') return undefined
    applyStatePatch(ctx.composeState, patch as Record<string, unknown>)
    ctx.persistState()
    if (ctx.composeState.tasks) {
      deps.parentEventBus.emit({
        type: 'workflow_task_update',
        runId,
        tasks: marshalOut(ctx.composeState.tasks) as unknown[]
      })
    }
    return marshalOut(ctx.composeState)
  }

  /** 读取当前 state 快照（纯数据） */
  const loadState: HostFn = () => marshalOut(ctx.composeState)

  /** 清理已合并的 worktree（integrate 后调用） */
  const cleanupWorktree: HostFn = async (wt: unknown) => {
    let directory = ''
    if (typeof wt === 'string') {
      directory = wt
    } else if (wt && typeof wt === 'object') {
      const o = wt as { directory?: string }
      directory = String(o.directory ?? '')
    }
    if (!directory) return false
    try {
      await Worktree.remove({ workspaceRoot, directory })
      ctx.ownedWorktrees.delete(directory)
      return true
    } catch {
      return false
    }
  }

  /** Kahn 拓扑排序：返回可并行批次 */
  const topoSortHook: HostFn = (tasks: unknown) => {
    if (!Array.isArray(tasks)) return []
    return topoSort(tasks as TopoTask[])
  }

  return {
    agent,
    phase,
    log,
    read,
    write,
    exists,
    glob,
    bash,
    askUser,
    updateState,
    loadState,
    cleanupWorktree,
    topoSort: topoSortHook
  }
}
