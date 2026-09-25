import type { KnowledgeClaim } from '../../../shared/learning/knowledgeClaim'
import { parseKnowledgeClaims } from '../../../shared/learning/knowledgeClaim'
import type { LearningNavDimensionId } from '../../../shared/learning/navigation'
import { LEARNING_NAV_DIMENSIONS } from '../../../shared/learning/navigation'
import type { KnowledgeNodeMaterialStatus } from '../../../shared/learning/knowledgeProjection'

export interface PublishedNodeBody {
  readonly summary: string
  readonly learningGoal: string
  readonly claims: readonly KnowledgeClaim[]
  readonly materialStatus: KnowledgeNodeMaterialStatus
  readonly navDimension: LearningNavDimensionId | null
  readonly parentNodeId: string | null
  readonly unreadNote?: string
}

export function serializeNodeBody(body: PublishedNodeBody): string {
  return JSON.stringify(body)
}

export function parsePublishedNodeBody(bodyJson: string): PublishedNodeBody {
  const raw = JSON.parse(bodyJson) as Record<string, unknown>
  const nav = raw.navDimension
  const navDimension =
    typeof nav === 'string' && (LEARNING_NAV_DIMENSIONS as readonly string[]).includes(nav)
      ? (nav as LearningNavDimensionId)
      : null
  return {
    summary: String(raw.summary ?? ''),
    learningGoal: String(raw.learningGoal ?? ''),
    claims: parseKnowledgeClaims(raw.claims ?? []),
    materialStatus: (raw.materialStatus as KnowledgeNodeMaterialStatus) ?? 'unverified',
    navDimension,
    parentNodeId: typeof raw.parentNodeId === 'string' ? raw.parentNodeId : null,
    unreadNote: typeof raw.unreadNote === 'string' ? raw.unreadNote : undefined
  }
}

export function nodeSummaryFromBody(title: string, body: PublishedNodeBody): string {
  if (body.summary.trim()) return body.summary.trim()
  return title
}
