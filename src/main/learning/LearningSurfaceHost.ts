import type {
  LearningNodeMaterialResult,
  LearningSourceResult,
  LearningSurfaceProjection
} from '../../shared/learning/surface'
import { parseLearningCommand } from '../../shared/learning/command'
import type { LearningCommand, LearningCommandReceipt } from '../../shared/learning/command'
import { extractChangedFilePaths } from '../../shared/learning/devChangeFiles'
import type { LearningDeliveryPorts, LearningDevChangeResult } from './LearningDelivery'
import type { LearningProgress } from '../../runtime/learning/progress/LearningProgress'
import type { ProjectKnowledgeReader } from '../../runtime/learning/knowledge/ProjectKnowledgeReader'
import type { SendAgentMessageDeps } from '../agent/turn/AgentTurnService'
import { getSessionStore } from '../services/SessionStoreHost'
import {
  ensureLearningDatabaseReady,
  getLearningKnowledgeReaderOrNull,
  getLearningProgressOrNull
} from './LearningDbHost'
import { isDevelopmentMode } from '../../shared/session/mode'
import { submitLearningCommandTurn } from './LearningHost'
import { cancelLearningBuild, getLearningBuildState, requestLearningBuild, setLearningBuildChangedListener } from './LearningKnowledgeHost'
import { readKnowledgeSource } from '../../runtime/learning/knowledge/evidence/WorkspaceEvidencePort'
import type { ModelClient } from '../../runtime/model/ModelClient'

let surfaceRevision = 0
let broadcaster: ((sessionId: string | null, workspaceRoot: string) => void) | null = null

export function setLearningSurfaceBroadcaster(fn: ((sessionId: string | null, workspaceRoot: string) => void) | null): void {
  broadcaster = fn
  // 大纲生成状态属于整个项目：同项目的学习会话都要刷新
  setLearningBuildChangedListener(fn ? workspaceRoot => {
    surfaceRevision += 1
    broadcaster?.(null, workspaceRoot)
  } : null)
}

