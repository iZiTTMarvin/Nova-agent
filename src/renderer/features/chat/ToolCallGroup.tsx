/**
 * ToolCallGroup — 相邻同类只读工具的 L3 聚合行
 *
 * 与单条 ToolTraceRow 同一过程轨视觉；展开仅列出各条目 Target。
 */
import React, { useState } from 'react'
import { ChevronIcon } from '../../components/Icons'
import { getToolGroupSummaryParts } from './toolCallGrouping'
import { getToolTraceTarget } from './toolTraceDisplay'
import type { RendererToolBlock } from '../../stores/types'
import './ToolCallGroup.css'

export interface ToolCallGroupProps {
  toolName: string
  blocks: RendererToolBlock[]
}

function GroupStatusDot({ status }: { status: RendererToolBlock['status'] }) {
  return (
    <span
      className={`tool-call-group__status tool-call-group__status--${status}`}
      aria-hidden="true"
    />
  )
}

export const ToolCallGroup: React.FC<ToolCallGroupProps> = React.memo(function ToolCallGroup({
  toolName,
  blocks
}) {
  const [isOpen, setIsOpen] = useState(false)
  const { prefix, pill, suffix } = getToolGroupSummaryParts(toolName, blocks)

  return (
    <div className="tool-call-group">
      <button
        type="button"
        className="tool-call-group__header"
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
      >
        <GroupStatusDot status={aggregateStatus(blocks)} />
        <span className="tool-call-group__action">{prefix}</span>
        <span className="tool-call-group__target">
          <span>{pill}</span>
          {suffix ? <span className="tool-call-group__suffix"> {suffix}</span> : null}
        </span>
        <ChevronIcon
          size={12}
          direction={isOpen ? 'down' : 'right'}
          className="tool-call-group__chevron"
        />
      </button>

      {isOpen && (
        <ul className="tool-call-group__list">
          {blocks.map(block => (
            <li key={block.toolCallId} className="tool-call-group__item">
              <GroupStatusDot status={block.status} />
              <span className="tool-call-group__item-text">
                {getToolTraceTarget(toolName, block.arguments ?? {})}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

function aggregateStatus(blocks: RendererToolBlock[]): RendererToolBlock['status'] {
  if (blocks.some(b => b.status === 'running')) return 'running'
  if (blocks.some(b => b.status === 'error')) return 'error'
  return 'success'
}
