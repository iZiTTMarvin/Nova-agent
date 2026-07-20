import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { ModelClient } from '../../model/ModelClient'
import type { ModelClientPool } from '../../model/ModelClientPool'
import type { ChatMessage } from '../../model/types'
import { AgentLoop } from '../../agent/AgentLoop'
import { EventBus } from '../../agent/EventBus'
import type { AgentEvent } from '../../agent/types'
import { PermissionManager } from '../../permissions/PermissionManager'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { ToolRegistry } from '../../tools/ToolRegistry'
import type { ReadState } from '../../tools/editTool'
import { createReadState } from '../../tools/editTool'
import type { XForgeFileEffectRecorder } from './effectRecorder'
import {
  authorizeXForgeToolCall,
  getXForgeEffectiveToolDefinitions,
  getXForgeMainAgentModeInstruction
} from './policy'
import type { XForgeRunCommitter } from './runState'
import type { XForgeStage } from './types'

export interface XForgeMainAgentSessionOptions {
  runId: string
  workspaceRoot: string
  modelClient: ModelClient | ModelClientPool
  parentEventBus: EventBus
  parentMessageId: string
  toolRegistry: ToolRegistry
  checkpointManager: CheckpointManager
  committer: XForgeRunCommitter
  askQuestion: (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]>
  abortSignal?: AbortSignal
  assertExecutionCurrent?: () => boolean
  contextWindow?: number
  supportsVision?: boolean
  readState?: ReadState
  getStage: () => XForgeStage
  effectRecorder: XForgeFileEffectRecorder
}

/** XForge 主 Agent 会话：按当前 stage policy 暴露工具，不负责 stage transition。 */
export class XForgeMainAgentSession {
  private readonly loop: AgentLoop
  private readonly bus = new EventBus()
  private output = ''
  private currentInternalMessageId = ''
  private readonly unsubscribe: () => void
  private readonly onAbort: () => void
  /** 上一次 run 时的阶段，用于检测阶段切换并切换缓存 epoch */
  private lastStage: XForgeStage | null = null

  constructor(private readonly options: XForgeMainAgentSessionOptions) {
    this.unsubscribe = this.bus.on(event => this.handleEvent(event))
    this.loop = new AgentLoop(options.modelClient, this.bus, {
      systemPrompt: [
        '你是 XForge 的单一主 Agent。阶段用于组织工作，Runtime 会按当前策略暴露和授权工具能力。',
        '只处理当前阶段；不得 commit、push、deploy 或 publish；不得把模型自报当作测试结果。',
        '阶段交互与产物持久化由 Runtime 负责。方法正文里的提问、写文件和返回格式说明只作领域参考，若与当前 Runtime 指令冲突，以 Runtime 指令为准。',
        '需要输出 JSON 时只输出一个 JSON 对象，不要使用 Markdown 围栏。'
      ].join('\n'),
      maxToolRounds: 30,
      contextWindow: options.contextWindow,
      supportsVision: options.supportsVision ?? true,
      toolExecution: 'sequential',
      useUnifiedSkillDispatch: false
    })
    const permission = new PermissionManager()
    permission.setPermissionPolicy('auto')
    permission.setCurrentProjectPath(options.workspaceRoot)
    this.loop.setPermissionManager(permission)
    this.loop.setMode('compose')
    this.loop.setWorkingDir(options.workspaceRoot)
    this.loop.setToolRegistry(options.toolRegistry)
    this.loop.setEffectiveToolDefinitionsProvider(() =>
      getXForgeEffectiveToolDefinitions({
        stage: options.getStage(),
        toolDefinitions: options.toolRegistry.getToolDefinitions()
      })
    )
    this.loop.setModeInstructionProvider(() =>
      getXForgeMainAgentModeInstruction(options.getStage())
    )
    this.loop.setCheckpointManager(options.checkpointManager)
    this.loop.setReadState(options.readState ?? createReadState())
    this.loop.setAskQuestionHandler(options.askQuestion)
    this.loop.setFileEffectRecorder(options.effectRecorder)
    this.loop.setToolAuthorizationPolicy((toolName, args) => {
      const stage = options.getStage()
      const xforge = options.committer.getSnapshot(options.runId)?.xforge ?? null
      const decision = authorizeXForgeToolCall({
        stage,
        workspaceRoot: options.workspaceRoot,
        validatedPlan: xforge?.validatedPlan ?? null,
        toolName,
        args
      })
      return { allowed: decision.allowed, reason: decision.reason }
    })
    if (options.assertExecutionCurrent) {
      this.loop.setExecutionFence(options.assertExecutionCurrent)
    }
    this.onAbort = () => this.loop.cancel()
    options.abortSignal?.addEventListener('abort', this.onAbort)
  }

