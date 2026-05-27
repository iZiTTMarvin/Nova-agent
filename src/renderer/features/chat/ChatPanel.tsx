import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useAppStore } from '../../stores/useAppStore'
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
  UndoIcon
} from '../../components/Icons'
import { ThinkingBlock } from './ThinkingBlock'
import { ModeSwitch } from '../mode-switch/ModeSwitch'
import { DiffViewer } from '../diff/DiffViewer'
import { isActiveThinkingBlock, isPermissionDeniedResult, shouldRenderToolBlock } from './renderingPolicy'
import { browserFrameScheduler, createStreamAutoScrollController, shouldPauseAutoFollow } from './autoScroll'
import { getToolDisplayName, getToolSummary } from './toolDisplay'
import { StreamingFileCard } from './StreamingFileCard'
import type { ToolBlock } from '../../../shared/session/types'
import type { ExtendedToolCall } from '../../stores/useAppStore'
import './ChatPanel.css'

/** ChatPanel 内部扩展类型：从 renderer store 传入的 ToolBlock 可能携带 argumentsRaw */
type ToolBlockWithRaw = ToolBlock & { argumentsRaw?: string }

// ── 1. 轻量级 Markdown 渲染器 ────────────────────────────────
const MarkdownRenderer: React.FC<{ content: string }> = ({ content }) => {
  if (!content) return null

  // 简单的 Markdown 块解析
  const parts = content.split(/(```[\s\S]*?```)/g)

  return (
    <div className="markdown-body">
      {parts.map((part, index) => {
        if (part.startsWith('```')) {
          // 代码块
          const match = part.match(/```(\w*)\n([\s\S]*?)```/)
          const lang = match ? match[1] : ''
          const code = match ? match[2] : part.slice(3, -3)
          return (
            <pre key={index} className="markdown-pre">
              {lang && <div className="markdown-lang-tag">{lang}</div>}
              <code className="markdown-code">{code.trim()}</code>
            </pre>
          )
        } else {
          // 普通文本，按行分割并处理内联 `code`
          return (
            <div key={index} className="markdown-text-block">
              {part.split('\n').map((line, lIdx) => {
                if (!line.trim() && lIdx > 0) return <div key={lIdx} className="markdown-paragraph-gap" />
                
                // 处理内联代码 `code`
                const subParts = line.split(/(`[^`]+`)/g)
                return (
                  <p key={lIdx} className="markdown-paragraph">
                    {subParts.map((subPart, spIdx) => {
                      if (subPart.startsWith('`') && subPart.endsWith('`')) {
                        return <code key={spIdx} className="markdown-inline-code">{subPart.slice(1, -1)}</code>
                      }
                      return subPart;
                    })}
                  </p>
                )
              })}
            </div>
          )
        }
      })}
    </div>
  )
}

// ── 2. 折叠式工具调用状态卡片 ────────────────────────────────
interface ToolBoxProps {
  name: string
  args: Record<string, unknown>
  status: 'running' | 'success' | 'error'
  result?: string
}

const ToolBox: React.FC<ToolBoxProps> = ({ name, args, status, result }) => {
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
}

// ── 2.5 解析消息中的思考内容（Windsurf 风格） ─────────────────
function parseThinking(msg: any, isGenerating: boolean, currentGeneratingMessageId: string | null) {
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
  const currentProject = useAppStore(state => state.currentProject)
  const modelConfig = useAppStore(state => state.modelConfig)
  const messages = useAppStore(state => state.messages)
  const isGenerating = useAppStore(state => state.isGenerating)
  const sendMessage = useAppStore(state => state.sendMessage)
  const cancelExecution = useAppStore(state => state.cancelExecution)
  const selectProject = useAppStore(state => state.selectProject)
  const setConfigModalOpen = useAppStore(state => state.setConfigModalOpen)
  
  // 会话与回退所需状态
  const currentSessionId = useAppStore(state => state.currentSessionId)
  const rollbackMessage = useAppStore(state => state.rollbackMessage)
  const currentGeneratingMessageId = useAppStore(state => state.currentGeneratingMessageId)
  const currentMode = useAppStore(state => state.currentMode)

  // diff 审查所需状态
  const messageDiffs = useAppStore(state => state.messageDiffs)
  const loadingDiffs = useAppStore(state => state.loadingDiffs)
  const loadingDiffPlaceholders = useAppStore(state => state.loadingDiffPlaceholders)
  const loadMessageDiffs = useAppStore(state => state.loadMessageDiffs)
  const rejectFile = useAppStore(state => state.rejectFile)
  const acceptFile = useAppStore(state => state.acceptFile)

  // 验证权限确认
  const pendingVerificationRequest = useAppStore(state => state.pendingVerificationRequest)
  const respondVerificationPermission = useAppStore(state => state.respondVerificationPermission)

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

  // 流式阶段：delta 到来时用 rAF 节流滚动，避免高频抖动
  useEffect(() => {
    if (!isGenerating) {
      streamAutoScrollRef.current?.cancel()
      return
    }

    streamAutoScrollRef.current?.schedule()

    return () => {
      streamAutoScrollRef.current?.cancel()
    }
  }, [messages, isGenerating])

  // 处理文本域自动折行高度自适应
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputVal(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }

  const handleSend = () => {
    if (!inputVal.trim() || isGenerating || !currentProject) return
    sendMessage(inputVal.trim())
    setInputVal('')
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

  // ── 空状态引导界面 ─────────────────────────────────────────
  if (!currentProject || !modelConfig) {
    const isStep1Done = !!modelConfig
    const isStep2Done = !!currentProject

    return (
      <div className="chat-empty">
        <div className="chat-empty__header">
          <NovaLogo size={48} className="chat-empty__logo" animating={true} />
          <h2 className="chat-empty__title">开启 Nova 智能编程协作</h2>
          <p className="chat-empty__subtitle">
            Nova 会按当前模式调用内置工具理解项目、修改代码，并在高风险操作前请求你的确认。开始之前，请完成以下配置：
          </p>
        </div>

        <div className="chat-empty__steps">
          {/* 第一步：模型配置 */}
          <div className="chat-empty__step-card">
            <div className={`chat-empty__step-num ${isStep1Done ? 'chat-empty__step-num--success' : ''}`}>
              {isStep1Done ? '✓' : '1'}
            </div>
            <div className="chat-empty__step-content">
              <span className="chat-empty__step-title">设置大语言模型接口</span>
              <span className="chat-empty__step-desc">
                Nova 是由模型驱动的 Agent，配置符合 OpenAI 兼容标准的 API 以驱动思考循环。
              </span>
              {!isStep1Done && (
                <button 
                  className="project-picker__btn project-picker__btn--secondary chat-empty__step-action"
                  onClick={() => setConfigModalOpen(true)}
                >
                  <SettingsIcon size={14} />
                  去配置模型
                </button>
              )}
            </div>
          </div>

          {/* 第二步：选择工作区 */}
          <div className="chat-empty__step-card">
            <div className={`chat-empty__step-num ${isStep2Done ? 'chat-empty__step-num--success' : ''}`}>
              {isStep2Done ? '✓' : '2'}
            </div>
            <div className="chat-empty__step-content">
              <span className="chat-empty__step-title">选择本地工作区目录</span>
              <span className="chat-empty__step-desc">
                选定代码库作为 Agent 的执行边界，Nova 会在这个工作区内读取、修改和验证代码。
              </span>
              {isStep1Done && !isStep2Done && (
                <button 
                  className="project-picker__btn chat-empty__step-action"
                  onClick={selectProject}
                >
                  <FolderIcon size={14} />
                  选择本地项目
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // ── 聊天消息渲染界面 ────────────────────────────────────────
  return (
    <div className="chat-panel">
      <div className="chat-messages" ref={scrollContainerRef} onScroll={handleScroll}>
        {messages.length === 0 && (
          <div style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--text-muted)',
            gap: '12px'
          }}>
            <NovaLogo size={32} />
            <p style={{ fontFamily: 'var(--font-serif)', fontSize: '1.1rem' }}>
              对话已开启，您可以输入任何代码分析与探索指令
            </p>
            <p style={{ fontSize: '0.8rem' }}>例如：“查找本项目下的所有 ts 配置文件”</p>
          </div>
        )}

        {messages.map(msg => {
          const isAssistant = msg.role === 'assistant'

          // blocks 渲染路径：按流式事件顺序展示 thinking → text → tool → text → ...
          const hasBlocks = isAssistant && msg.blocks && msg.blocks.length > 0

          // 旧路径兼容：无 blocks 时走 parseThinking 正则兜底
          const { thinkingContent, textContent, isThinkingActive } = isAssistant && !hasBlocks
            ? parseThinking(msg, isGenerating, currentGeneratingMessageId)
            : { thinkingContent: '', textContent: msg.content, isThinkingActive: false }

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
                        return block.content ? <MarkdownRenderer key={idx} content={block.content} /> : null
                      case 'tool': {
                        if (!shouldRenderToolBlock(currentMode, block.toolName)) {
                          return null
                        }
                        // write/edit 走流式卡片，其余走 ToolBox
                        if (block.toolName === 'write' || block.toolName === 'edit') {
                          const rawBlock = block as ToolBlockWithRaw
                          return (
                            <StreamingFileCard
                              key={block.toolCallId}
                              toolCallId={block.toolCallId}
                              toolName={block.toolName}
                              status={block.status}
                              args={block.arguments}
                              argumentsRaw={rawBlock.argumentsRaw}
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
                    {textContent && <MarkdownRenderer content={textContent} />}
                    {msg.toolCalls && msg.toolCalls.length > 0 && (
                      <div style={{ marginTop: '12px' }}>
                        {msg.toolCalls.map(tc => {
                          if (!shouldRenderToolBlock(currentMode, tc.name)) return null
                          // write/edit 走流式卡片，其余走 ToolBox
                          if (tc.name === 'write' || tc.name === 'edit') {
                            const extTc = tc as ExtendedToolCall
                            return (
                              <StreamingFileCard
                                key={tc.id}
                                toolCallId={tc.id}
                                toolName={tc.name}
                                status={tc.status}
                                args={tc.arguments}
                                argumentsRaw={extTc.argumentsRaw}
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
        <div ref={messagesEndRef} />
      </div>

      {/* 底部输入框 */}
      <div className="chat-input-area">
        <div className="chat-input-mode-container">
          <ModeSwitch />
        </div>
        <div className="chat-input-wrapper">
          <textarea
            ref={textareaRef}
            className="chat-textarea"
            placeholder="向 Nova 提问或分配编程任务..."
            rows={1}
            value={inputVal}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            disabled={isGenerating}
          />
          {isGenerating ? (
            <button 
              className="chat-action-btn chat-action-btn--stop" 
              onClick={cancelExecution}
              title="中断生成"
            >
              <StopIcon size={16} />
            </button>
          ) : (
            <button 
              className="chat-action-btn" 
              onClick={handleSend}
              disabled={!inputVal.trim()}
              title="发送"
            >
              <SendIcon size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
