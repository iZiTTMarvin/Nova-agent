/**
 * 子 agent 派发：definition 唯一的"让模型干活"入口。
 *
 * 契约（不得破坏）：
 * - never-throw —— 超时、取消、模型报错、无产出、schema 解析失败一律返回 null；
 * - 工具清单由本层收口 —— askQuestion 只可能出现在 shared 隔离且 autoMode 关闭的交互式调用里，
 *   实现阶段的子 agent 无论如何都拿不到提问工具（编排不允许在实现期阻塞等用户）；
 * - journal 只缓存成功结果 —— 失败不写，resume 时重跑实现自我修复。
 *
 * 可观测性约定（进度块不再"静得像卡死"的前提）：
 * - 子 agent 的工具调用与失败原因经 logFn 落 run 目录 log.txt，并随 workflow_log
 *   事件上行 renderer，附着到当前阶段进度块的活动区；
 * - schema 调用解析优先看最后一条 assistant 消息（中间轮次多为工具过渡语，
 *   常含噪声围栏与示例对象），失败时自动做一次无工具修复重试，
 *   一次性格式失误不再杀死整个 workflow。
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
import { extractJsonCandidates } from './jsonExtract'
import { createLogFn, type LogFn } from './progressFn'
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
/** 修复重试只做轻量整理，给短预算即可 */
const REPAIR_TIMEOUT_MS = 2 * 60 * 1000
/** 失败诊断里保留的输出尾部长度 */
const OUTPUT_TAIL_LEN = 200
/** 修复重试时喂给模型的原文上限，避免超长输出把整理任务本身压垮 */
const REPAIR_SOURCE_LEN = 12_000
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
 * spawn 的内部诊断结果。对外（AgentFn）仍是 never-throw 的 AgentResult，
 * failure 只用于事件上报与 run 日志，不穿越公共契约。
 */
interface SpawnFailure {
  /** 机器可读原因：aborted / timeout:* / loop-error:* / empty-output / schema-parse-failed */
  reason: string
  /** 子代理文本产出长度（判断"说了但格式不对"还是"根本没说"） */
  outputChars: number
  /** 输出尾部摘要，单行化截断，定位格式问题用 */
  outputTail: string
}

interface SpawnOutcome {
  result: AgentResult
  failure: SpawnFailure | null
}

function tailOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(-OUTPUT_TAIL_LEN)
}

function headOf(text: string, len = 160): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, len)
}

function spawnFailure(reason: string, text: string): SpawnOutcome {
  return {
    result: null,
    failure: { reason, outputChars: text.length, outputTail: tailOf(text) }
  }
}

function spawnOk(result: AgentResult): SpawnOutcome {
  return { result, failure: null }
}

/**
 * 生成一行人类可读的工具活动摘要。
 * 取首个有意义的字符串参数（路径/命令/模式）做上下文，单行化并截断。
 */
function summarizeToolActivity(toolName: string, args: Record<string, unknown>): string {
  const candidate = ['path', 'pattern', 'command', 'query', 'url', 'content']
    .map((key) => args[key])
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0)
  const brief = candidate ? headOf(candidate, 100) : ''
  return brief ? `调用工具 ${toolName}：${brief}` : `调用工具 ${toolName}`
}

/**
 * 从子代理文本中挑出符合 schema 的对象。
 *
 * 最后一条 assistant 消息优先：中间轮次多为工具过渡语，常带噪声围栏/示例对象；
 * 候选必须覆盖 schema.required 字段，避免把散文里的示例对象误当结果。
 */
function pickSchemaObject(
  schema: Record<string, unknown>,
  finalMessage: string,
  fullText: string
): Record<string, unknown> | null {
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === 'string')
    : []
  const sources = finalMessage === fullText ? [fullText] : [finalMessage, fullText]
  for (const source of sources) {
    if (!source.trim()) continue
    for (const candidate of extractJsonCandidates(source)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
      const record = candidate as Record<string, unknown>
      if (required.every((key) => key in record)) return record
    }
  }
  return null
}

function buildRepairPrompt(source: string): string {
  const trimmed =
    source.length > REPAIR_SOURCE_LEN
      ? `${source.slice(0, REPAIR_SOURCE_LEN)}\n……（原文过长已截断）`
      : source
  return [
    '你上一轮的输出无法解析为符合要求的一个 JSON 对象。',
    '请把下面的分析内容整理为恰好一个符合给定 JSON Schema 的 JSON 对象，',
    '并只输出该对象本身——不要 markdown 围栏，不要任何解释。',
    '',
    `待整理内容：\n${trimmed}`
  ].join('\n')
}

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
 * 任何异常都收敛为带诊断的 SpawnOutcome，调用方不需要 try/catch。
 * isRepair 标记修复重试自身——重试失败不再嵌套重试，避免无界递归。
 */
