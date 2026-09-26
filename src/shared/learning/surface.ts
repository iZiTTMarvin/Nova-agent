import { LEARNING_MAX_COMMAND_ID_LENGTH } from './limits'
import type { LearningZeroModelNavigationView } from './navigation'
import type {
  KnowledgeNodeMaterialView,
  KnowledgeTreeProjectionView
} from './knowledgeProjection'
import type { LearningAssessVerdict } from './rubric'

export type LearningCheckpointUiState =
  | 'awaiting_answer'
  | 'answer_pending'
  | 'answered'
  | 'skipped'
  | 'superseded'

export interface LearningCheckpointView {
  readonly checkpointId: string
  readonly question: string
  readonly state: LearningCheckpointUiState
  readonly cursorVersion: number
  readonly createdAt: number
}

export interface LearningAssessmentView {
  readonly assessmentId: string
  readonly checkpointId: string
  readonly verdict: LearningAssessVerdict
  readonly summary: string
  readonly userQuote: string
  readonly disputed: boolean
  readonly createdAt: number
}

/** 当前有效理解证据的计数，不代表永久掌握。 */
export interface LearningProgressSummaryView {
  readonly independentCount: number
  readonly needsClarificationCount: number
  readonly pendingReviewNodeCount: number
}

export interface LearningNodeProgressView {
  readonly nodeId: string
  readonly state: 'explained' | 'understanding_observed' | 'needs_clarification' | 'pending_review'
}

export type LearningBuildState =
  | { readonly status: 'idle' | 'running' | 'ready' | 'cancelled' }
  | { readonly status: 'failed'; readonly message: string }

export type LearningSourceResult =
  | { readonly ok: true; readonly filePath: string; readonly startLine: number; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly message: string }

export interface LearningSurfaceProjection {
  readonly sessionId: string
  readonly workspaceRoot: string
  readonly projectionRevision: number
  readonly cursorVersion: number
  readonly clearGeneration: number
  readonly selectedNodeId: string | null
  readonly checkpoint: LearningCheckpointView | null
  readonly latestAssessment: LearningAssessmentView | null
  readonly summary: LearningProgressSummaryView
  readonly nodeProgress: readonly LearningNodeProgressView[]
  readonly build: LearningBuildState
  readonly navigation: LearningZeroModelNavigationView
  readonly tree: KnowledgeTreeProjectionView
}

function readBoundedString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new Error(`learning: ${field} 必须是字符串`)
  }
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > maxLength) {
    throw new Error(`learning: ${field} 长度无效`)
  }
  return trimmed
}

function readNonNegativeInt(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`learning: ${field} 必须是非负整数`)
  }
  return value as number
}

export interface LearningDevLinkFileRef {
  readonly filePath: string
}

/** 节点材料读取结果：失败与「没有这个节点」都必须可辨认。 */
export type LearningNodeMaterialResult =
  | { ok: true; material: KnowledgeNodeMaterialView | null }
  | { ok: false; message: string }

/** 开发 → 学习携带的改动线索；主进程逐项校验后才进入教练上下文。 */
export interface LearningDevLinkReference {
  readonly devSessionId: string
  readonly devMessageId: string
  readonly filePaths: readonly string[]
}

export const LEARNING_MAX_DEV_LINK_FILES = 8
export const LEARNING_MAX_DEV_LINK_PATH_LENGTH = 512

function readDevLinkFilePaths(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    throw new Error('learning: filePaths 必须是数组')
  }
  if (value.length > LEARNING_MAX_DEV_LINK_FILES) {
    throw new Error('learning: filePaths 超出上限')
  }
  return value.map(item =>
    readBoundedString(item, 'filePath', LEARNING_MAX_DEV_LINK_PATH_LENGTH)
  )
}

export function parseLearningDevLinkReference(raw: unknown): LearningDevLinkReference {
  if (!raw || typeof raw !== 'object') {
    throw new Error('learning: 开发关联引用必须是对象')
  }
  const value = raw as Record<string, unknown>
  return {
    devSessionId: readBoundedString(
      value.devSessionId,
      'devSessionId',
      LEARNING_MAX_COMMAND_ID_LENGTH
    ),
    devMessageId: readBoundedString(
      value.devMessageId,
      'devMessageId',
      LEARNING_MAX_COMMAND_ID_LENGTH
    ),
    filePaths: readDevLinkFilePaths(value.filePaths ?? [])
  }
}
