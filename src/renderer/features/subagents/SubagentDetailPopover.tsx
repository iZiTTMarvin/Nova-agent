/**
 * SubagentDetailPopover — 子代理活动行的悬浮详情面板
 *
 * 锚定在活动行上、向上展开（bottom 锚定），展示子代理运行期间的真实工作流：
 * 历史消息与 RunCoordinator 草稿合并展示；流式更新复用 run 快照投影。
 * 面板只读，不跳转子会话。
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { Message, MessageBlock } from '../../../shared/session'
import type { SubagentActivityProjection } from '../../../shared/subagents'
import type { RunSnapshot } from '../../../shared/run/types'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { formatSubagentModelLine } from './modelLine'
import { useRunStore } from '../../stores/useRunStore'
import type { PopoverAnchor } from './SubagentActivityRow'

/** 每页拉取的尾部消息条数；子代理为短会话，单页通常即可覆盖全部。 */
const POPOVER_MESSAGE_PAGE_SIZE = 400
const MAX_POPOVER_PAGES = 20
const MAX_TOOL_ROWS = 60
const MAX_THINKING_CHARS = 600
const MAX_TARGET_CHARS = 48
/** 面板与锚定行、视口边缘的最小留白 */
const POPOVER_VIEWPORT_MARGIN = 12
const POPOVER_MAX_HEIGHT = 480

const ARG_PREFERRED_KEYS = ['file_path', 'path', 'file', 'directory', 'skill', 'query']

/** 依据锚定行在视口中的位置计算 fixed 面板几何：优先空间大的一侧，始终留在视口内 */
function computePanelGeometry(anchor: PopoverAnchor, viewportHeight: number): {
  style: React.CSSProperties
} {
  const spaceAbove = anchor.top - POPOVER_VIEWPORT_MARGIN
  const spaceBelow = viewportHeight - anchor.bottom - POPOVER_VIEWPORT_MARGIN
  const openUp = spaceAbove >= spaceBelow
  const available = Math.max(160, openUp ? spaceAbove : spaceBelow)
  return {
    style: {
      position: 'fixed',
      left: anchor.left,
      width: anchor.width,
      maxHeight: Math.min(POPOVER_MAX_HEIGHT, available - 6),
      ...(openUp
        ? { bottom: viewportHeight - anchor.top + 6 }
        : { top: anchor.bottom + 6 })
    }
  }
}

export interface SubagentDetailPopoverProps {
  projection: SubagentActivityProjection
  /** 打开瞬间锚定行的视口几何；面板 fixed 定位，随视口而非滚动内容 */
  anchor: PopoverAnchor
  onClose: () => void
}

interface ToolRow {
  id: string
  name: string
  status: 'running' | 'success' | 'error'
  target: string
}

