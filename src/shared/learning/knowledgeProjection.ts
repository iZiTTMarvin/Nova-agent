import type { LearningNavDimensionId } from './navigation'

export type KnowledgeEdgeKind = 'prerequisite' | 'related' | 'flow_next'

export type KnowledgeNodeMaterialStatus = 'verified' | 'partial' | 'unverified' | 'stale'

export interface KnowledgeNodeSummaryView {
  readonly nodeId: string
  readonly nodeRevision: string
  readonly title: string
  readonly summary: string
  readonly materialStatus: KnowledgeNodeMaterialStatus
  readonly navDimension: LearningNavDimensionId | null
  readonly parentNodeId: string | null
}

export interface KnowledgeEdgeView {
  readonly fromNodeId: string
  readonly toNodeId: string
  readonly edgeKind: KnowledgeEdgeKind
}

export interface KnowledgeTreeProjectionView {
  readonly knowledgeRevision: string | null
  readonly nodes: readonly KnowledgeNodeSummaryView[]
  readonly edges: readonly KnowledgeEdgeView[]
}

export interface KnowledgeNodeSourceView {
  readonly receiptId: string
  readonly filePath: string
  readonly startLine: number
  readonly endLine: number
  readonly snippetHash: string
}

export interface KnowledgeNodeMaterialView {
  readonly nodeId: string
  readonly nodeRevision: string
  readonly title: string
  readonly bodyJson: string
  readonly sources: readonly KnowledgeNodeSourceView[]
}