/** 学习投影或停点写入后通知 Renderer 重新拉取；事件只是失效通知，不是第二份日志。 */
export function notifyLearningSurfaceChanged(sessionId: string): void {
  surfaceRevision += 1
  const session = getSessionStore().loadMetadata(sessionId)
  if (session) broadcaster?.(sessionId, session.workspaceRoot)
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

function requireKnowledgeReader(): ProjectKnowledgeReader {
  const reader = getLearningKnowledgeReaderOrNull()
  if (!reader) {
    throw new Error('学习数据库未就绪')
  }
  return reader
}

export async function loadLearningSurface(sessionId: string): Promise<LearningSurfaceProjection> {
  const { workspaceRoot } = requireLearnSession(sessionId)
  const progress = await requireProgress()
  const [surface, tree] = await Promise.all([
    progress.getSurface(workspaceRoot, sessionId),
    requireKnowledgeReader().getTreeProjection(workspaceRoot)
  ])
  return {
    sessionId,
    workspaceRoot,
    projectionRevision: surfaceRevision,
    cursorVersion: surface.cursorVersion,
    clearGeneration: surface.clearGeneration,
    selectedNodeId: surface.selectedNodeId,
    currentCheckpointId: surface.currentCheckpointId,
    questions: surface.questions,
    topicStartMessageIds: surface.topicStartMessageIds,
    nodeProgress: surface.nodeProgress,
    build: getLearningBuildState(workspaceRoot),
    tree
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
 * 校验开发改动来源并推导改动文件：会话真实存在、是开发会话、同一工作区、消息是助手回复。
 * 改动文件只从该消息持久化的写入/编辑记录推导，不接受 Renderer 自报。
 */
export function verifyDevLinkReference(
  workspaceRoot: string,
  devSessionId: string,
  devMessageId: string
): LearningDevChangeResult {
  const store = getSessionStore()
  const devSession = store.loadMetadata(devSessionId)
  if (!devSession || devSession.kind !== 'primary') {
    return { ok: false, message: '找不到这次改动所在的开发会话' }
  }
  if (!isDevelopmentMode(devSession.mode)) {
    return { ok: false, message: '这条回复不在开发会话里' }
  }
  if (devSession.workspaceRoot !== workspaceRoot) {
    return { ok: false, message: '这次改动不属于当前项目' }
  }
  const detail = store.load(devSessionId)
  const message = detail?.messages.find(item => item.id === devMessageId)
  if (!detail || !message) {
    return { ok: false, message: '找不到这条开发回复' }
  }
  if (message.role !== 'assistant') {
    return { ok: false, message: '这条消息不是开发回复' }
  }
  const files = extractChangedFilePaths(message.blocks)
  if (files.length === 0) {
    return { ok: false, message: '这条回复没有改过代码' }
  }
  return {
    ok: true,
    sessionTitle: detail.title ?? null,
    files,
    excerpt: extractText(message.content).slice(0, 600)
  }
}

function createDeliveryPorts(workspaceRoot: string): LearningDeliveryPorts {
  return {
    loadTopicTitle: async (nodeId) => {
      const reader = getLearningKnowledgeReaderOrNull()
      const material = reader ? await reader.getNodeMaterial(workspaceRoot, nodeId) : null
      return material?.title ?? null
    },
    loadDevChange: (devSessionId, devMessageId) =>
      verifyDevLinkReference(workspaceRoot, devSessionId, devMessageId)
  }
}

/** 接纳即返回；进度与结果经 learning:surface-changed 通知 Renderer 重新拉取投影。 */
export function startLearningBuild(sessionId: string, model: ModelClient | null): void {
  const { workspaceRoot } = requireLearnSession(sessionId)
  requestLearningBuild(workspaceRoot, model)
}

export function stopLearningBuild(sessionId: string): void {
  cancelLearningBuild(requireLearnSession(sessionId).workspaceRoot)
}

export async function loadLearningSource(sessionId: string, nodeId: string, receiptId: string): Promise<LearningSourceResult> {
  const { workspaceRoot } = requireLearnSession(sessionId)
  const result = await loadLearningNodeMaterial(sessionId, nodeId)
  if (!result.ok) return { ok: false, reason: 'unavailable', message: result.message }
  const source = result.material?.sources.find(item => item.receiptId === receiptId)
  if (!source) return { ok: false, reason: 'missing', message: '找不到这段代码了' }
  return readKnowledgeSource(workspaceRoot, source)
}

export interface LearningSurfaceCommandInput {
  readonly sessionId: string
  readonly command: unknown
}

/**
 * 学习表面命令入口：Renderer 只提交未知载荷，所有资格校验与服务端解析在此完成。
 * 命令已落库而回答启动失败时也要通知：投影必须反映已接纳的事实。
 */
export async function submitLearningSurfaceCommand(
  input: LearningSurfaceCommandInput,
  deps: SendAgentMessageDeps
): Promise<LearningCommandReceipt> {
  const { sessionId } = input
  const command = parseLearningCommand(input.command)
  const { workspaceRoot } = requireLearnSession(sessionId)
  const scoped: LearningCommand = { ...command, sessionId }
  const ports = createDeliveryPorts(workspaceRoot)

  // 改动来源在落库前校验：不合法的来源不应推进游标或留下交付意图
  if (scoped.action.type === 'explain_change') {
    const verified = ports.loadDevChange(scoped.action.devSessionId, scoped.action.devMessageId)
    if (!verified.ok) return { ok: false, code: 'invalid', message: verified.message }
  }

  try {
    const applied = await submitLearningCommandTurn(
      await requireProgress(),
      workspaceRoot,
      scoped,
      ports,
      deps
    )
    return applied.receipt
  } finally {
    notifyLearningSurfaceChanged(sessionId)
  }
}
