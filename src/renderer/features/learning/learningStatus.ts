/** 学习表面状态词汇：节点材料状态、停点状态、评估结论的统一可辨外文案。 */
import type { KnowledgeNodeMaterialStatus } from '../../../shared/learning/knowledgeProjection'
import type { LearningCheckpointUiState } from '../../../shared/learning/surface'
import type { LearningAssessVerdict } from '../../../shared/learning/rubric'

const MATERIAL_STATUS_LABELS: Record<KnowledgeNodeMaterialStatus, string> = {
  verified: '已核实',
  partial: '部分可用',
  unverified: '待整理',
  stale: '待复核'
}

export function nodeMaterialStatusLabel(status: KnowledgeNodeMaterialStatus): string {
  return MATERIAL_STATUS_LABELS[status]
}

export function isNodeMaterialStale(status: KnowledgeNodeMaterialStatus): boolean {
  return status === 'stale'
}

const CHECKPOINT_STATE_LABELS: Record<LearningCheckpointUiState, string> = {
  awaiting_answer: '等待回答',
  answer_pending: '回答已保存，等待评估',
  answered: '已回答',
  skipped: '已跳过',
  superseded: '已被新问题取代'
}

export function checkpointStateLabel(state: LearningCheckpointUiState): string {
  return CHECKPOINT_STATE_LABELS[state]
}

const VERDICT_LABELS: Record<LearningAssessVerdict, string> = {
  understanding_observed: '观察到独立理解',
  needs_clarification: '需要澄清',
  inconclusive: '证据不足'
}

export function assessmentVerdictLabel(verdict: LearningAssessVerdict): string {
  return VERDICT_LABELS[verdict]
}

const NAV_STATUS_LABELS: Record<'verified' | 'inference' | 'pending_review' | 'empty', string> = {
  verified: '已核实',
  inference: '含推断',
  pending_review: '待核实',
  empty: '待整理'
}

export function navEntryStatusLabel(
  status: 'verified' | 'inference' | 'pending_review' | 'empty'
): string {
  return NAV_STATUS_LABELS[status]
}
