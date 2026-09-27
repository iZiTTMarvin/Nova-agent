import type {
  LearningCheckpointUiState,
  LearningDevLinkReference,
  LearningNodeMaterialResult,
  LearningSurfaceProjection
} from '../../shared/learning/surface'
import { parseLearningDevLinkReference } from '../../shared/learning/surface'
import { parseLearningCommand } from '../../shared/learning/command'
import type { LearningCommand, LearningCommandReceipt } from '../../shared/learning/command'
import type { LearningProgress } from '../../runtime/learning/progress/LearningProgress'
import { LearningKnowledgeSurface } from '../../runtime/learning/knowledge/LearningKnowledgeSurface'
import type { SendAgentMessageDeps } from '../agent/turn/AgentTurnService'
import { getSessionStore } from '../services/SessionStoreHost'
import {
  ensureLearningDatabaseReady,
  getLearningKnowledgeReaderOrNull,
  getLearningProgressOrNull
} from './LearningDbHost'
import { isDevelopmentMode } from '../../shared/session/mode'
import { submitLearningCommandTurn } from './LearningHost'
import { buildLearningKnowledge, cancelLearningBuild, getLearningBuildState } from './LearningKnowledgeHost'
import { readKnowledgeSource } from '../../runtime/learning/knowledge/evidence/WorkspaceEvidencePort'
import type { ModelClient } from '../../runtime/model/ModelClient'

let surfaceRevision = 0
let broadcaster: ((sessionId: string, workspaceRoot: string) => void) | null = null

export function setLearningSurfaceBroadcaster(fn: ((sessionId: string, workspaceRoot: string) => void) | null): void {
  broadcaster = fn
}

/** 学习投影或停点写入后通知 Renderer 重新拉取；事件只是失效通知，不是第二份日志。 */
export function notifyLearningSurfaceChanged(sessionId: string): void {
  surfaceRevision += 1
  const session = getSessionStore().loadMetadata(sessionId)
  if (session) broadcaster?.(sessionId, session.workspaceRoot)
}

const CHECKPOINT_UI_STATES: readonly LearningCheckpointUiState[] = [
  'awaiting_answer',
  'answer_pending',
  'answered',
  'skipped',
  'superseded'
]

function toCheckpointUiState(state: string): LearningCheckpointUiState {
  if (!CHECKPOINT_UI_STATES.includes(state as LearningCheckpointUiState)) {
    throw new Error(`学习停点状态非法: ${state}`)
  }
  return state as LearningCheckpointUiState
}

function requireLearnSession(sessionId: string): { sessionId: string; workspaceRoot: string } {
  const store = getSessionStore()
  const session = store.loadMetadata(sessionId)
  if (!session) {
    throw new Error('学习会话不存在')
  }
  if (session.kind !== 'primary') {
    throw new Error('子会话不能作为学习表面')
  }
  if (session.mode !== 'learn') {
    throw new Error('目标会话不是学习会话')
  }
  return { sessionId, workspaceRoot: session.workspaceRoot }
}

async function requireProgress(): Promise<LearningProgress> {
  await ensureLearningDatabaseReady()
  const progress = getLearningProgressOrNull()
  if (!progress) {
    throw new Error('学习数据库未就绪')
  }
  return progress
}

function requireKnowledgeSurface(): LearningKnowledgeSurface {
  const reader = getLearningKnowledgeReaderOrNull()
  if (!reader) {
    throw new Error('学习数据库未就绪')
  }
  return new LearningKnowledgeSurface(reader)
}

export async function loadLearningSurface(sessionId: string): Promise<LearningSurfaceProjection> {
  const { workspaceRoot } = requireLearnSession(sessionId)
  const progress = await requireProgress()
  const [surface, knowledge] = await Promise.all([
    progress.getSurface(workspaceRoot, sessionId),
    requireKnowledgeSurface().loadView(workspaceRoot)
  ])
  return {
    sessionId,
    workspaceRoot,
    projectionRevision: surfaceRevision,
    cursorVersion: surface.cursorVersion,
    clearGeneration: surface.clearGeneration,
    selectedNodeId: surface.selectedNodeId,
    nodeProgress: surface.nodeProgress,
    build: getLearningBuildState(workspaceRoot),
    checkpoint: surface.checkpoint
      ? {
          checkpointId: surface.checkpoint.checkpointId,
          question: surface.checkpoint.question,
          state: toCheckpointUiState(surface.checkpoint.state),
          cursorVersion: surface.checkpoint.cursorVersion,
          createdAt: surface.checkpoint.createdAt
        }
      : null,
    latestAssessment: surface.latestAssessment
      ? {
          assessmentId: surface.latestAssessment.assessmentId,
          checkpointId: surface.latestAssessment.checkpointId,
          verdict: surface.latestAssessment.verdict,
          summary: surface.latestAssessment.summary,
          userQuote: surface.latestAssessment.userQuote,
          disputed: surface.latestAssessment.disputed,
          createdAt: surface.latestAssessment.createdAt
        }
      : null,
    summary: {
      ...surface.summary,
      // 待复核计数与界面共用同一份树投影，不另做一遍 join
      pendingReviewNodeCount: knowledge.tree.nodes.filter(
        node => node.materialStatus === 'stale'
      ).length
    },
    navigation: knowledge.navigation,
    tree: knowledge.tree
  }
}

