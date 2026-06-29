import React, { useState, useMemo } from 'react'
import { CheckIcon, AlertIcon, TerminalIcon, ChevronIcon } from '../../components/Icons'
import { isPermissionDeniedResult } from './renderingPolicy'
import { getToolDisplayName, getToolSummary } from './toolDisplay'
import { clampBashShellOutputForDisplay } from './bashOutputDisplay'
import { useAgentStore } from '../../stores/useAgentStore'
import { InlinePermissionBar } from '../permissions/InlinePermissionBar'
import { WebSearchCard } from './WebSearchCard'
import type { PendingPermissionRequest } from '../../stores/types'

/** 折叠式工具调用状态卡片 */
export interface ToolBoxProps {
  /** 该工具调用的唯一 id，用于把内联放行请求锚定到本卡片 */
  toolCallId?: string
  name: string
  args: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
  /** 是否处于 assistant 流式生成中。true 时启用入场动画。 */
  isLiveStreaming?: boolean
}

/**
 * 选择「本卡片是否为某个待授权请求的锚点」。
 *
 * 一个权限请求可能对应一批连续 bash 命令（toolCallIds 多个）。为避免在每张卡片上
 * 都重复渲染放行按钮，约定锚点为列表中的最后一张卡片（命令都列在其上方，按钮置底，
 * 符合 Windsurf 观感）。
 *
 * selector 只返回稳定引用（命中时返回 request 本身，否则返回 null），
 * 因此只有锚点卡片会因该订阅重渲染，其余卡片 selector 结果恒为 null，不触发重渲染。
 */
function selectAnchoredRequest(
  request: PendingPermissionRequest | null,
  toolCallId: string | undefined
): PendingPermissionRequest | null {
  if (!request || !toolCallId) return null
  const ids = request.toolCallIds
  if (!ids || ids.length === 0) return null
  return ids[ids.length - 1] === toolCallId ? request : null
}

/**
 * 流式入场动画参数。
 *
 * 历史上 scale 由 framer-motion spring 驱动，但 framer-motion 的 JS 动画每帧写内联
 * transform，会触发主线程 Recalculate style；在 bash/流式期间大量卡片同时挂载时，
 * 叠加巨大消息 DOM 会让合成循环打满、界面卡死。现已改为纯 CSS 入场（仅 opacity，
 * 见 tool-box--live-enter，96ms、走合成器），不再使用 framer-motion。
 *
 * 这两个常量仅为兼容既有测试保留，组件已不再使用。
 */
export const LIVE_ENTER_SPRING = { type: 'spring' as const, stiffness: 300, damping: 30, mass: 0.8 }
export const NO_ANIMATION = { duration: 0 }

export const ToolBox: React.FC<ToolBoxProps> = React.memo(function ToolBox({ toolCallId, name, args, status, result, isLiveStreaming = false }) {
  const [isOpen, setIsOpen] = useState(false)
  const shouldHideArguments = isPermissionDeniedResult(result)
  const summary = getToolSummary(name, args)

  /**
   * 内联放行：仅当存在待授权请求且本卡片为其锚点时返回非空。
   * selector 返回稳定引用，保证只有锚点卡片重渲染。
   */
  const anchoredRequest = useAgentStore(
    state => selectAnchoredRequest(state.pendingPermissionRequest, toolCallId)
  )

  /** bash 展开区展示用：保留尾部，避免超长输出拖垮 layout */
  const bashDisplay = useMemo(() => {
    if (name !== 'bash' || !result) return null
    return clampBashShellOutputForDisplay(result)
  }, [name, result])

  const renderStatusIcon = () => {
    switch (status) {
      case 'running':
        return (
          <div className="tool-box__status-icon tool-box__status-icon--running">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <line x1="12" y1="2" x2="12" y2="6" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="4.93" y1="4.93" x2="7.76" y2="7.76" />
              <line x1="16.24" y1="16.24" x2="19.07" y2="19.07" />
              <line x1="2" y1="12" x2="6" y2="12" />
              <line x1="18" y1="12" x2="22" y2="12" />
              <line x1="4.93" y1="19.07" x2="7.76" y2="16.24" />
              <line x1="16.24" y1="7.76" x2="19.07" y2="4.93" />
            </svg>
          </div>
        )
      case 'success':
        return (
          <div className="tool-box__status-icon tool-box__status-icon--success">
            <CheckIcon size={14} />
          </div>
        )
      case 'error':
        return (
          <div className="tool-box__status-icon tool-box__status-icon--error">
            <AlertIcon size={14} />
          </div>
        )
      default:
        return null
    }
  }

  return (
    <div
      className={isLiveStreaming ? 'tool-box tool-box--live-enter' : 'tool-box'}
    >
      <div className="tool-box__header" onClick={() => setIsOpen(!isOpen)}>
        {renderStatusIcon()}
        <TerminalIcon size={14} style={{ color: 'var(--text-secondary)' }} />
        <span className="tool-box__title">{getToolDisplayName(name)}</span>
        {summary && <span className="tool-box__summary">{summary}</span>}
        <div className="tool-box__arrow">
          <ChevronIcon size={14} direction={isOpen ? 'up' : 'down'} />
        </div>
      </div>

      {isOpen && (
        <div className="tool-box__body">
          {!shouldHideArguments && (
            <div className="tool-box__section">
              <div className="tool-box__sec-title">调用参数</div>
              <pre className="tool-box__content">
                {JSON.stringify(args, null, 2)}
              </pre>
            </div>
          )}

          {result && (
            <div className="tool-box__section">
              <div className="tool-box__sec-title">执行结果</div>
              {name === 'web_search' ? (
                <WebSearchCard output={result} />
              ) : name === 'bash' && bashDisplay ? (
                <>
                  {bashDisplay.truncated && (
                    <div className="tool-box__truncation-hint">
                      输出过长，已省略前 {bashDisplay.omittedChars.toLocaleString()} 个字符（展示末尾{' '}
                      {bashDisplay.text.length.toLocaleString()} 字）
                    </div>
                  )}
                  <pre className="tool-box__content">{bashDisplay.text}</pre>
                </>
              ) : (
                <pre className="tool-box__content">{result}</pre>
              )}
            </div>
          )}

          {name === 'web_search' && status === 'running' && !result && (
            <div className="tool-box__section">
              <div className="tool-box__sec-title">执行结果</div>
              <WebSearchCard output="" loading />
            </div>
          )}
        </div>
      )}

      {/* 内联放行条：本卡片为待授权请求锚点时渲染，跟随消息流滚动 */}
      {anchoredRequest && (
        <div className="tool-box__permission">
          <InlinePermissionBar request={anchoredRequest} />
        </div>
      )}
    </div>
  )
})
