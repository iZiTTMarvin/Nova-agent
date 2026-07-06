/**
 * MemoryExtractHost — LLM 提炼调度与落盘（主进程）
 *
 * 触发：每 5 个用户回合 + 会话退出。
 * 强降级：提炼失败回退零 LLM consolidateObservations，绝不影响主对话。
 */
import { app } from 'electron'
import type { ChatMessage } from '../../runtime/model/types'
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { ModelClientPool } from '../../runtime/model/ModelClientPool'
import { OpenAICompatibleModelClient } from '../../runtime/model/OpenAICompatibleModelClient'
import { loadModelConfig } from '../../runtime/model/config'
import { MemoryExtractor, type MemoryExtractorDeps } from '../../runtime/memory/MemoryExtractor'
import {
  consolidateExtracted,
  consolidateFallback
} from '../../runtime/memory/MemoryConsolidator'
import {
  getObservationCaptureForSession,
  type MemoryObservation
} from '../../runtime/memory/ObservationCapture'
import { computeWorkspaceHash } from '../../runtime/memory/MemoryPaths'
import { loadNovaSettings } from '../../runtime/settings/novaSettings'
import { getMemoryService } from './MemoryServiceHost'
import { drainAndPersistSync } from './MemoryConsolidationHost'
import type { SessionStore } from '../../runtime/sessions/SessionStore'

/** 每 N 个用户回合触发一次提炼 */
export const EXTRACT_INTERVAL_TURNS = 5

/** sessionId → 自上次提炼以来的用户回合数 */
const userTurnsSinceExtract = new Map<string, number>()

/**
 * 提炼是否启用：开启记忆即启用。
 * 子开关（memoryExtractEnabled / memoryCaptureEnabled / memoryEpisodicSummaryEnabled）
 * 默认全 true，由 memoryEnabled 一键统控，避免用户漏开导致功能静默失效。
 */
export function isMemoryExtractEnabled(): boolean {
  return loadNovaSettings().memoryEnabled
}

/** 单测：重置回合计数 */
export function resetExtractTurnCountersForTests(): void {
  userTurnsSinceExtract.clear()
}

/** 用户回合结束：递增计数，满 N 则 fire-and-forget 提炼 */
export function onUserTurnCompleteForExtract(
  sessionId: string,
  workspaceRoot: string,
  sessionStore: SessionStore,
  modelPool: ModelClient | ModelClientPool
): void {
  if (!isMemoryExtractEnabled()) {
    return
  }

  const next = (userTurnsSinceExtract.get(sessionId) ?? 0) + 1
  if (next < EXTRACT_INTERVAL_TURNS) {
    userTurnsSinceExtract.set(sessionId, next)
    return
  }

  userTurnsSinceExtract.set(sessionId, 0)
  scheduleMemoryExtract(sessionId, workspaceRoot, sessionStore, modelPool)
}

/** 会话退出：无论计数多少，固化未提炼尾巴 */
export function extractOnSessionLeave(
  sessionId: string,
  workspaceRoot: string,
  sessionStore: SessionStore
): void {
  userTurnsSinceExtract.delete(sessionId)
  if (!isMemoryExtractEnabled()) {
    return
  }

  const modelClient = buildExtractModelClient()
  if (!modelClient) {
    // 退出场景拿不到可用模型配置（如 OAuth token 已过期、apiKey 为空），
    // 退出提炼本就是 best-effort，回退零 LLM 路径并记 warn 便于排查。
    console.warn(
      `[MemoryExtract] 会话退出提炼：无法构造模型 client（配置缺失或失效），` +
      `回退零 LLM 落盘。session=${sessionId}`
    )
    drainAndPersistSync(sessionId, workspaceRoot)
    return
  }

  scheduleMemoryExtract(sessionId, workspaceRoot, sessionStore, modelClient, { sync: true })
}

/** fire-and-forget 调度提炼 */
export function scheduleMemoryExtract(
  sessionId: string,
  workspaceRoot: string,
  sessionStore: SessionStore,
  modelPool: ModelClient | ModelClientPool,
  options: { sync?: boolean } = {}
): void {
  const run = () => {
    void runMemoryExtract(sessionId, workspaceRoot, sessionStore, modelPool).catch((err) => {
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
 * 执行一轮提炼：LLM → episodic / 可选 autoMerge；失败走零 LLM 降级。
 */
export async function runMemoryExtract(
  sessionId: string,
  workspaceRoot: string,
  sessionStore: SessionStore,
  modelPool: ModelClient | ModelClientPool
): Promise<void> {
  if (!isMemoryExtractEnabled()) {
    return
  }

  const capture = getObservationCaptureForSession(sessionId)
  // 进入提炼即视为本轮消费：无论后续成败，buffer 都已取出，避免下一轮重复处理同一批 observations。
  const observations = capture.drainForExtract(sessionId)
  const session = sessionStore.load(sessionId)
  const recentMessages: ChatMessage[] = (session?.messages ?? []).slice(-50) as ChatMessage[]

  if (recentMessages.length === 0 && observations.length === 0) {
    capture.drainWorkingBuffer(sessionId)
    return
  }

  const scopeId = computeWorkspaceHash(workspaceRoot)
  const settings = loadNovaSettings()
  const extractor = new MemoryExtractor({ chat: createExtractChatFn(modelPool) })

  const extracted = await extractor.extract({ recentMessages, observations })

  if (!extracted || extracted.length === 0) {
    await persistFallback(scopeId, sessionId, capture, observations)
    return
  }

  const { episodicMarkdown, memoryAppendMarkdown } = consolidateExtracted(
    extracted,
    sessionId,
    { autoMergeEnabled: settings.memoryAutoMergeEnabled }
  )

  persistExtracted(scopeId, episodicMarkdown, memoryAppendMarkdown)
  capture.drainWorkingBuffer(sessionId)
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

function persistExtracted(
  scopeId: string,
  episodicMarkdown: string,
  memoryAppendMarkdown: string
): void {
  try {
    const memoryService = getMemoryService()
    if (episodicMarkdown.trim()) {
      memoryService.appendEpisodicSummary(scopeId, episodicMarkdown)
    }
    if (memoryAppendMarkdown.trim()) {
      memoryService.appendMemoryMd(scopeId, memoryAppendMarkdown)
    }
  } catch (err) {
    console.error('[MemoryExtract] 落盘失败：', err)
  }
}

/**
 * 构造提炼 chat 函数。
 *
 * 关键约束：必须使用独立 ModelClient 实例，**绝不**在主对话的 modelPool 上
 * 临时改配置——提炼是 setImmediate fire-and-forget，与主对话并发，若在共享
 * pool 上 updateConfig（哪怕 finally 改回），主对话那一轮的 reasoningEffort
 * 会被悄悄降级，构成静默的并发数据竞争。
 *
 * 因此每次调用都新建 OpenAICompatibleModelClient（带 reasoningEffort=low），
 * 不触碰主 pool。modelPool 参数仅保留以兼容调用签名，实际不使用。
 */
export function createExtractChatFn(
  _modelPool: ModelClient | ModelClientPool
): MemoryExtractorDeps['chat'] {
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

/** 从持久化配置构造一次性 client；reasoningEffort 默认 low（提炼无需高强度思考） */
function buildExtractModelClient(reasoningEffort: 'low' = 'low'): ModelClient | null {
  try {
    const config = loadModelConfig(app.getPath('userData'))
    if (!config?.apiKey?.trim()) {
      return null
    }
    return new OpenAICompatibleModelClient({ ...config, reasoningEffort })
  } catch {
    return null
  }
}
