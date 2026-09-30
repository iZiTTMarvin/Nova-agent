/**
 * 大纲分组与顺序的唯一实现：根节点按固定六类分组，缺分组的归入「其他」；
 * 父子关系按 parentNodeId 建立，指向不存在节点的父引用按顶层处理。
 */
import type {
  KnowledgeNodeSummaryView,
  KnowledgeTreeProjectionView
} from '../../../../shared/learning/knowledgeProjection'
import { LEARNING_NAV_DIMENSIONS, type LearningNavDimensionId } from '../../../../shared/learning/navigation'
import { LEARNING_OUTLINE_DIMENSION_TITLES } from '../learningCopy'

export type OutlineGroupId = LearningNavDimensionId | 'other'

export interface OutlineGroup {
  readonly id: OutlineGroupId
  readonly title: string
  readonly roots: readonly KnowledgeNodeSummaryView[]
}

/** 子节点索引；key 为 null 是顶层。环状父引用由渲染层的祖先集合截断。 */
export function buildOutlineChildrenMap(
  tree: KnowledgeTreeProjectionView
): Map<string | null, KnowledgeNodeSummaryView[]> {
  const map = new Map<string | null, KnowledgeNodeSummaryView[]>()
  const ids = new Set(tree.nodes.map(node => node.nodeId))
  for (const node of tree.nodes) {
    const parent = node.parentNodeId && ids.has(node.parentNodeId) ? node.parentNodeId : null
    map.set(parent, [...(map.get(parent) ?? []), node])
  }
  return map
}

/** 按展示顺序返回非空分组。 */
export function groupOutlineRoots(tree: KnowledgeTreeProjectionView): OutlineGroup[] {
  const roots = buildOutlineChildrenMap(tree).get(null) ?? []
  const groups: OutlineGroup[] = []
  for (const dimension of LEARNING_NAV_DIMENSIONS) {
    const nodes = roots.filter(node => node.navDimension === dimension)
    if (nodes.length > 0) {
      groups.push({ id: dimension, title: LEARNING_OUTLINE_DIMENSION_TITLES[dimension], roots: nodes })
    }
  }
  const other = roots.filter(node => !node.navDimension)
  if (other.length > 0) {
    groups.push({ id: 'other', title: LEARNING_OUTLINE_DIMENSION_TITLES.other, roots: other })
  }
  return groups
}

/** 大纲展示顺序里的第一个主题，供空状态建议「从「X」开始」使用。 */
export function firstOutlineTopic(tree: KnowledgeTreeProjectionView): KnowledgeNodeSummaryView | null {
  for (const group of groupOutlineRoots(tree)) {
    const first = group.roots[0]
    if (first) return first
  }
  return null
}
