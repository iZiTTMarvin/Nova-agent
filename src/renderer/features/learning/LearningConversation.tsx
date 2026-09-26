import { useEffect, useState, type RefObject } from 'react'
import type { ExtendedMessage } from '../../stores/types'
import { MarkdownRenderer } from '../chat/MarkdownRenderer'
import { getToolDisplayName } from '../chat/toolDisplay'

interface LearningConversationProps {
  messages: readonly ExtendedMessage[]
  isGenerating: boolean
  /** 阅读区滚动容器由父级拥有；本组件只请求滚动位置，不自建滚动区 */
  scrollContainerRef: RefObject<HTMLDivElement | null>
}

interface ExpandedToolState {
  readonly [toolCallId: string]: boolean
}

function messageText(message: ExtendedMessage): string {
  if (message.content) return message.content
  const parts: string[] = []
  for (const block of message.blocks ?? []) {
    if (block.type === 'text') parts.push(block.content)
  }
  return parts.join('\n')
}

function LearningToolRow({
  toolName,
  status,
  result,
  expanded,
  onToggle
}: {
  toolName: string
  status: string | undefined
  result: string | undefined
  expanded: boolean
  onToggle: () => void
}): React.ReactElement {
  const statusLabel =
    status === 'error' ? '失败' : status === 'running' ? '进行中' : '完成'
  return (
    <div className={`learning-tool learning-tool--${status ?? 'success'}`}>
      <button type="button" className="learning-tool__head" onClick={onToggle} aria-expanded={expanded}>
        <span className="learning-tool__name">{getToolDisplayName(toolName)}</span>
        <span className="learning-tool__status">{statusLabel}</span>
        <span className="learning-tool__toggle" aria-hidden="true">
          {expanded ? '收起' : '展开'}
        </span>
      </button>
      {expanded && (
        <pre className="learning-tool__result">{result ? result.slice(0, 4000) : '（无输出）'}</pre>
      )}
    </div>
  )
}

/**
 * 教练对话：学习会话的真实消息流（与开发会话同一会话系统、同一事件链路）。
 * 只渲染学习表面需要的部分，不提供编辑、重发、分叉等开发操作。
 * 文本与工具按消息内原始顺序交错渲染；无文本的用户消息不产生空气泡。
 */
export function LearningConversation({
  messages,
  isGenerating,
  scrollContainerRef
}: LearningConversationProps): React.ReactElement {
  const [expandedTools, setExpandedTools] = useState<ExpandedToolState>({})
  const lastMessageId = messages.length > 0 ? messages[messages.length - 1]!.id : null

  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [lastMessageId, messages.length, scrollContainerRef])

  if (messages.length === 0) {
    return (
      <div className="learning-conversation learning-conversation--empty">
        <div className="learning-conversation__empty-card">
          <h3>开始这段学习</h3>
          <p>
            直接说你想搞懂的问题，或者让教练从当前项目里挑一个最短的闭环起点。
            讲解会带着源码出处，回答不需要写代码。
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="learning-conversation">
      {messages.map(message => {
        if (message.role === 'user') {
          const text = messageText(message)
          if (!text.trim()) return null
          return (
            <div key={message.id} className="learning-msg learning-msg--user">
              <div className="learning-msg__bubble">{text}</div>
            </div>
          )
        }
        if (message.role !== 'assistant') return null
        const blocks = message.blocks ?? []
        return (
          <div key={message.id} className="learning-msg learning-msg--assistant">
            {blocks.map((block, index) => {
              if (block.type === 'text') {
                if (!block.content.trim()) return null
                return (
                  <div key={`${message.id}-text-${index}`} className="learning-msg__bubble learning-msg__bubble--assistant">
                    <MarkdownRenderer content={block.content} isStreaming={isGenerating && index === blocks.length - 1} />
                  </div>
                )
              }
              if (block.type !== 'tool') return null
              return (
                <LearningToolRow
                  key={`${message.id}-tool-${block.toolCallId}`}
                  toolName={block.toolName}
                  status={block.status}
                  result={block.result}
                  expanded={expandedTools[block.toolCallId] === true}
                  onToggle={() =>
                    setExpandedTools(prev => ({ ...prev, [block.toolCallId]: !prev[block.toolCallId] }))
                  }
                />
              )
            })}
            {message.interrupted && <div className="learning-msg__interrupted">本轮已取消</div>}
            {message.isError && <div className="learning-msg__interrupted">这段出错了，可以换个问法重试</div>}
          </div>
        )
      })}
      {isGenerating && (
        <div className="learning-conversation__generating" role="status">
          <span className="learning-conversation__generating-dot" aria-hidden="true" />
          教练正在整理与核对…
        </div>
      )}
    </div>
  )
}
