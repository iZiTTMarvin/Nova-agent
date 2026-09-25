import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  emptyNavigationDimensions,
  type LearningNavDimensionView,
  type LearningNavEntryStatus,
  type LearningZeroModelNavigationView,
  type LearningNavDimensionId,
  learningNavDimensionLabel,
  LEARNING_NAV_DIMENSIONS
} from '../../../shared/learning/navigation'
import type { KnowledgeTreeProjectionView } from '../../../shared/learning/knowledgeProjection'
import { parsePublishedNodeBody, nodeSummaryFromBody } from '../knowledge/nodeBody'
import { canonicalizeExistingPath } from '../../permissions/pathAccess'

async function readPackageHint(workspaceRoot: string): Promise<string | null> {
  const root = canonicalizeExistingPath(resolve(workspaceRoot))
  if (!root.ok) return null
  try {
    const raw = await readFile(join(root.path, 'package.json'), 'utf8')
    const pkg = JSON.parse(raw) as { name?: string; description?: string }
    const parts = [pkg.description, pkg.name].filter(Boolean)
    return parts.length ? String(parts[0]) : null
  } catch {
    return null
  }
}

function dimensionFromProjection(
  projection: KnowledgeTreeProjectionView | null,
  id: LearningNavDimensionId
): LearningNavDimensionView {
  const label = learningNavDimensionLabel(id)
  if (!projection?.nodes.length) {
    return { id, label, status: 'empty', summary: '待整理' }
  }
  const nodes = projection.nodes.filter(n => n.navDimension === id)
  if (nodes.length === 0) {
    return { id, label, status: 'empty', summary: '待整理' }
  }
  const verified = nodes.some(n => n.materialStatus === 'verified')
  const status: LearningNavEntryStatus = verified ? 'verified' : 'pending_review'
  const summary = nodes.map(n => n.summary).join('；').slice(0, 400)
  return { id, label, status, summary: summary || '待整理' }
}

export async function buildZeroModelNavigation(params: {
  workspaceRoot: string
  projection: KnowledgeTreeProjectionView | null
}): Promise<LearningZeroModelNavigationView> {
  const hint = await readPackageHint(params.workspaceRoot)
  const dimensions = LEARNING_NAV_DIMENSIONS.map(id => {
    const base = dimensionFromProjection(params.projection, id)
    if (id === 'project_purpose' && hint && base.status === 'empty') {
      return {
        ...base,
        status: 'pending_review' as const,
        summary: hint
      }
    }
    return base
  })

  if (!params.projection?.knowledgeRevision) {
    return {
      dimensions: dimensions.length ? dimensions : emptyNavigationDimensions(),
      knowledgeRevision: null,
      hasPublishedNodes: false
    }
  }

  return {
    dimensions,
    knowledgeRevision: params.projection.knowledgeRevision,
    hasPublishedNodes: params.projection.nodes.length > 0
  }
}

export function projectionFromPublishedRows(
  knowledgeRevision: string,
  rows: readonly {
    nodeId: string
    nodeRevision: string
    title: string
    bodyJson: string
  }[],
  edges: KnowledgeTreeProjectionView['edges']
): KnowledgeTreeProjectionView {
  const nodes = rows.map(row => {
    const body = parsePublishedNodeBody(row.bodyJson)
    return {
      nodeId: row.nodeId,
      nodeRevision: row.nodeRevision,
      title: row.title,
      summary: nodeSummaryFromBody(row.title, body),
      materialStatus: body.materialStatus,
      navDimension: body.navDimension,
      parentNodeId: body.parentNodeId
    }
  })
  return { knowledgeRevision, nodes, edges }
}