function clampText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`
}

/** 从工具参数里挑一个可读目标（路径/技能/查询），没有时留空。 */
function summarizeArgs(args: Record<string, unknown>): string {
  for (const key of ARG_PREFERRED_KEYS) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) {
      return clampText(value.trim(), MAX_TARGET_CHARS)
    }
  }
  const firstString = Object.values(args).find(
    (value): value is string => typeof value === 'string' && value.trim().length > 0
  )
  return firstString ? clampText(firstString.trim(), MAX_TARGET_CHARS) : ''
}

function toToolRow(block: Extract<MessageBlock, { type: 'tool' }>): ToolRow {
  return {
    id: block.toolCallId,
    name: block.toolName,
    status: block.status,
    target: summarizeArgs(block.arguments)
  }
}

function collectToolRows(messages: readonly Message[]): ToolRow[] {
  const rows: ToolRow[] = []
  const seen = new Set<string>()
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type !== 'tool' || seen.has(block.toolCallId)) continue
      // load_tools 是 Harness 内部控制动作，与主消息流同样不在此展示
      if (block.toolName === 'load_tools') continue
      seen.add(block.toolCallId)
      rows.push(toToolRow(block))
    }
  }
  return rows.slice(-MAX_TOOL_ROWS)
}

function collectThinkingText(messages: readonly Message[]): string {
  const parts: string[] = []
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (block.type === 'thinking' && block.content.trim()) {
        parts.push(block.content.trim())
      }
    }
  }
  return parts.join('\n\n').slice(-MAX_THINKING_CHARS)
}

/** 最后一条 assistant 文本消息：运行中即最新进展，终态即最终报告。 */
function collectFinalReport(messages: readonly Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!
    if (message.role !== 'assistant') continue
    const text = message.blocks
      ? message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => (block as Extract<MessageBlock, { type: 'text' }>).content)
          .join('\n')
      : message.content
    if (text.trim()) return text
  }
  return ''
}

export const SubagentDetailPopover: React.FC<SubagentDetailPopoverProps> = ({
  projection,
  anchor,
  onClose
}) => {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [initialSnapshot, setInitialSnapshot] = useState<RunSnapshot | null>(null)
  const [loadError, setLoadError] = useState(false)
  const liveSnapshot = useRunStore(state => state.snapshotsByRunId[projection.childRunId] ?? null)
  const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(projection.status)
  const [viewportHeight, setViewportHeight] = useState(() => window.innerHeight)
  const panel = useMemo(
    () => computePanelGeometry(anchor, viewportHeight),
    [anchor, viewportHeight]
  )

  // 视口尺寸变化时重算面板几何（窗口缩放 / 分栏调整）
  useEffect(() => {
    const onResize = (): void => setViewportHeight(window.innerHeight)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    let cancelled = false
    setMessages(null)
    setInitialSnapshot(null)
    setLoadError(false)
    void (async () => {
      try {
        const snapshotResult = await window.api.invoke('run:get-snapshot', {
          sessionId: projection.childSessionId, runId: projection.childRunId
        })
        if (cancelled) return
        setInitialSnapshot(snapshotResult?.snapshot ?? null)
        const collected: Message[] = []
        let beforeId: string | undefined
        for (let page = 0; page < MAX_POPOVER_PAGES; page++) {
          const result = await window.api.invoke('load-session-messages', {
            sessionId: projection.childSessionId,
            limit: POPOVER_MESSAGE_PAGE_SIZE,
            ...(beforeId ? { beforeId } : {})
          })
          if (cancelled) return
          collected.unshift(...result.messages)
          if (!result.hasMore || result.messages.length === 0) break
          beforeId = result.messages[0]!.id
        }
        setMessages(collected)
      } catch {
        if (!cancelled) {
          setMessages([])
          setLoadError(true)
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projection.childSessionId, projection.childRunId, terminal])

  const displayedMessages = useMemo(() => {
    const snapshot = liveSnapshot && (!initialSnapshot || liveSnapshot.sequence >= initialSnapshot.sequence)
      ? liveSnapshot : initialSnapshot
    const draft = snapshot?.sessionId === projection.childSessionId ? snapshot.turnDraft : null
    if (!draft) return messages ?? []
    const draftMessage: Message = {
      id: draft.messageId, sessionId: projection.childSessionId, role: 'assistant',
      content: '', blocks: draft.blocks, timestamp: draft.updatedAt
    }
    return [...(messages ?? []).filter(message => message.id !== draft.messageId), draftMessage]
  }, [messages, liveSnapshot, initialSnapshot, projection.childSessionId])

  // Esc 关闭；点击背板关闭（背板覆盖全屏，面板自身冒泡禁止）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const toolRows = useMemo(
    () => collectToolRows(displayedMessages),
    [displayedMessages]
  )
  const thinkingText = useMemo(
    () => collectThinkingText(displayedMessages),
    [displayedMessages]
  )
  const finalReport = useMemo(
    () => collectFinalReport(displayedMessages),
    [displayedMessages]
  )
  const loading = messages === null

  const modelLine = formatSubagentModelLine(projection)

  return (
    <>
      <div className="subagent-detail-popover__backdrop" onClick={onClose} />
      <div
        className="subagent-detail-popover"
        role="dialog"
        aria-label={`${projection.profile.name} 工作流详情`}
        style={panel.style}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="subagent-detail-popover__header">
          <div className="subagent-detail-popover__title">
            <span className="subagent-detail-popover__name">{projection.profile.name}</span>
            {modelLine && (
              <span className="subagent-detail-popover__model">{modelLine}</span>
            )}
            {projection.artifactCount > 0 && (
              <span className="subagent-detail-popover__artifacts">
                {projection.artifactCount} 个产物
              </span>
            )}
          </div>
          <button
            type="button"
            className="subagent-detail-popover__close"
            aria-label="关闭详情"
            onClick={onClose}
          >
            ×
          </button>
        </header>

        <div className="subagent-detail-popover__body">
          {loadError && <p className="subagent-detail-popover__empty">历史记录读取失败，请重新打开详情。</p>}
          <section className="subagent-detail-popover__section">
            <h3 className="subagent-detail-popover__section-title">工具调用</h3>
            {loading ? (
              <p className="subagent-detail-popover__empty">加载中…</p>
            ) : toolRows.length === 0 ? (
              <p className="subagent-detail-popover__empty">暂无工具调用</p>
            ) : (
              <ul className="subagent-detail-popover__tool-list">
                {toolRows.map((row) => (
                  <li key={row.id} className="subagent-detail-popover__tool-row">
                    <span
                      className={`subagent-detail-popover__tool-dot subagent-detail-popover__tool-dot--${row.status}`}
                      aria-hidden="true"
                    />
                    <span className="subagent-detail-popover__tool-name">{row.name}</span>
                    {row.target && (
                      <span className="subagent-detail-popover__tool-target">{row.target}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="subagent-detail-popover__section">
            <h3 className="subagent-detail-popover__section-title">思考摘要</h3>
            {loading ? null : thinkingText ? (
              <p className="subagent-detail-popover__thinking">{thinkingText}</p>
            ) : (
              <p className="subagent-detail-popover__empty">暂无思考内容</p>
            )}
          </section>

          <section className="subagent-detail-popover__section">
            <h3 className="subagent-detail-popover__section-title">{terminal ? '最终报告' : '最新进展'}</h3>
            {loading ? (
              <p className="subagent-detail-popover__empty">加载中…</p>
            ) : finalReport ? (
              <div className="subagent-detail-popover__report">
                <MarkdownRenderer content={finalReport} />
              </div>
            ) : (
              <p className="subagent-detail-popover__empty">暂无报告</p>
            )}
          </section>
        </div>
      </div>
    </>
  )
}
