/**
 * contextBreakdownCalculator — 会话级上下文容量拆分计算
 *
 * 设计原则：与 AgentLoop 生命周期解耦。打开已有会话、切换会话、LLM 调用后
 * 都需要显示上下文占用，但 AgentLoop 只在发送消息时创建，因此把计算逻辑
 * 抽成独立函数，供主进程任意时刻调用并 IPC 推送。
 */
import { estimateTokens, estimateContextTokens } from './tokenEstimator'
import { SystemPromptBuilder } from './SystemPromptBuilder'
import { getStableSystemPrompt } from './modePrompt'
import { buildSkillContext } from './buildSkillContext'
import { discoverProjectRules } from './projectRulesDiscovery'
import { extractTextFromSerializableContent, type SessionData } from '../sessions/types'
import type { ChatMessage } from '../model/types'
import type { SkillManifest } from '../skills/types'
import type { ContextBreakdown } from '../../renderer/stores/useSettingsStore'

export interface BreakdownInputs {
  /** 当前会话数据（历史消息、模式、工作区） */
  session: SessionData
  /**
   * 技能 token 数（已估算）或技能清单（由本函数内部估算）。
   * AgentLoop 持有 skillsTokenBudget，可直接传数字；主进程加载会话时传清单。
   */
  skills: number | SkillManifest[]
  /** 工具定义列表（OpenAI function schema 对象） */
  toolDefinitions: unknown[]
  /** 模型上下文窗口上限，用于计算百分比 */
  contextLimit: number
}

export interface BreakdownResult {
  /** 与 IPC payload 对齐的完整数据 */
  payload: ContextBreakdown
}

/**
 * 计算某一会话的上下文容量拆分。
 * 结果可直接通过 `agent:context-breakdown` 通道推送给 renderer。
 */
export function calculateContextBreakdown(inputs: BreakdownInputs): BreakdownResult {
  const { session, skills, toolDefinitions, contextLimit } = inputs

  const skillsTokens = typeof skills === 'number'
    ? Math.max(0, skills)
    : estimateTokens(buildSkillContext(skills))

  const projectRules = discoverProjectRules(session.workspaceRoot)
  const toolSummary = toolDefinitions
    .map((t: any) => `- ${t.name}: ${(t.description ?? '').split('\n')[0]}`)
    .join('\n')

  const fullSystemPrompt = session.frozenSystemPrompt ?? getStableSystemPrompt()

  // frozenSystemPrompt 已经包含 skillContext，把技能正文拆出来单独算一桶
  const rawSystemTokens = estimateTokens(fullSystemPrompt)
  const systemPromptTokens = Math.max(0, rawSystemTokens - skillsTokens)

  const toolsTokens = estimateTokens(JSON.stringify(toolDefinitions))

  // 把历史消息转成 ChatMessage 口径估算（含 toolCalls.arguments）
  const historyMessages: ChatMessage[] = session.messages
    .filter(m => m.role !== 'system')
    .map(m => ({
      role: m.role,
      content: extractTextFromSerializableContent(m.content),
      toolCalls: m.toolCalls?.map(tc => ({
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments
      }))
    }))

  const messagesTokens = estimateContextTokens(historyMessages)
  const otherTokens = 0

  const totalEstimated = systemPromptTokens + skillsTokens + toolsTokens + messagesTokens + otherTokens

  return {
    payload: {
      sessionId: session.id,
      messageId: '',
      breakdown: {
        systemPrompt: systemPromptTokens,
        skills: skillsTokens,
        tools: toolsTokens,
        messages: messagesTokens,
        other: otherTokens
      },
      totalEstimated,
      promptTokensActual: 0,
      capturedAt: Date.now(),
      contextLimit
    }
  }
}

/**
 * 根据 6 层 system prompt 结构重新生成 frozenSystemPrompt。
 * 用于旧会话没有持久化 frozenSystemPrompt 时兜底；如果会话已保存 frozenSystemPrompt，
 * 优先复用会话里的值以保证缓存前缀稳定。
 */
export function buildFrozenSystemPromptForSession(
  session: SessionData,
  skills: SkillManifest[]
): string {
  const skillContext = buildSkillContext(skills)
  return SystemPromptBuilder.build({
    agentRole: getStableSystemPrompt(),
    projectRules: discoverProjectRules(session.workspaceRoot),
    skillContext,
    modeInstruction: '',
    toolSummary: ''
  })
}
