/**
 * 子 agent 派发：definition 唯一的"让模型干活"入口。
 *
 * 契约（不得破坏）：
 * - never-throw —— 超时、取消、模型报错、无产出、schema 解析失败一律返回 null；
 * - 工具清单由本层收口 —— askQuestion 只可能出现在 shared 隔离且 autoMode 关闭的交互式调用里，
 *   实现阶段的子 agent 无论如何都拿不到提问工具（编排不允许在实现期阻塞等用户）；
 * - journal 只缓存成功结果 —— 失败不写，resume 时重跑实现自我修复。
 */
import { AgentLoop } from '../../agent/AgentLoop'
import { EventBus } from '../../agent/EventBus'
import { agentRoute } from '../../agent/turn'
import { SystemPromptBuilder } from '../../agent/promptBuilder/SystemPromptBuilder'
import { PermissionManager } from '../../permissions/PermissionManager'
import { ToolRegistry } from '../../tools/ToolRegistry'
import { createReadState } from '../../tools/editTool'
import { defaultSubAgentPermissionBridge } from '../../tools/subAgentBridge'
import * as Worktree from '../../worktree'
import type { Mode } from '../../../shared/session/types'
import { appendJournalSync, journalKeyBase } from '../state/journal'
import { extractJson } from './jsonExtract'
import { ensureWorktree, releaseWorktree } from './worktreeFn'
import {
  assertScopeLive,
  type AgentOptions,
  type AgentResult,
  type HostContext,
  type IsolationMode
} from './types'

export type AgentFn = (prompt: string, opts?: AgentOptions) => Promise<AgentResult>

const BASE_RULES_MINIMAL = '遵守工具结果，简洁汇报。你是编排子代理，不要反问父 agent。'
const DEFAULT_AGENT_TIMEOUT_MS = 10 * 60 * 1000
const ASK_QUESTION_TOOL = 'askQuestion'

/** 实现类子 agent 的默认工具集（不含提问工具） */
export const BASE_TOOLS = [
  'ls',
  'read',
  'grep',
  'find',
  'edit',
  'write',
  'bash',
  'todo_write'
] as const

/** 只读子 agent 的工具集：调研/审查用，不给任何写入或执行能力 */
export const READONLY_TOOLS = ['ls', 'read', 'grep', 'find', 'web_search'] as const

/**
 * 解析最终工具清单。
 *
 * autoMode 开启时剔除 askQuestion —— 决策点因此自然跳过，不需要额外分支或状态。
 * readonly / worktree 隔离一律不给提问工具：前者没有决策权，后者属于实现阶段。
 */
export function resolveAgentTools(params: {
  isolation: IsolationMode
  autoMode: boolean
  interactive?: boolean
  tools?: string[]
}): string[] {
  const { isolation, autoMode, interactive, tools } = params
  const base = tools?.length
    ? [...tools]
    : isolation === 'readonly'
      ? [...READONLY_TOOLS]
      : [...BASE_TOOLS]
  const withoutAsk = base.filter((name) => name !== ASK_QUESTION_TOOL)
  const mayAsk = interactive === true && !autoMode && isolation === 'shared'
  return mayAsk ? [...withoutAsk, ASK_QUESTION_TOOL] : withoutAsk
}

function resolveIsolation(opts: AgentOptions): IsolationMode {
  return opts.isolation ?? 'shared'
}

function resolveAgentType(opts: AgentOptions): string {
  return opts.phase ?? 'general'
}

/**
 * 单次子 agent 生命周期：独立 EventBus / PermissionManager / ToolRegistry。
 * 任何异常都转成 null，调用方不需要 try/catch。
 */
