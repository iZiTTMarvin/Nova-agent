/**
 * ToolCallGroup — 相邻同类只读工具调用的折叠聚合行
 */
import React, { useState } from 'react'
import { ChevronIcon } from '../../components/Icons'
import { getToolGroupSummaryParts } from './toolCallGrouping'
import { getToolSummary } from './toolDisplay'
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
        <ChevronIcon size={14} direction={isOpen ? 'down' : 'right'} className="tool-call-group__chevron" />
        <span className="tool-call-group__summary">
          <span>{prefix} </span>
          <span className="tool-call-group__pill">{pill}</span>
          {suffix ? <span> {suffix}</span> : null}
        </span>
      </button>

      {isOpen && (
        <ul className="tool-call-group__list">
          {blocks.map(block => (
            <li key={block.toolCallId} className="tool-call-group__item">
              <GroupStatusDot status={block.status} />
              <span className="tool-call-group__item-text">
                {getToolSummary(toolName, block.arguments) || getToolDisplayNameFallback(toolName)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

function getToolDisplayNameFallback(toolName: string): string {
  return toolName
}