  async run(prompt: string): Promise<string> {
    throwIfAborted(this.options.abortSignal)
    const currentStage = this.options.getStage()
    if (this.lastStage !== null && this.lastStage !== currentStage) {
      this.loop.bumpCacheEpoch('toolset_change')
    }
    this.lastStage = currentStage
    this.output = ''
    await this.loop.sendMessage(prompt)
    throwIfAborted(this.options.abortSignal)
    if (this.loop.getState() === 'error' || this.loop.getState() === 'cancelled') {
      throw new Error(`XForge 主 Agent 在 ${this.options.getStage()} 阶段未正常完成`)
    }
    const result = this.output.trim()
    if (!result) throw new Error(`XForge 主 Agent 在 ${this.options.getStage()} 阶段返回空结果`)
    return result
  }

  async runJson<T>(prompt: string, validate: (value: unknown) => value is T): Promise<T> {
    return this.runJsonDecoded(prompt, value => validate(value) ? value : null)
  }

  async runJsonDecoded<T>(prompt: string, decode: (value: unknown) => T | null): Promise<T> {
    const first = await this.run(prompt)
    const decodedFirst = decode(parseJsonObject(first))
    if (decodedFirst !== null) return decodedFirst

    const repaired = await repairStructuredOutput({
      modelClient: this.options.modelClient,
      abortSignal: this.options.abortSignal,
      prompt,
      invalidOutput: first
    })
    const decodedRepair = decode(parseJsonObject(repaired.output))
    if (decodedRepair !== null) return decodedRepair

    const reason = repaired.finishReason === 'length'
      ? '结构化输出被模型长度上限截断'
      : '结构化结果无法通过 JSON 与字段校验'
    throw new Error(
      `XForge ${this.options.getStage()} 阶段${reason}: ${repaired.output.slice(0, 240)}`
    )
  }

  dispose(): void {
    this.options.abortSignal?.removeEventListener('abort', this.onAbort)
    this.unsubscribe()
    this.loop.dispose()
  }

  private handleEvent(event: AgentEvent): void {
    if (event.type === 'message_start') {
      this.currentInternalMessageId = event.messageId
      return
    }
    if (event.type === 'text_delta' && event.messageId === this.currentInternalMessageId) {
      this.output += event.delta
      return
    }
    if (!('messageId' in event) || event.type === 'message_end') return
    const forwardable = new Set([
      'thinking_delta',
      'tool_call_start',
      'tool_call_delta',
      'tool_call',
      'tool_result',
      'permission_request',
      'diff_update',
      'verification_result',
      'verification_permission_request',
      'verification_permission_cleared',
      'usage',
      'error',
      'hook_error'
    ])
    if (forwardable.has(event.type)) {
      this.options.parentEventBus.emit({
        ...event,
        messageId: this.options.parentMessageId
      } as AgentEvent)
    }
  }
}

/** 无工具的结构化 JSON 修复；失败时抛错，不把无效输出伪装成成功。 */
export async function repairStructuredOutput(params: {
  modelClient: ModelClient | ModelClientPool
  abortSignal?: AbortSignal
  prompt: string
  invalidOutput: string
}): Promise<{ output: string; finishReason: string }> {
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: [
        '你是 XForge 的结构化结果修复器。你没有工具，不要分析过程。',
        '根据原始任务和不合格输出，重新生成原始任务要求的单个紧凑 JSON 对象。',
        '不要使用 Markdown 围栏，不要返回原始任务未要求的说明或 Markdown 字段。'
      ].join('\n')
    },
    { role: 'user', content: params.prompt },
    { role: 'assistant', content: params.invalidOutput.slice(0, 16_000) },
    {
      role: 'user',
      content: '上面的输出无法通过结构校验。现在只返回修正后的一个合法 JSON 对象。'
    }
  ]
  let output = ''
  let finishReason = ''
  for await (const event of params.modelClient.chat(messages, undefined, {
    abortSignal: params.abortSignal
  })) {
    if (event.type === 'text_delta') output += event.delta
    if (event.type === 'message_end') finishReason = event.finishReason
    if (event.type === 'error') throw new Error(event.error)
    if (event.type === 'context_overflow') throw new Error(event.rawError)
    if (event.type === 'cancelled') throw new Error('XForge 结构化结果修复已取消')
  }
  if (!output.trim()) throw new Error('XForge 结构化结果修复返回空结果')
  return { output: output.trim(), finishReason }
}

export function parseJsonObject(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced ?? trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    return null
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error('XForge 执行已取消')
}
