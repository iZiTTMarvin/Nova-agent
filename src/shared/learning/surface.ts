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

/** 某道核对问题的最新评估；disputed 表示用户不认同且尚未复核。 */
export interface LearningQuestionAssessmentView {
  readonly assessmentId: string
  readonly verdict: LearningAssessVerdict
  readonly summary: string
  readonly disputed: boolean
}

export interface LearningQuestionView {
  readonly checkpointId: string
  readonly question: string
  readonly state: LearningCheckpointUiState
  readonly createdAt: number
  readonly assessment: LearningQuestionAssessmentView | null
}

export interface LearningNodeProgressView {
  readonly nodeId: string
  readonly state: 'explained' | 'understanding_observed' | 'needs_clarification' | 'pending_review'
}

export type LearningBuildStage = 'collecting' | 'analyzing' | 'validating'

export type LearningBuildFailureReason =
  | 'no_model'
  | 'context_too_small'
  | 'invalid_output'
  | 'source_changed'
  | 'provider_error'
  | 'busy_other_project'
  | 'storage_unavailable'

/**
 * 大纲生成状态，由主进程调度器唯一写入。成功后回到 idle，是否已有大纲看 tree.nodes。
 * paused.autoResume 表示前台任务结束后会自动续接。
 */
export type LearningBuildState =
  | { readonly status: 'idle' }
  | { readonly status: 'queued' }
  | { readonly status: 'running'; readonly stage: LearningBuildStage }
  | { readonly status: 'paused'; readonly autoResume: boolean }
  | { readonly status: 'failed'; readonly reason: LearningBuildFailureReason; readonly detail?: string }

export type LearningSourceResult =
  | { readonly ok: true; readonly filePath: string; readonly startLine: number; readonly text: string; readonly changed: boolean }
  | { readonly ok: false; readonly reason: 'missing' | 'denied' | 'unavailable'; readonly message: string }

export interface LearningSurfaceProjection {
  readonly sessionId: string
  readonly workspaceRoot: string
  readonly projectionRevision: number
  readonly cursorVersion: number
  readonly clearGeneration: number
  readonly selectedNodeId: string | null
  /** 游标指向的当前问题；只有它可能处于 awaiting_answer。 */
  readonly currentCheckpointId: string | null
  /** 本会话全部核对问题，按创建时间升序。 */
  readonly questions: readonly LearningQuestionView[]
  /** 由「选主题」产生的用户消息 id，界面渲染为主题分隔线。 */
  readonly topicStartMessageIds: readonly string[]
  readonly nodeProgress: readonly LearningNodeProgressView[]
  readonly build: LearningBuildState
  readonly tree: KnowledgeTreeProjectionView
}

/** 节点材料读取结果：失败与「没有这个节点」都必须可辨认。 */
export type LearningNodeMaterialResult =
  | { ok: true; material: KnowledgeNodeMaterialView | null }
  | { ok: false; message: string }