export async function loadLearningNodeMaterial(
  sessionId: string,
  nodeId: string
): Promise<LearningNodeMaterialResult> {
  try {
    const { workspaceRoot } = requireLearnSession(sessionId)
    await requireProgress()
    const reader = getLearningKnowledgeReaderOrNull()
    if (!reader) {
      return { ok: false, message: '学习数据库未就绪' }
    }
    const material = await reader.getNodeMaterial(workspaceRoot, nodeId.trim())
    return { ok: true, material }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string') parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * 校验开发关联引用：会话真实存在、是开发会话、同一工作区、消息真实存在。
 * Renderer 自报的项目归属与消息线索不可信，逐项以 SessionStore 为准。
 */
export function verifyDevLinkReference(
  workspaceRoot: string,
  reference: LearningDevLinkReference
): { ok: true; assistantExcerpt: string } | { ok: false; message: string } {
  const store = getSessionStore()
  const devSession = store.loadMetadata(reference.devSessionId)
  if (!devSession || devSession.kind !== 'primary') {
    return { ok: false, message: '来源开发会话不存在' }
  }
  if (!isDevelopmentMode(devSession.mode)) {
    return { ok: false, message: '来源会话不是开发会话' }
  }
  if (devSession.workspaceRoot !== workspaceRoot) {
    return { ok: false, message: '来源会话不属于当前项目' }
  }
  const detail = store.load(reference.devSessionId)
  const message = detail?.messages.find(item => item.id === reference.devMessageId)
  if (!detail || !message) {
    return { ok: false, message: '来源消息不存在' }
  }
  if (message.role !== 'assistant') {
    return { ok: false, message: '来源消息不是开发结果' }
  }
  return { ok: true, assistantExcerpt: extractText(message.content).slice(0, 600) }
}

/** 开发改动线索进入教练上下文：只带文件与短摘录，不复制整段开发历史。 */
export function formatDevLinkTurnContent(
  reference: LearningDevLinkReference,
  assistantExcerpt: string
): string {
  const files = reference.filePaths.map(path => `- ${path}`).join('\n')
  return [
    '[学习请求] 用户想学懂开发会话里这次改动背后的核心机制与设计思想。',
    '请从该改动解决的实际场景痛点出发，用通俗日常语言拆解因果逻辑与设计权衡，不要汇报验证或测试流水账；再对照相关代码关键位置做事实定位。',
    files ? `相关文件:\n${files}` : '相关文件: （未提供）',
    '开发结果摘录（仅供定位，不代表当前实现，请先核对当前代码）:',
    assistantExcerpt || '（无文本摘录）'
  ].join('\n')
}

export async function startLearningBuild(sessionId: string, model: ModelClient | null): Promise<void> {
  const { workspaceRoot } = requireLearnSession(sessionId)
  await buildLearningKnowledge(workspaceRoot, model, () => notifyLearningSurfaceChanged(sessionId))
}

export function stopLearningBuild(sessionId: string): void {
  cancelLearningBuild(requireLearnSession(sessionId).workspaceRoot)
}

export async function loadLearningSource(sessionId: string, nodeId: string, receiptId: string) {
  const { workspaceRoot } = requireLearnSession(sessionId)
  const result = await loadLearningNodeMaterial(sessionId, nodeId)
  if (!result.ok) return result
  const source = result.material?.sources.find(item => item.receiptId === receiptId)
  if (!source) return { ok: false as const, message: '出处不属于当前节点' }
  return readKnowledgeSource(workspaceRoot, source)
}

export interface LearningSurfaceCommandInput {
  readonly sessionId: string
  readonly command: unknown
  readonly devReference?: unknown
}

/**
 * 学习表面命令入口：Renderer 只提交未知载荷，所有资格校验与服务端解析在此完成。
 * 命令已落库而教练 turn 启动失败时也要通知：投影必须反映已接纳的事实（§9.4）。
 */
export async function submitLearningSurfaceCommand(
  input: LearningSurfaceCommandInput,
  deps: SendAgentMessageDeps
): Promise<LearningCommandReceipt> {
  const { sessionId } = input
  const command = parseLearningCommand(input.command)
  const { workspaceRoot } = requireLearnSession(sessionId)
  const scoped: LearningCommand = { ...command, sessionId }

  const devReference =
    input.devReference === undefined || input.devReference === null
      ? null
      : parseLearningDevLinkReference(input.devReference)

  try {
    if (devReference && scoped.action.type === 'message') {
      const verified = verifyDevLinkReference(workspaceRoot, devReference)
      if (!verified.ok) {
        throw new Error(verified.message)
      }
      const enriched: LearningCommand = {
        ...scoped,
        action: {
          type: 'message',
          text: formatDevLinkTurnContent(devReference, verified.assistantExcerpt)
        }
      }
      const applied = await submitLearningCommandTurn(
        await requireProgress(),
        workspaceRoot,
        enriched,
        deps
      )
      return applied.receipt
    }

    const applied = await submitLearningCommandTurn(
      await requireProgress(),
      workspaceRoot,
      scoped,
      deps
    )
    return applied.receipt
  } finally {
    notifyLearningSurfaceChanged(sessionId)
  }
}