async function spawnSubAgent(
  ctx: HostContext,
  prompt: string,
  opts: AgentOptions,
  tools: string[],
  workingDir: string
): Promise<AgentResult> {
  if (ctx.abortSignal.aborted) return null

  const timeoutMs = opts.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS
  const permissionBridge = ctx.permissionBridge ?? defaultSubAgentPermissionBridge
  const mode: Mode = ctx.mode ?? 'compose'

  const subRegistry = new ToolRegistry()
  for (const name of tools) {
    const tool = ctx.resolveTool(name)
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

  const systemPrompt = SystemPromptBuilder.build({
    agentRole: BASE_RULES_MINIMAL,
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
      // 子 agent 的权限请求经桥接换 id 后由父 bus 转发，UI 才能应答
      const bridgedId = permissionBridge.bind(event.requestId, subLoop)
      ctx.eventBus.emit({ ...event, requestId: bridgedId })
    }
  })

  subLoop = new AgentLoop(ctx.modelClient, subBus, {
    systemPrompt,
    maxToolRounds: 20,
    contextWindow: ctx.contextWindow,
    supportsVision: ctx.supportsVision ?? true,
    toolExecution: 'sequential'
  })

  subLoop.setWorkingDir(workingDir)
  // 子 agent 属父 run：共享 runId / workspaceRoot，写者租约按父 run 归属，不绕过单写者约束
  subLoop.setRunRef(ctx.runId)
  subLoop.setWorkspaceRoot(ctx.workspaceRoot)
  subLoop.setToolRegistry(subRegistry)
  subPermission.setPermissionPolicy('auto')
  subLoop.setPermissionManager(subPermission)
  subLoop.setMode(mode)
  subLoop.setReadState(createReadState())
  // 只有携带 askQuestion 工具的子 agent 才需要提问通道；缺少 handler 时工具自身降级为 no-op
  if (tools.includes(ASK_QUESTION_TOOL) && ctx.askQuestion) {
    subLoop.setAskQuestionHandler(ctx.askQuestion)
  }
  permissionBridge.register(subLoop)

  const timeoutController = new AbortController()
  const onAbort = (): void => {
    try {
      subLoop.cancel()
    } catch {
      // cancel 失败不影响后续清理
    }
    timeoutController.abort()
  }
  ctx.abortSignal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(onAbort, timeoutMs)

  try {
    await Promise.race([
      subLoop.sendMessage(userPrompt, agentRoute()),
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
    ctx.abortSignal.removeEventListener('abort', onAbort)
    unsub()
    permissionBridge.unregister(subLoop)
    permissionBridge.clearForLoop(subLoop)
    subLoop.dispose()
  }

  if (ctx.abortSignal.aborted) return null
  if (subLoop.getState() === 'error' || subLoop.getState() === 'cancelled') return null

  const text = summary.trim()
  if (!text) return null

  if (opts.schema) {
    const parsed = extractJson(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  }
  return text
}

function emitAgentFailed(ctx: HostContext, reason: string): void {
  ctx.eventBus.emit({
    type: 'workflow_agent_failed',
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    reason
  })
}

export function createAgentFn(ctx: HostContext): AgentFn {
  return async (prompt, opts = {}) => {
    const promptStr = String(prompt ?? '')
    const isolation = resolveIsolation(opts)
    const phase = opts.phase ?? ctx.currentPhase.name
    const effectiveOpts: AgentOptions = { ...opts, phase }
    const tools = resolveAgentTools({
      isolation,
      autoMode: ctx.autoMode,
      interactive: opts.interactive,
      tools: opts.tools
    })

    // 显式复用目录：不新建 worktree，不写 journal（同一 worktree 内的 verify/debug）
    const reuseDir = typeof opts.directory === 'string' ? opts.directory.trim() : ''
    if (reuseDir) {
      return withSemaphores(ctx, async () => {
        if (!assertScopeLive(ctx)) return null
        const result = await spawnSubAgent(ctx, promptStr, effectiveOpts, tools, reuseDir)
        if (result === null) emitAgentFailed(ctx, 'directory-spawn-failed')
        return result
      })
    }

    if (isolation === 'worktree') {
      return runInWorktree(ctx, promptStr, effectiveOpts, tools)
    }

    // shared / readonly：journal 缓存 + 两层信号量
    const keyBase = journalKeyBase(promptStr, {
      agentType: resolveAgentType(effectiveOpts),
      model: effectiveOpts.model,
      schema: effectiveOpts.schema,
      phase,
      tools,
      isolation,
      timeoutMs: effectiveOpts.timeoutMs ?? null
    })
    const occ = ctx.occ.get(keyBase) ?? 0
    ctx.occ.set(keyBase, occ + 1)
    const key = `${keyBase}:${occ}`

    if (ctx.journal.results.has(key)) {
      return ctx.journal.results.get(key) as AgentResult
    }

    return withSemaphores(ctx, async () => {
      if (!assertScopeLive(ctx)) return null
      const result = await spawnSubAgent(ctx, promptStr, effectiveOpts, tools, ctx.workspaceRoot)
      if (result === null) {
        emitAgentFailed(ctx, 'agent-null')
        return null
      }
      // 只缓存成功结果；写 journal 前再校验一次 scope，取消后不再落盘
      if (assertScopeLive(ctx)) {
        try {
          appendJournalSync(ctx.workspaceRoot, ctx.runId, [
            { t: 'agent', key, result, pass: ctx.journal.pass }
          ])
          ctx.journal.results.set(key, result)
        } catch {
          // journal 写失败不影响本次返回值
        }
      }
      return result
    })
  }
}

/**
 * worktree 隔离执行。
 * 失败或 pristine 都回收目录；有改动才保留，等 integrate。
 */
async function runInWorktree(
  ctx: HostContext,
  prompt: string,
  opts: AgentOptions,
  tools: string[]
): Promise<AgentResult> {
  const key =
    opts.worktreeKey?.trim() ||
    `agent-${journalKeyBase(prompt, { agentType: resolveAgentType(opts), phase: opts.phase }).slice(0, 12)}`

  return withSemaphores(ctx, async () => {
    if (!assertScopeLive(ctx)) return null
    let handle
    try {
      handle = await ensureWorktree(ctx, key)
    } catch {
      emitAgentFailed(ctx, 'worktree-create-failed')
      return null
    }

    const result = await spawnSubAgent(ctx, prompt, opts, tools, handle.directory)
    if (result === null) {
      await releaseWorktree(ctx, handle.directory)
      emitAgentFailed(ctx, 'worktree-spawn-failed')
      return null
    }
    const pristine = await Worktree.isPristine(handle.directory, handle.baseSha).catch(() => false)
    if (pristine) {
      await releaseWorktree(ctx, handle.directory)
    }
    return result
  })
}

/** per-run 信号量在外、全局在内：一个 run 不会饿死另一个 run */
function withSemaphores(
  ctx: HostContext,
  fn: () => Promise<AgentResult>
): Promise<AgentResult> {
  return ctx.runSem.run(() => ctx.globalSem.run(fn)).catch(() => null)
}