async function spawnSubAgent(
  ctx: HostContext,
  prompt: string,
  opts: AgentOptions,
  tools: string[],
  workingDir: string,
  log: LogFn,
  isRepair = false
): Promise<SpawnOutcome> {
  if (ctx.abortSignal.aborted) return spawnFailure('aborted', '')

  const label = opts.label ?? opts.phase ?? ctx.currentPhase.name
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
      '\n\n请严格按以下 JSON Schema 返回**恰好一个** JSON 对象；最终消息只输出该对象本身，不要 markdown 围栏与任何解释：\n' +
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
  let currentMessageText = ''
  let previousMessageText = ''
  let lastLoopError = ''
  let lastActivity = ''
  let subMessageId = ''
  let subLoop!: AgentLoop

  const unsub = subBus.on((event) => {
    if (event.type === 'message_start') {
      subMessageId = event.messageId
      // 归档上一段文本：schema 解析优先用最后一个轮次的产出
      if (currentMessageText.trim()) previousMessageText = currentMessageText
      currentMessageText = ''
    }
    if (event.type === 'text_delta' && event.messageId === subMessageId) {
      summary += event.delta
      currentMessageText += event.delta
    }
    if (event.type === 'error' && typeof event.error === 'string') {
      lastLoopError = event.error
    }
    if (event.type === 'tool_call') {
      // AgentLoop 的一个 assistant messageId 覆盖全部工具轮次，message_start 不区分轮次；
      // 以工具调用为分段点：最终轮文本 = 最后一次工具调用之后累积的文本。
      if (currentMessageText.trim()) previousMessageText = currentMessageText
      currentMessageText = ''
      // 活动行落 run 日志并上行 renderer；相邻重复行（同工具同参数）不刷屏
      const line = `[${label}] ${summarizeToolActivity(event.toolName, event.args)}`
      if (line !== lastActivity) {
        lastActivity = line
        log(line)
      }
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
  } catch (err) {
    // race 拒绝按来源细分：外部取消、超时、sendMessage 装配期 reject
    if (ctx.abortSignal.aborted) return spawnFailure('aborted', summary)
    if (timeoutController.signal.aborted) {
      return spawnFailure(`timeout:${Math.round(timeoutMs / 60000)}min`, summary)
    }
    const message = err instanceof Error ? err.message : String(err)
    return spawnFailure(`loop-error:${headOf(message)}`, summary)
  } finally {
    clearTimeout(timer)
    ctx.abortSignal.removeEventListener('abort', onAbort)
    unsub()
    permissionBridge.unregister(subLoop)
    permissionBridge.clearForLoop(subLoop)
    subLoop.dispose()
  }

  if (ctx.abortSignal.aborted) return spawnFailure('aborted', summary)
  const loopState = subLoop.getState()
  if (loopState === 'cancelled') return spawnFailure('aborted', summary)
  if (loopState === 'error') {
    return spawnFailure(`loop-error:${headOf(lastLoopError || 'agent loop error')}`, summary)
  }

  const finalMessage = currentMessageText.trim() ? currentMessageText : previousMessageText
  const text = summary.trim()
  if (!text) return spawnFailure('empty-output', summary)

  if (opts.schema) {
    const parsed = pickSchemaObject(opts.schema, finalMessage, summary)
    if (parsed) return spawnOk(parsed)

    // 一次性格式失误不该杀死整个 workflow：做一层无工具修复重试，把自由文本收敛为 schema JSON
    if (!isRepair) {
      log(`[${label}] 输出未解析为符合 schema 的 JSON，尝试一次无工具修复重试`)
      return spawnSubAgent(
        ctx,
        buildRepairPrompt(finalMessage.trim() ? finalMessage : summary),
        {
          ...opts,
          interactive: false,
          timeoutMs: Math.min(timeoutMs, REPAIR_TIMEOUT_MS),
          label: `${label}-repair`
        },
        [],
        workingDir,
        log,
        true
      )
    }
    return spawnFailure('schema-parse-failed', summary)
  }

  return spawnOk(text)
}

function emitAgentFailed(ctx: HostContext, reason: string): void {
  ctx.eventBus.emit({
    type: 'workflow_agent_failed',
    runId: ctx.runId,
    sessionId: ctx.sessionId,
    reason
  })
}

/**
 * 失败上报统一出口：workflow_agent_failed 事件 + run 日志行。
 * aborted 属正常取消语义（停止按钮/父级中止），不作为失败上报，避免制造噪声。
 */
function reportSpawnFailure(
  ctx: HostContext,
  log: LogFn,
  label: string,
  outcome: SpawnOutcome
): void {
  const failure = outcome.failure
  if (!failure || failure.reason === 'aborted') return
  emitAgentFailed(ctx, failure.reason)
  log(
    `[${label}] 子代理未产出有效结果：${failure.reason}（已输出 ${failure.outputChars} 字符` +
      `${failure.outputTail ? `，尾部：${failure.outputTail}` : ''}）`
  )
}

export function createAgentFn(ctx: HostContext): AgentFn {
  const log = createLogFn(ctx)
  return async (prompt, opts = {}) => {
    const promptStr = String(prompt ?? '')
    const isolation = resolveIsolation(opts)
    const phase = opts.phase ?? ctx.currentPhase.name
    const effectiveOpts: AgentOptions = { ...opts, phase }
    const label = effectiveOpts.label ?? phase
    const tools = resolveAgentTools({
      isolation,
      autoMode: ctx.autoMode,
      interactive: opts.interactive,
      tools: opts.tools
    })

    // 显式复用目录：不新建 worktree，不写 journal（同一 worktree 内的 verify/debug）
    const reuseDir = typeof opts.directory === 'string' ? opts.directory.trim() : ''
    if (reuseDir) {
      const outcome = await withSemaphores(
        ctx,
        () =>
          assertScopeLive(ctx)
            ? spawnSubAgent(ctx, promptStr, effectiveOpts, tools, reuseDir, log)
            : Promise.resolve(spawnFailure('aborted', '')),
        spawnFailure('semaphore-error', '')
      )
      if (outcome.result === null) reportSpawnFailure(ctx, log, label, outcome)
      return outcome.result
    }

    if (isolation === 'worktree') {
      return runInWorktree(ctx, promptStr, effectiveOpts, tools, log)
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

    const outcome = await withSemaphores(
      ctx,
      () =>
        assertScopeLive(ctx)
          ? spawnSubAgent(ctx, promptStr, effectiveOpts, tools, ctx.workspaceRoot, log)
          : Promise.resolve(spawnFailure('aborted', '')),
      spawnFailure('semaphore-error', '')
    )
    if (outcome.result === null) {
      reportSpawnFailure(ctx, log, label, outcome)
      return null
    }
    // 只缓存成功结果；写 journal 前再校验一次 scope，取消后不再落盘
    if (assertScopeLive(ctx)) {
      try {
        appendJournalSync(ctx.workspaceRoot, ctx.runId, [
          { t: 'agent', key, result: outcome.result, pass: ctx.journal.pass }
        ])
        ctx.journal.results.set(key, outcome.result)
      } catch {
        // journal 写失败不影响本次返回值
      }
    }
    return outcome.result
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
  tools: string[],
  log: LogFn
): Promise<AgentResult> {
  const label = opts.label ?? opts.phase ?? ctx.currentPhase.name
  const key =
    opts.worktreeKey?.trim() ||
    `agent-${journalKeyBase(prompt, { agentType: resolveAgentType(opts), phase: opts.phase }).slice(0, 12)}`

  return withSemaphores(
    ctx,
    async () => {
      if (!assertScopeLive(ctx)) return null
      let handle
      try {
        handle = await ensureWorktree(ctx, key)
      } catch {
        emitAgentFailed(ctx, 'worktree-create-failed')
        log(`[${label}] worktree 创建失败`)
        return null
      }

      const outcome = await spawnSubAgent(ctx, prompt, opts, tools, handle.directory, log)
      if (outcome.result === null) {
        await releaseWorktree(ctx, handle.directory)
        reportSpawnFailure(ctx, log, label, outcome)
        return null
      }
      const pristine = await Worktree.isPristine(handle.directory, handle.baseSha).catch(
        () => false
      )
      if (pristine) {
        await releaseWorktree(ctx, handle.directory)
      }
      return outcome.result
    },
    null
  )
}

/** per-run 信号量在外、全局在内：一个 run 不会饿死另一个 run */
function withSemaphores<T>(ctx: HostContext, fn: () => Promise<T>, fallback: T): Promise<T> {
  return ctx.runSem.run(() => ctx.globalSem.run(fn)).catch(() => fallback)
}
