/**
 * MemoryExtractHost — 显式/评测用 LLM 候选提炼与零 LLM episodic 调度（主进程）。
 *
 * 正常 Agent 生命周期不再自动启动独立提炼模型：长期结构化记忆由主 Agent 通过
 * memory_manage 自主维护。每 N 个完成用户回合与会话退出只负责零 LLM episodic 落盘，
 * 避免额外模型请求、重复判断和主会话 prompt cache 无法复用的问题。
 *
 * runMemoryExtract / scheduleMemoryExtract 继续保留给显式调用、测试与评测。
 */
import { app } from 'electron'
import type { ChatMessage } from '../../runtime/model/types'
import type { ModelClient } from '../../runtime/model/ModelClient'
import { createModelClient } from './createModelClient'
import { loadModelConfig } from '../../runtime/model/config'
import {
  MemoryExtractor,
  projectExtractionMessages,
  type MemoryExtractorDeps
} from '../../runtime/memory/extraction/MemoryExtractor'
import { consolidateFallback } from '../../runtime/memory/MemoryConsolidator'
import {
  getObservationCaptureForSession,
  type MemoryObservation
} from '../../runtime/memory/ObservationCapture'
import { computeWorkspaceHash } from '../../runtime/memory/MemoryPaths'
import { MEMORY_TOOL_NAMES } from '../../runtime/memory/memoryTools'
import type { MemoryCandidate } from '../../runtime/memory/types'
import {
  MEMORY_EXTRACT_INTERVAL_TURNS,
  MEMORY_EXTRACT_WINDOW_SIZE
} from '../../runtime/memory/memoryConfig'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'
import { getMemoryService, getMemoryCandidateProcessor } from './MemoryServiceHost'
import { drainAndPersistSync, drainAndSchedulePersist } from './MemoryConsolidationHost'
import type { SessionStore } from '../../runtime/sessions/SessionStore'
import { buildConversationContext } from '../../runtime/sessions'

/** sessionId → 自上次 episodic 落盘以来的用户回合数 */
const userTurnsSinceExtract = new Map<string, number>()

/** 记忆总开关；显式提炼辅助函数与 episodic 生命周期均受它控制。 */
export function isMemoryExtractEnabled(): boolean {
  return loadNovaSettings().memoryEnabled
}

/** 单测：重置回合计数 */
export function resetExtractTurnCountersForTests(): void {
  userTurnsSinceExtract.clear()
}

/**
 * 用户回合结束：仍沿用 N-turn cadence，但只做零 LLM episodic 落盘。
 * 结构化长期记忆由当前主 Agent 在工作过程中按需调用 memory_manage，不再后台二次判断。
 */
export function onUserTurnCompleteForExtract(sessionId: string, workspaceRoot: string): void {
  if (!isMemoryExtractEnabled()) {
    return
  }

  const next = (userTurnsSinceExtract.get(sessionId) ?? 0) + 1
  if (next < MEMORY_EXTRACT_INTERVAL_TURNS) {
    userTurnsSinceExtract.set(sessionId, next)
    return
  }

  userTurnsSinceExtract.set(sessionId, 0)
  drainAndSchedulePersist(sessionId, workspaceRoot)
}

/** 会话退出：同步固化剩余 observation；禁止退出时额外启动 LLM。 */
export function extractOnSessionLeave(sessionId: string, workspaceRoot: string): void {
  userTurnsSinceExtract.delete(sessionId)
  if (!isMemoryExtractEnabled()) {
    return
  }
  drainAndPersistSync(sessionId, workspaceRoot)
}

/**
 * 显式 fire-and-forget LLM 提炼入口。
 * 正常 Agent turn / session leave 不再调用；保留给测试、评测与手动维护场景，
 * 删除条件：agent-managed 写入与后台提炼的 A/B 对比评测结论落定后移除。
 */
export function scheduleMemoryExtract(
  sessionId: string,
  workspaceRoot: string,
  sessionStore: SessionStore,
  options: { sync?: boolean } = {}
): void {
  const run = () => {
    void runMemoryExtract(sessionId, workspaceRoot, sessionStore).catch((err) => {
      console.error('[MemoryExtract] 提炼失败，已降级：', err)
    })
  }

  if (options.sync) {
    run()
  } else {
    setImmediate(run)
  }
}

/**
 * 执行一轮显式提炼：LLM 候选 → 确定性 policy 落库；episodic 历史始终零 LLM 落盘。
 * 提炼失败（null/空候选）只跳过结构化写入，降级路径与成功路径共用 episodic 落盘。
 */
