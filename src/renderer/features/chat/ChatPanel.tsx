import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useChatStore } from '../../stores/useChatStore'
import { useAgentStore } from '../../stores/useAgentStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { selectSupportsVisionFromConfig } from '../../stores/selectors'
import { motion, AnimatePresence } from 'framer-motion'
import {
  SendIcon,
  StopIcon,
  TerminalIcon,
  ChevronIcon,
  CheckIcon,
  AlertIcon,
  NovaLogo,
  FolderIcon,
  SettingsIcon,
  UndoIcon,
  ImageIcon
} from '../../components/Icons'
import { ThinkingBlock } from './ThinkingBlock'
import { StreamingTextBlock } from './StreamingTextBlock'
import { ModeSwitch } from '../mode-switch/ModeSwitch'
import { DiffViewer } from '../diff/DiffViewer'
import { isActiveThinkingBlock, isPermissionDeniedResult, shouldRenderToolBlock } from './renderingPolicy'
import { browserFrameScheduler, createStreamAutoScrollController, shouldPauseAutoFollow } from './autoScroll'
import { getToolDisplayName, getToolSummary } from './toolDisplay'
import { StreamingFileCard } from './StreamingFileCard'
import { MarkdownRenderer } from './MarkdownRenderer'
import { UsageStats } from './UsageStats'
import { ContextIndicator } from './ContextIndicator'
import { ImagePreviewBar } from '../../components/ImagePreviewBar'
import { TodoPanel } from '../todo/TodoPanel'
import { ImagePreviewDialog } from '../../components/ImagePreviewDialog'
import {
  fileToImageAttachment,
  getPastedImageFiles,
  getDroppedImageFiles,
  getDroppedNonImageFiles,
  MAX_IMAGE_COUNT,
  type ImageAttachment
} from '../../lib/image-attachments'
import type { Mode } from '../../../shared/session/types'
import type { ExtendedMessage, ExtendedToolCall, RendererMessageBlock } from '../../stores/types'
import './ChatPanel.css'
import '../todo/TodoPanel.css'

/** ChatPanel — 主聊天控制面板 */

/** Assistant 空白等待态：模型已接管但还没产出文字、思考或工具调用时展示 */
const AssistantPendingIndicator: React.FC = () => (
  <div className="assistant-pending" role="status" aria-live="polite" aria-label="Nova 正在准备回复">
    <span className="assistant-pending__dots" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
    <span className="assistant-pending__label">正在思考</span>
  </div>
)

function hasVisibleToolCalls(toolCalls: ExtendedToolCall[] | undefined, mode: Mode): boolean {
  return !!toolCalls?.some(toolCall => shouldRenderToolBlock(mode, toolCall.name))
}

function hasVisibleBlocks(blocks: RendererMessageBlock[] | undefined, mode: Mode): boolean {
  return !!blocks?.some(block => {
    if (block.type === 'thinking' || block.type === 'text') {
      return block.content.trim().length > 0
    }
    if (block.type === 'image') {
      return true
    }
    return shouldRenderToolBlock(mode, block.toolName)
  })
}

// ── 2. 折叠式工具调用状态卡片 ────────────────────────────────
interface ToolBoxProps {
  name: string
  args: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
}

