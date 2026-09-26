import { useEffect, useMemo, useState } from 'react'
import type { KnowledgeNodeSummaryView, KnowledgeTreeProjectionView } from '../../../shared/learning/knowledgeProjection'
import { LEARNING_NAV_DIMENSIONS, learningNavDimensionLabel } from '../../../shared/learning/navigation'
import type { LearningNodeProgressView } from '../../../shared/learning/surface'
import { ChevronIcon } from '../../components/Icons'
import { nodeMaterialStatusLabel } from './learningStatus'

interface KnowledgeNavTreeProps {
  tree: KnowledgeTreeProjectionView
  selectedNodeId: string | null
  nodeProgress: readonly LearningNodeProgressView[]
  disabled: boolean
  onSelectNode: (nodeId: string) => void
}

const progressLabels = {
  explained: '讲过', understanding_observed: '有理解证据', needs_clarification: '需澄清', pending_review: '评估待复核'
}

export function KnowledgeNavTree({ tree, selectedNodeId, nodeProgress, disabled, onSelectNode }: KnowledgeNavTreeProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const byParent = useMemo(() => {
    const map = new Map<string | null, KnowledgeNodeSummaryView[]>()
    const ids = new Set(tree.nodes.map(node => node.nodeId))
    for (const node of tree.nodes) {
      const parent = node.parentNodeId && ids.has(node.parentNodeId) ? node.parentNodeId : null
      map.set(parent, [...(map.get(parent) ?? []), node])
    }
    return map
  }, [tree])

  // 选中节点时，确保其所有父级自动展开，避免深层节点被折叠隐藏
  useEffect(() => {
    if (!selectedNodeId) return
    const nodeMap = new Map(tree.nodes.map(node => [node.nodeId, node]))
    const ancestors: string[] = []
    const visited = new Set<string>()
    let current = nodeMap.get(selectedNodeId)
    while (current?.parentNodeId && !visited.has(current.parentNodeId)) {
      visited.add(current.parentNodeId)
      ancestors.push(current.parentNodeId)
      current = nodeMap.get(current.parentNodeId)
    }
    if (ancestors.length > 0) {
      setCollapsed(previous => {
        let changed = false
        const next = new Set(previous)
        for (const ancestor of ancestors) {
          if (next.has(ancestor)) {
            next.delete(ancestor)
            changed = true
          }
        }
        return changed ? next : previous
      })
    }
  }, [selectedNodeId, tree.nodes])

  const progress = useMemo(
    () => new Map(nodeProgress.map(item => [item.nodeId, item.state])),
    [nodeProgress]
  )

  const renderNode = (node: KnowledgeNodeSummaryView, ancestors: ReadonlySet<string>): React.ReactNode => {
    if (ancestors.has(node.nodeId)) return null
    const children = byParent.get(node.nodeId) ?? []
    const expanded = !collapsed.has(node.nodeId)
    return (
      <li key={node.nodeId}>
        <div className="learning-tree__row">
          {children.length > 0 ? (
            <button
              type="button"
              className="learning-tree__expand"
              aria-label={`${expanded ? '收起' : '展开'}${node.title}`}
              aria-expanded={expanded}
              onClick={() =>
                setCollapsed(previous => {
                  const next = new Set(previous)
                  if (expanded) next.add(node.nodeId)
                  else next.delete(node.nodeId)
                  return next
                })
              }
            >
              <ChevronIcon size={14} direction={expanded ? 'down' : 'right'} />
            </button>
          ) : (
            <span className="learning-tree__expand-spacer" aria-hidden="true" />
          )}
          <button
            type="button"
            aria-current={node.nodeId === selectedNodeId ? 'true' : undefined}
            className={`learning-tree__node${node.nodeId === selectedNodeId ? ' learning-tree__node--active' : ''}`}
            disabled={disabled}
            onClick={() => onSelectNode(node.nodeId)}
            title={node.title}
          >
            <span className="learning-tree__node-title">{node.title}</span>
            <span className={`learning-tree__node-status learning-tree__node-status--${node.materialStatus}`}>
              <span className="learning-tree__node-dot" aria-hidden="true" />
              {nodeMaterialStatusLabel(node.materialStatus)} · {progress.has(node.nodeId) ? progressLabels[progress.get(node.nodeId)!] : '未开始'}
            </span>
          </button>
        </div>
        {expanded && children.length > 0 && (
          <ul>{children.map(child => renderNode(child, new Set([...ancestors, node.nodeId])))}</ul>
        )}
      </li>
    )
  }

  const roots = byParent.get(null) ?? []
  const hasAnyNodes = tree.nodes.length > 0

  return (
    <div className="learning-tree">
      {!hasAnyNodes && (
        <p className="learning-tree__empty">尚无项目教材。开始整理后，这里会出现有源码依据的主题。</p>
      )}
      {hasAnyNodes &&
        LEARNING_NAV_DIMENSIONS.map(dimension => {
          const nodes = roots.filter(node => node.navDimension === dimension)
          if (nodes.length === 0) return null
          return (
            <section key={dimension} className="learning-tree__group">
              <h3 className="learning-tree__group-label">
                {learningNavDimensionLabel(dimension)}
              </h3>
              <ul>{nodes.map(node => renderNode(node, new Set()))}</ul>
            </section>
          )
        })}
      {hasAnyNodes && roots.some(node => !node.navDimension) && (
        <section className="learning-tree__group">
          <h3 className="learning-tree__group-label">其他主题</h3>
          <ul>{roots.filter(node => !node.navDimension).map(node => renderNode(node, new Set()))}</ul>
        </section>
      )}
    </div>
  )
}