export async function runMemoryExtract(
  sessionId: string,
  workspaceRoot: string,
  sessionStore: SessionStore
): Promise<void> {
  if (!isMemoryExtractEnabled()) {
    return
  }

  const capture = getObservationCaptureForSession(sessionId)
  // 进入提炼即视为本轮消费：无论后续成败，buffer 都已取出，避免下一轮重复处理同一批 observations。
  const observations = capture.drainForExtract(sessionId)
  const session = sessionStore.load(sessionId)
  const recentMessages = excludeMemoryToolMessages(
    projectExtractionMessages(
      session ? buildConversationContext(session, session.mode) : []
    )
  ).slice(-MEMORY_EXTRACT_WINDOW_SIZE)

  if (recentMessages.length === 0 && observations.length === 0) {
    capture.drainWorkingBuffer(sessionId)
    return
  }

  const scopeId = computeWorkspaceHash(workspaceRoot)
  const extractor = new MemoryExtractor({ chat: createExtractChatFn() })
  const candidates = await extractor.extract({ sessionId, recentMessages, observations })

  if (candidates && candidates.length > 0) {
    processCandidates(scopeId, sessionId, workspaceRoot, candidates)
  }
  await persistFallback(scopeId, sessionId, capture, observations)
}

/**
 * 剥离记忆工具调用及对应结果，防止「刚检索/写入的记忆」再次成为 extractor 的
 * 新证据而自我强化；名单见 memoryTools 单一来源。
 */
function excludeMemoryToolMessages(messages: readonly ChatMessage[]): ChatMessage[] {
  const excludedToolCallIds = new Set<string>()
  const projected = messages.map((message) => {
    if (message.role !== 'assistant' || !message.toolCalls?.length) return message
    const toolCalls = message.toolCalls.filter((call) => {
      if (!MEMORY_TOOL_NAMES.has(call.name)) return true
      excludedToolCallIds.add(call.id)
      return false
    })
    if (toolCalls.length === message.toolCalls.length) return message
    return { ...message, toolCalls: toolCalls.length > 0 ? toolCalls : undefined }
  })
  return projected.filter(
    (message) => message.role !== 'tool' || !message.toolCallId || !excludedToolCallIds.has(message.toolCallId)
  )
}

/** 候选 → policy → 结构化落库；仅输出计数日志，失败不阻塞 episodic 落盘 */
function processCandidates(
  scopeId: string,
  sessionId: string,
  workspaceRoot: string,
  candidates: readonly MemoryCandidate[]
): void {
  try {
    const counts = getMemoryCandidateProcessor().process({
      sessionId,
      projectScopeId: scopeId,
      workspaceRoot,
      candidates
    })
    console.log(`[MemoryExtract] 候选落库 session=${sessionId} ${JSON.stringify(counts)}`)
  } catch (err) {
    console.error('[MemoryExtract] 候选落库失败（结构化记忆跳过，episodic 照常）：', err)
  }
}

async function persistFallback(
  scopeId: string,
  sessionId: string,
  capture: ReturnType<typeof getObservationCaptureForSession>,
  observations: readonly MemoryObservation[]
): Promise<void> {
  if (observations.length === 0) {
    return
  }
  const markdown = consolidateFallback(observations)
  if (!markdown.trim()) {
    return
  }
  try {
    getMemoryService().appendEpisodicSummary(scopeId, markdown)
    capture.drainWorkingBuffer(sessionId)
  } catch (err) {
    console.error('[MemoryExtract] 降级落盘失败：', err)
  }
}

/**
 * 构造显式提炼 chat 函数。
 *
 * 关键约束：必须使用独立 ModelClient 实例，**绝不**在主对话的 modelPool 上
 * 临时改配置——显式提炼可能与主对话并发，若在共享 pool 上 updateConfig
 * （哪怕 finally 改回），主对话那一轮的 reasoningEffort 会被悄悄降级，构成静默竞态。
 *
 * 因此每次调用都新建独立 client（带 reasoningEffort=low）。
 */
export function createExtractChatFn(): MemoryExtractorDeps['chat'] {
  return async (messages, opts) => {
    const effort = opts?.reasoningEffort ?? 'low'
    const client = buildExtractModelClient(effort)
    if (!client) {
      throw new Error('无法构造提炼模型客户端（检查模型配置）')
    }

    let text = ''
    const stream = client.chat(messages)
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        text += event.delta
      }
    }
    return text
  }
}

/** 从持久化配置构造一次性 client；reasoningEffort 默认 low（显式提炼无需高强度思考） */
function buildExtractModelClient(reasoningEffort: 'low' = 'low'): ModelClient | null {
  try {
    const config = loadModelConfig(app.getPath('userData'))
    if (!config?.apiKey?.trim()) {
      return null
    }
    return createModelClient({ ...config, reasoningEffort })
  } catch {
    return null
  }
}
