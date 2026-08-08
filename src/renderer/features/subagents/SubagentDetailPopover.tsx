/**
 * SubagentDetailPopover — 子代理活动行的悬浮详情面板
 *
 * 锚定在活动行上、向上展开（bottom 锚定），展示子代理运行期间的真实工作流：
 * 工具调用记录、思考摘要与最终报告。运行中通过订阅投影 store 的 sequence/status
 * 变化重拉消息，保持实时；面板只读，不提供任何写操作，也不跳转子会话。
 */
import React, { useEffect, useMemo, useState } from 'react'
import type { Message, MessageBlock } from '../../../shared/session'
import type { SubagentActivityProjection } from '../../../shared/subagents'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { formatSubagentModelLine } from './modelLine'
import { useSubagentProjectionStore } from './projection'

/** 每页拉取的尾部消息条数；子代理为短会话，单页通常即可覆盖全部。 */
const POPOVER_MESSAGE_PAGE_SIZE = 400
const MAX_POPOVER_PAGES = 20
const MAX_TOOL_ROWS = 60
const MAX_THINKING_CHARS = 600
const MAX_TARGET_CHARS = 48

const ARG_PREFERRED_KEYS = ['file_path', 'path', 'file', 'directory', 'skill', 'query']

export interface SubagentDetailPopoverProps {
  projection: SubagentActivityProjection
  /** 展开方向：默认向上（悬于 composer 上方）；行贴近顶部时由调用方改为向下 */
  direction?: 'up' | 'down'
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
      seen.add(block.toolCallId)
      rows.push(toToolRow(block))
    }
  }
  return rows.slice(0, MAX_TOOL_ROWS)
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
  return parts.join('\n\n').slice(0, MAX_THINKING_CHARS)
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
  direction = 'up',
  onClose
}) => {
  const [messages, setMessages] = useState<Message[] | null>(null)
  const [fetchTick, setFetchTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
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
        // 加载失败保留空态，不打断父消息流
        setMessages([])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [projection.childSessionId, fetchTick])

  // 运行中：投影 sequence/status 推进时重拉消息，保持面板与执行同步
  useEffect(() => {
    const unsubscribe = useSubagentProjectionStore.subscribe((state, prevState) => {
      const current = state.byChildSessionId[projection.childSessionId]
      const previous = prevState.byChildSessionId[projection.childSessionId]
      if (
        current &&
        (current.sequence !== previous?.sequence || current.status !== previous?.status)
      ) {
        setFetchTick((tick) => tick + 1)
      }
    })
    return unsubscribe
  }, [projection.childSessionId])

  // Esc 关闭；点击背板关闭（背板覆盖全屏，面板自身冒泡禁止）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const toolRows = useMemo(
    () => (messages ? collectToolRows(messages) : []),
    [messages]
  )
  const thinkingText = useMemo(
    () => (messages ? collectThinkingText(messages) : ''),
    [messages]
  )
  const finalReport = useMemo(
    () => (messages ? collectFinalReport(messages) : ''),
    [messages]
  )
  const loading = messages === null

  const modelLine = formatSubagentModelLine(projection)

  return (
    <>
      <div className="subagent-detail-popover__backdrop" onClick={onClose} />
      <div
        className={`subagent-detail-popover${direction === 'down' ? ' subagent-detail-popover--down' : ''}`}
        role="dialog"
        aria-label={`${projection.profile.name} 工作流详情`}
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
            <h3 className="subagent-detail-popover__section-title">最终报告</h3>
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
