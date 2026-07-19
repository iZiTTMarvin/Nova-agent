/**
 * contextBreakdownCalculator — 会话级上下文容量拆分计算
 *
 * 设计原则：与 AgentLoop 生命周期解耦。打开已有会话、切换会话、LLM 调用后
 * 都需要显示上下文占用，但 AgentLoop 只在发送消息时创建，因此把计算逻辑
 * 抽成独立函数，供主进程任意时刻调用并 IPC 推送。
 *
 * messages 桶与模型实际 prompt 同口径：经 buildConversationContext 展开
 * toolCalls.result → role:'tool'，再用 estimateChatMessageTokens（含 arguments）。
 */
import { estimateTokens, estimateChatMessageTokens } from '../tokenEstimator'
import { SystemPromptBuilder } from '../promptBuilder/SystemPromptBuilder'
import { getStableSystemPrompt } from '../promptBuilder/modePrompt'
import { buildSkillContext } from '../promptBuilder/buildSkillContext'
import { discoverProjectRules } from './projectRulesDiscovery'
import { renderBaseRules } from '../promptRenderer'
import { buildConversationContext } from './contextBuilder'
import type { SessionData } from '../../sessions/types'
import type { SkillManifest } from '../../skills/types'
import type { ContextBreakdown } from '../../../shared/agent/contextBreakdown'

/** 从冻结 system prompt 中提取 SystemPromptBuilder 某层正文 */
function extractPromptLayer(frozenPrompt: string, layerTitle: string): string {
  const marker = `=== ${layerTitle} ===`
  const idx = frozenPrompt.indexOf(marker)
  if (idx === -1) return ''
  const start = idx + marker.length
  let end = frozenPrompt.indexOf('\n=== ', start)
  if (end === -1) end = frozenPrompt.length
  return frozenPrompt.slice(start, end).replace(/^\n/, '').trimEnd()
}

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

  const fullSystemPrompt = session.frozenSystemPrompt ?? getStableSystemPrompt()

  // tools 桶从 frozen prompt 的 Available Tools 层提取，避免与 JSON schema 重复计算
  const toolSummaryText = extractPromptLayer(fullSystemPrompt, 'Available Tools')
  const toolsTokens = toolSummaryText
    ? estimateTokens(toolSummaryText)
    : toolDefinitions.length > 0
      ? estimateTokens(
          toolDefinitions
            .map(t => {
              const def = t as { name?: string; description?: string }
              return `- ${def.name ?? 'unknown'}: ${(def.description ?? '').split('\n')[0]}`
            })
            .join('\n')
        )
      : 0

  const rawSystemTokens = estimateTokens(fullSystemPrompt)
  const systemPromptTokens = Math.max(0, rawSystemTokens - skillsTokens - toolsTokens)

  // 与 injectHistory / 模型 prompt 同口径：展开 tool result，计入 arguments
  const runtimeMessages = buildConversationContext(session, session.mode)
  const messagesTokens = runtimeMessages.reduce(
    (sum, m) => sum + estimateChatMessageTokens(m),
    0
  )
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
    baseRules: renderBaseRules(),
    projectRules: discoverProjectRules(session.workspaceRoot)?.text ?? '',
    skillContext,
    modeInstruction: '',
    toolSummary: ''
  })
}