const ToolBox: React.FC<ToolBoxProps> = React.memo(function ToolBox({ name, args, status, result }) {
  const [isOpen, setIsOpen] = useState(false)
  const shouldHideArguments = isPermissionDeniedResult(result)
  const summary = getToolSummary(name, args)

  // 状态图标选择
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
    <div className="tool-box">
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
              <pre className="tool-box__content">{result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
})

// ── 2.5 解析消息中的思考内容（Windsurf 风格） ─────────────────
/** parseThinking 只关心 message 中的 thinking / content / id 字段，
 * 用 Pick<...> 限定最小依赖，替代 any 提升类型安全。 */
type ThinkingParseSource = Pick<ExtendedMessage, 'id'> & {
  thinking?: string
  content: string
}

function parseThinking(msg: ThinkingParseSource, isGenerating: boolean, currentGeneratingMessageId: string | null) {
  let thinkingContent = msg.thinking || ''
  let textContent = msg.content || ''
  let isThinkingActive = false

  // 1. 如果有明确的 msg.thinking（来自 reasoning_content 字段）
  if (msg.thinking !== undefined && msg.thinking !== '') {
    isThinkingActive = isGenerating && msg.id === currentGeneratingMessageId && !msg.content
    return { thinkingContent, textContent, isThinkingActive }
  }

  // 2. 备用逻辑：从 content 中正则解析 <think>...</think> 标签
  if (msg.content && msg.content.includes('<think>')) {
    const thinkStartIndex = msg.content.indexOf('<think>')
    const thinkEndIndex = msg.content.indexOf('</think>')

    if (thinkEndIndex !== -1) {
      thinkingContent = msg.content.substring(thinkStartIndex + 7, thinkEndIndex)
      textContent = msg.content.substring(0, thinkStartIndex) + msg.content.substring(thinkEndIndex + 8)
      isThinkingActive = false
    } else {
      // 只有 <think> 没有 </think>，正在流式思考中
      thinkingContent = msg.content.substring(thinkStartIndex + 7)
      textContent = msg.content.substring(0, thinkStartIndex)
      isThinkingActive = isGenerating && msg.id === currentGeneratingMessageId
    }
  }

  return { thinkingContent, textContent, isThinkingActive }
}

// ── 3. 主聊天控制面板 ───────────────────────────────────────
export const ChatPanel: React.FC = () => {
  // ── settings store（项目/模型/模式/配置弹窗） ──
  const currentProject = useSettingsStore(state => state.currentProject)
  const modelConfig = useSettingsStore(state => state.modelConfig)
  const currentMode = useSettingsStore(state => state.currentMode)
  const selectProject = useSettingsStore(state => state.selectProject)
  const setConfigModalOpen = useSettingsStore(state => state.setConfigModalOpen)

  // Vision 门控：当前模型是否支持图片输入
  const supportsVision = selectSupportsVisionFromConfig(modelConfig)

  // ── chat store（消息/会话/diff/流式） ──
  const messages = useChatStore(state => state.messages)
  const isGenerating = useChatStore(state => state.isGenerating)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const currentGeneratingMessageId = useChatStore(state => state.currentGeneratingMessageId)
  const sendMessage = useChatStore(state => state.sendMessage)
  const rollbackMessage = useChatStore(state => state.rollbackMessage)
  const messageDiffs = useChatStore(state => state.messageDiffs)
  const loadingDiffs = useChatStore(state => state.loadingDiffs)
  const loadingDiffPlaceholders = useChatStore(state => state.loadingDiffPlaceholders)
  const loadMessageDiffs = useChatStore(state => state.loadMessageDiffs)
  const rejectFile = useChatStore(state => state.rejectFile)
  const acceptFile = useChatStore(state => state.acceptFile)
  // Phase 6：Steering Queue
  const pendingUserMessages = useChatStore(state => state.pendingUserMessages)
  const enqueuePendingMessage = useChatStore(state => state.enqueuePendingMessage)
  const removePendingMessage = useChatStore(state => state.removePendingMessage)

  // ── agent store（权限/取消/验证权限） ──
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const pendingVerificationRequest = useAgentStore(state => state.pendingVerificationRequest)
  const respondVerificationPermission = useAgentStore(state => state.respondVerificationPermission)

  // 处理消息回退操作
  const handleRollback = async (messageId: string) => {
    if (!currentSessionId) return
    if (window.confirm('确定要回退到此消息执行前的状态吗？这将物理恢复工作区文件，并移除此消息之后的所有对话记录。')) {
      await rollbackMessage(currentSessionId, messageId)
    }
  }

  const [inputVal, setInputVal] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // 用户是否主动上滚，上滚期间停止自动跟随
  const userScrolledUpRef = useRef(false)
  // 生成阶段专用的滚动调度器：统一管理 rAF 节流与取消逻辑
  const streamAutoScrollRef = useRef<ReturnType<typeof createStreamAutoScrollController> | null>(null)

  // 图片附件状态
  const [imageAttachments, setImageAttachments] = useState<ImageAttachment[]>([])
  const [isDragOver, setIsDragOver] = useState(false)
  // 全屏预览状态
  const [previewDialog, setPreviewDialog] = useState<{ open: boolean; images: { dataUrl: string; fileName: string }[]; index: number }>({
    open: false,
    images: [],
    index: 0
  })
  // 隐藏的文件上传 input
  const fileInputRef = useRef<HTMLInputElement>(null)

  // 瞬时跳到底部（流式阶段用，避免 smooth 动画排队）
  const scrollToBottomInstant = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' })
  }, [])

  useEffect(() => {
    const controller = createStreamAutoScrollController(
      scrollToBottomInstant,
      () => userScrolledUpRef.current,
      browserFrameScheduler
    )
    streamAutoScrollRef.current = controller

    return () => {
      controller.cancel()
      streamAutoScrollRef.current = null
    }
  }, [scrollToBottomInstant])

  // 检测用户是否主动上滚：距底部超过阈值则视为上滚
  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return
    userScrolledUpRef.current = shouldPauseAutoFollow({
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight
    })
  }, [])

  // 新消息加入时自动滚到底部（用户上滚状态重置）
  useEffect(() => {
    userScrolledUpRef.current = false
    scrollToBottomInstant()
  }, [messages.length, scrollToBottomInstant])

  // 流式阶段：render pool 每次 tick 触发自动滚动，让滚动节奏与字符放出节奏同步
  // Phase 4 之前是监听 messages 变化，但 messages 在 Phase 2 buffer 后频率已大幅降低，
  // 改为 render pool tick 触发后能精确跟随"用户看到的字符展开"。
  // 取消与 scroll 都被 streamAutoScrollRef 内部用 rAF 节流，重复触发安全。
  const scheduleStreamAutoScroll = useCallback(() => {
    streamAutoScrollRef.current?.schedule()
  }, [])

  // 流式期间才挂自动滚动调度；非流式阶段由 messages 长度变化 effect 接管
  useEffect(() => {
    if (!isGenerating) {
      streamAutoScrollRef.current?.cancel()
    }
  }, [isGenerating])

  // 处理文本域自动折行高度自适应
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputVal(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }

  const handleSend = () => {
    if (!inputVal.trim() && imageAttachments.length === 0) return
    if (!modelConfig) {
      alert("请先在左下角配置模型 API Key！")
      setConfigModalOpen(true)
      return
    }
    if (!currentProject) {
      alert("请先在左侧选择或新建一个项目工作区！")
      selectProject()
      return
    }

    const text = inputVal.trim()
    const images = imageAttachments

    // Phase 6：Steering Queue
    // Agent 正在运行时，新消息进入挂起队列，turn boundary 自动 dispatch
    if (isGenerating) {
      enqueuePendingMessage(text, images)
      setInputVal('')
      setImageAttachments([])
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      return
    }

    // 正常路径：直接发送
    sendMessage(text, images)
    setInputVal('')
    setImageAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // ── 图片上传交互 ─────────────────────────────────────────

  /** toast 提示工具（项目未引入 toast 库，用轻量 alert 或 console.warn） */
  const showToast = useCallback((message: string) => {
    // eslint-disable-next-line no-alert
    window.alert(message)
  }, [])

  /** 按钮上传：将有效图片加入附件列表，失败项逐条提示 */
  const addImageFiles = useCallback(async (files: File[]) => {
    const remainingSlots = MAX_IMAGE_COUNT - imageAttachments.length
    if (remainingSlots <= 0) {
      showToast('最多上传 10 张图片')
      return
    }

    const toProcess = files.slice(0, remainingSlots)
    const results = await Promise.all(toProcess.map(f => fileToImageAttachment(f)))

    const valid: ImageAttachment[] = []
    for (const res of results) {
      if ('attachment' in res) {
        valid.push(res.attachment)
      } else if ('error' in res) {
        showToast(res.error)
      }
    }

    if (valid.length > 0) {
      setImageAttachments(prev => [...prev, ...valid])
    }
    if (files.length > toProcess.length) {
      showToast('最多上传 10 张图片')
    }
  }, [imageAttachments.length, showToast])

  /** 文件 input onChange */
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!supportsVision) return
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    await addImageFiles(files)
    e.target.value = '' // 允许重复选择相同文件
  }, [supportsVision, addImageFiles])

  /** textarea onPaste：仅 supportsVision 时拦截图片 */
  const handlePaste = useCallback(async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!supportsVision) return
    const imageFiles = getPastedImageFiles(e.clipboardData)
    if (imageFiles.length > 0) {
      e.preventDefault()
      await addImageFiles(imageFiles)
    }
  }, [supportsVision, addImageFiles])

  /** 拖拽交互 */
  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    if (!isDragOver) setIsDragOver(true)
  }, [isDragOver])

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    // 仅当真正离开容器而非子元素时取消高亮
    if (e.currentTarget === e.target) {
      setIsDragOver(false)
    }
  }, [])

  const handleDrop = useCallback(async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)

    const allFiles = Array.from(e.dataTransfer.files)
    if (allFiles.length === 0) return

    const imageFiles = getDroppedImageFiles(e.dataTransfer)
    const otherFiles = getDroppedNonImageFiles(e.dataTransfer)

    if (supportsVision && imageFiles.length > 0) {
      await addImageFiles(imageFiles)
    }

    // 非图片文件 + 不支持 vision 时的图片，统一处理为文件引用
    const fileRefs = [
      ...otherFiles,
      ...(!supportsVision ? imageFiles : [])
    ]
    if (fileRefs.length > 0) {
      const refs = fileRefs.map(f => `@${f.name}`).join(' ')
      setInputVal(prev => (prev ? prev + ' ' : '') + refs)
      // 统一调整 textarea 高度
      setTimeout(() => {
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
        }
      }, 0)
    }
  }, [supportsVision, addImageFiles])

  /** 点击预览条缩略图打开全屏 */
  const openPreviewFromBar = useCallback((index: number) => {
    setPreviewDialog({
      open: true,
      images: imageAttachments.map(a => ({ dataUrl: a.dataUrl, fileName: a.fileName })),
      index
    })
  }, [imageAttachments])

  /** 移除附件 */
  const removeAttachment = useCallback((id: string) => {
    setImageAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // ── 空状态引导界面 ─────────────────────────────────────────
  const isEmptyState = messages.length === 0

  // ── 聊天消息渲染界面 ────────────────────────────────────────
  return (
    <div
      className="chat-panel relative flex flex-col h-full bg-white"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 拖拽高亮遮罩 */}
      {isDragOver && (
        <div className="chat-panel__drag-overlay">
          <span>拖拽图片到此处上传</span>
        </div>
      )}

      {/* 消息流区域，只有非空状态时才显示并占据空间 */}
      {!isEmptyState && (
        <div className="chat-messages flex-1 overflow-y-auto pt-6 px-4 pb-32" ref={scrollContainerRef} onScroll={handleScroll}>
          {/* 当前会话的 todo 计划面板（无数据时返回 null，不占视觉空间） */}
          <TodoPanel sessionId={currentSessionId} />

        {messages.map(msg => {
          const isAssistant = msg.role === 'assistant'
          const isUser = msg.role === 'user'

          // blocks 渲染路径：按流式事件顺序展示 thinking → text → tool → text → ...
          const hasBlocks = isAssistant && msg.blocks && msg.blocks.length > 0

          // 旧路径兼容：无 blocks 时走 parseThinking 正则兜底
          const { thinkingContent, textContent, isThinkingActive } = isAssistant && !hasBlocks
            ? parseThinking(msg, isGenerating, currentGeneratingMessageId)
            : { thinkingContent: '', textContent: msg.content, isThinkingActive: false }
          const isCurrentAssistantGenerating = isAssistant && isGenerating && msg.id === currentGeneratingMessageId
          const hasVisibleContent = hasBlocks
            ? hasVisibleBlocks(msg.blocks, currentMode)
            : !!thinkingContent.trim() || !!textContent.trim() || hasVisibleToolCalls(msg.toolCalls, currentMode)
          const shouldShowPending = isCurrentAssistantGenerating && !hasVisibleContent

          // 用户消息图片提取（用于图片网格渲染）
          const userImageBlocks = isUser
            ? msg.blocks?.filter((b): b is { type: 'image'; fileName: string; dataUrl: string; mimeType: string } => b.type === 'image') ?? []
            : []

          return (
            <div
              key={msg.id}
              className={`chat-msg-wrapper chat-msg-wrapper--${msg.role === 'user' ? 'user' : 'assistant'}`}
            >
              <div className={`chat-msg chat-msg--${msg.role === 'user' ? 'user' : 'assistant'} ${msg.isError ? 'chat-msg--error' : ''}`}>
                {/* 悬浮操作栏：仅在 assistant 消息上显示，且必须是生成完毕状态 */}
                {isAssistant && !isGenerating && (
                  <div className="chat-msg__actions">
                    <button
                      className="chat-msg__action-btn"
                      onClick={() => handleRollback(msg.id)}
                      title="回退到此消息之前的状态"
                    >
                      <UndoIcon size={13} />
                    </button>
                  </div>
                )}

                {shouldShowPending && <AssistantPendingIndicator />}

                {hasBlocks ? (
                  /* blocks 顺序渲染：按真实流式事件顺序展示 */
                  msg.blocks!.map((block, idx) => {
                    switch (block.type) {
                      case 'thinking':
                        return (
                          <ThinkingBlock
                            key={idx}
                            thinking={block.content}
                            active={isActiveThinkingBlock(
                              msg.blocks!,
                              idx,
                              isGenerating,
                              msg.id,
                              currentGeneratingMessageId
                            )}
                          />
                        )
                      case 'text':
                        return (
                          <StreamingTextBlock
                            key={`${idx}-${msg.id}`}
                            fullContent={block.content}
                            isStreaming={isCurrentAssistantGenerating}
                            onRenderPoolTick={scheduleStreamAutoScroll}
                          />
                        )
                      case 'image':
                        return null // 用户消息图片在下方统一网格渲染
                      case 'tool': {
                        if (!shouldRenderToolBlock(currentMode, block.toolName)) {
                          return null
                        }
                        // write/edit 走流式卡片，其余走 ToolBox
                        if (block.toolName === 'write' || block.toolName === 'edit') {
                          return (
                            <StreamingFileCard
                              key={block.toolCallId}
                              toolCallId={block.toolCallId}
                              toolName={block.toolName}
                              status={block.status}
                              args={block.arguments}
                              result={block.result}
                            />
                          )
                        }
                        return <ToolBox key={block.toolCallId} name={block.toolName} args={block.arguments} status={block.status} result={block.result} />
                      }
                    }
                  })
                ) : (
                  /* 旧渲染路径：无 blocks 时走分桶逻辑 */
                  <>
                    {thinkingContent && (
                      <ThinkingBlock thinking={thinkingContent} active={isThinkingActive} />
                    )}
                    {textContent && <MarkdownRenderer content={textContent} isStreaming={isCurrentAssistantGenerating} />}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div style={{ marginTop: '12px' }}>
                        {msg.toolCalls.map(tc => {
                          if (!shouldRenderToolBlock(currentMode, tc.name)) return null
                          // write/edit 走流式卡片，其余走 ToolBox
                          if (tc.name === 'write' || tc.name === 'edit') {
                            return (
                              <StreamingFileCard
                                key={tc.id}
                                toolCallId={tc.id}
                                toolName={tc.name}
                                status={tc.status}
                                args={tc.arguments}
                                result={tc.result}
                              />
                            )
                          }
                          return <ToolBox key={tc.id} name={tc.name} args={tc.arguments} status={tc.status} result={tc.result} />
                        })}
                      </div>
                    )}
                  </>
                )}

                {/* 用户消息图片网格 */}
                {isUser && userImageBlocks.length > 0 && (
                  <div className="user-message-image-grid">
                    {userImageBlocks.map((img, idx) => (
                      <button
                        key={`${img.fileName}-${idx}`}
                        className="user-message-image-grid__item"
                        onClick={() => setPreviewDialog({
                          open: true,
                          images: userImageBlocks.map(b => ({ dataUrl: b.dataUrl, fileName: b.fileName })),
                          index: idx
                        })}
                        type="button"
                        title={img.fileName}
                      >
                        <img src={img.dataUrl} alt={img.fileName} draggable={false} />
                      </button>
                    ))}
                  </div>
                )}

                {/* diff 区域：loading 时优先展示骨架，避免 +0 -0 中间态 */}
                {isAssistant && currentSessionId && loadingDiffs.has(msg.id) && (
                  <DiffViewer
                    diffs={[]}
                    reviews={{}}
                    sessionId={currentSessionId}
                    messageId={msg.id}
                    isLoading={true}
                    loadingPlaceholders={loadingDiffPlaceholders[msg.id]}
                  />
                )}

                {/* diff 最终数据：仅在没有 loading 标记且有真实数据时渲染 */}
                {isAssistant && currentSessionId && !loadingDiffs.has(msg.id) && messageDiffs[msg.id] && messageDiffs[msg.id].diffs.length > 0 && (
                  <DiffViewer
                    diffs={messageDiffs[msg.id].diffs}
                    reviews={messageDiffs[msg.id].reviews}
                    sessionId={currentSessionId}
                    messageId={msg.id}
                    onRejectFile={(filePath) => rejectFile(currentSessionId, msg.id, filePath)}
                    onAcceptFile={(filePath) => acceptFile(currentSessionId, msg.id, filePath)}
                  />
                )}

                {/* 验证结果摘要 */}
                {isAssistant && msg.verificationSummary && (
                  <div className={`verification-summary ${msg.verificationSummary.startsWith('✗') ? 'verification-summary--failed' : 'verification-summary--passed'}`}>
                    <pre className="verification-summary__content">{msg.verificationSummary}</pre>
                  </div>
                )}
              </div>
            </div>
          )
        })}
        {/* 验证权限确认：用户决定是否允许执行验证命令 */}
        {pendingVerificationRequest && (
          <div className="verification-permission">
            <div className="verification-permission__text">
              Agent 请求运行验证命令：<code>{pendingVerificationRequest.command}</code>
            </div>
            <div className="verification-permission__actions">
              <button
                className="verification-permission__btn verification-permission__btn--deny"
                onClick={() => respondVerificationPermission(false)}
              >
                跳过
              </button>
              <button
                className="verification-permission__btn verification-permission__btn--allow"
                onClick={() => respondVerificationPermission(true)}
              >
                允许执行
              </button>
            </div>
          </div>
        )}

        {/* Phase 6：Steering Queue 提示：Agent 运行期间入队的挂起消息 */}
        {pendingUserMessages.length > 0 && (
          <div className="steering-queue">
            <div className="steering-queue__header">
              <span className="steering-queue__title">
                已排队 {pendingUserMessages.length} 条消息（Agent 完成后自动发送）
              </span>
            </div>
            <div className="steering-queue__list">
              {pendingUserMessages.map((msg, idx) => (
                <div key={`pending-${idx}`} className="steering-queue__item">
                  <span className="steering-queue__index">{idx + 1}.</span>
                  <span className="steering-queue__text">{msg.text || '(空文本)'}</span>
                  <button
                    className="steering-queue__remove"
                    onClick={() => removePendingMessage(idx)}
                    title="从队列移除"
                    type="button"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      )}

      {/* 底部输入框 / 空状态中央输入框 */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className={`absolute left-0 right-0 flex flex-col items-center justify-center px-4 pointer-events-none ${
          isEmptyState ? 'top-0 bottom-0' : 'bottom-6'
        }`}
      >
        <div className="w-full max-w-3xl flex flex-col items-center pointer-events-auto">

          <AnimatePresence>
            {isEmptyState && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="mb-8 flex flex-col items-center justify-center space-y-4"
              >
                <NovaLogo size={48} className="text-[#d97757]" />
                <h1 className="text-4xl md:text-5xl tracking-tight font-serif text-text-primary">
                  说出你的想法
                </h1>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            layout
            className={`w-full bg-white rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] border backdrop-blur-xl flex flex-col p-3 transition-shadow hover:shadow-[0_8px_30px_rgb(0,0,0,0.1)] ${
              isDragOver ? 'border-[#3898ec] ring-2 ring-[rgba(56,152,236,0.2)]' : 'border-gray-100/80'
            }`}
          >
            {/* 图片预览条 */}
            <ImagePreviewBar
              attachments={imageAttachments}
              onRemove={removeAttachment}
              onPreview={openPreviewFromBar}
            />

            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileInputChange}
            />

            <textarea
              ref={textareaRef}
              className="w-full bg-transparent resize-none outline-none text-[15px] leading-relaxed text-text-primary placeholder:text-gray-400 min-h-[44px] max-h-[300px] overflow-y-auto px-2 py-1"
              placeholder={isGenerating
                ? 'Agent 正在运行，输入将进入排队队列...'
                : '向 Nova 提问或分配编程任务...'}
              rows={1}
              value={inputVal}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              // Phase 6：textarea 在 Agent 运行期间不再 disabled，
              // 用户可以继续输入，新消息进入 Steering Queue 等 turn boundary 自动 dispatch
            />
            <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-50/50">
              <div className="flex items-center gap-2">
                {supportsVision && (
                  <button
                    className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-50 text-gray-500 hover:bg-[rgba(201,100,66,0.1)] hover:text-[#c96442] transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                    title="上传图片"
                    type="button"
                  >
                    <ImageIcon size={16} />
                  </button>
                )}
                <ModeSwitch />
                <ContextIndicator />
                <UsageStats />
              </div>
              <div>
                {isGenerating ? (
                  <button
                    className="flex items-center justify-center w-8 h-8 rounded-full bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                    onClick={cancelExecution}
                    title="中断生成"
                  >
                    <StopIcon size={14} />
                  </button>
                ) : (
                  <button
                    className={`flex items-center justify-center w-8 h-8 rounded-full transition-colors ${
                      inputVal.trim() || imageAttachments.length > 0
                        ? 'bg-text-primary text-white hover:bg-gray-800'
                        : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                    }`}
                    onClick={handleSend}
                    disabled={!inputVal.trim() && imageAttachments.length === 0}
                    title="发送"
                  >
                    <SendIcon size={14} />
                  </button>
                )}
              </div>
            </div>
          </motion.div>

        </div>
      </motion.div>

      {/* 全屏图片预览 */}
      <ImagePreviewDialog
        images={previewDialog.images}
        currentIndex={previewDialog.index}
        isOpen={previewDialog.open}
        onClose={() => setPreviewDialog(prev => ({ ...prev, open: false }))}
        onNavigate={(idx) => setPreviewDialog(prev => ({ ...prev, index: idx }))}
      />
    </div>
  )
}
