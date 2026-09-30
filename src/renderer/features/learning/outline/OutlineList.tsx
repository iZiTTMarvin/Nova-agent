/**
 * 大纲列表：分组 + 父子缩进 + 折叠；前置圆点表达个人进度，尾部标记只在异常时出现。
 * 点击行进入详情，不发任何命令。
 */
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import { ChevronIcon } from '../../../components/Icons'
import type { KnowledgeNodeSummaryView, KnowledgeTreeProjectionView } from '../../../../shared/learning/knowledgeProjection'
import type { LearningNodeProgressView } from '../../../../shared/learning/surface'
import {
  LEARNING_MARK_PARTIAL_TOOLTIP,
  LEARNING_MARK_STALE_TOOLTIP,
  LEARNING_NODE_PROGRESS_COPY,
  learningOutlineToggleLabel,
  type LearningNodeProgressState
} from '../learningCopy'
import { buildOutlineChildrenMap, groupOutlineRoots } from './outlineOrder'

interface OutlineListProps {
  tree: KnowledgeTreeProjectionView
  nodeProgress: readonly LearningNodeProgressView[]
  selectedNodeId: string | null
  onOpenDetail: (nodeId: string) => void
}

export function OutlineList({ tree, nodeProgress, selectedNodeId, onOpenDetail }: OutlineListProps): React.ReactElement {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const byParent = useMemo(() => buildOutlineChildrenMap(tree), [tree])
  const groups = useMemo(() => groupOutlineRoots(tree), [tree])
  const progress = useMemo(
    () => new Map(nodeProgress.map(item => [item.nodeId, item.state] as const)),
    [nodeProgress]
  )

  // 正在学的主题被折叠隐藏没有意义：选中变化时自动展开其全部祖先
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

  const renderNode = (node: KnowledgeNodeSummaryView, ancestors: ReadonlySet<string>): React.ReactNode => {
    if (ancestors.has(node.nodeId)) return null
    const children = byParent.get(node.nodeId) ?? []
    const expanded = !collapsed.has(node.nodeId)
    const progressState: LearningNodeProgressState = progress.get(node.nodeId) ?? 'none'
    const progressLabel = LEARNING_NODE_PROGRESS_COPY[progressState]
    const isCurrent = node.nodeId === selectedNodeId
    return (
      <li key={node.nodeId}>
        <div className={`learning-outline__row${isCurrent ? ' learning-outline__row--current' : ''}`}>
          {children.length > 0 ? (
            <IconButton
              label={learningOutlineToggleLabel(node.title, expanded)}
              tooltip={learningOutlineToggleLabel(node.title, expanded)}
              aria-expanded={expanded}
              icon={<ChevronIcon size={13} direction={expanded ? 'down' : 'right'} />}
              variant="ghost"
              size="sm"
              className="learning-outline__expand"
              onClick={() =>
                setCollapsed(previous => {
                  const next = new Set(previous)
                  if (expanded) next.add(node.nodeId)
                  else next.delete(node.nodeId)
                  return next
                })
              }
            />
          ) : (
            <span className="learning-outline__expand-spacer" aria-hidden="true" />
          )}
          <Button
            label={node.title}
            aria-label={node.title}
            variant="ghost"
            size="sm"
            className="learning-outline__item"
            aria-current={isCurrent ? 'true' : undefined}
            tooltip={node.title}
            onClick={() => onOpenDetail(node.nodeId)}
          >
            <span className="learning-outline__item-content">
              <span
                className={`learning-outline__dot learning-outline__dot--${progressState}`}
                role="img"
                aria-label={progressLabel}
                title={progressLabel}
              />
              <span className="learning-outline__item-title">{node.title}</span>
              {node.materialStatus === 'partial' && (
                <span className="learning-outline__mark learning-outline__mark--partial" title={LEARNING_MARK_PARTIAL_TOOLTIP} aria-label={LEARNING_MARK_PARTIAL_TOOLTIP}>
                  ≈
                </span>
              )}
              {node.materialStatus === 'stale' && (
                <span className="learning-outline__mark learning-outline__mark--stale" role="img" title={LEARNING_MARK_STALE_TOOLTIP} aria-label={LEARNING_MARK_STALE_TOOLTIP} />
              )}
            </span>
          </Button>
        </div>
        {expanded && children.length > 0 && (
          <ul>{children.map(child => renderNode(child, new Set([...ancestors, node.nodeId])))}</ul>
        )}
      </li>
    )
  }

  return (
    <div className="learning-outline__list">
      {groups.map(group => (
        <section key={group.id} className="learning-outline__group">
          <h3 className="learning-outline__group-title">{group.title}</h3>
          <ul>{group.roots.map(node => renderNode(node, new Set()))}</ul>
        </section>
      ))}
    </div>
  )
}
