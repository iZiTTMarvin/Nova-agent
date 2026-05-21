import React, { useState, useRef, useEffect } from 'react'
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
  SettingsIcon 
} from '../../components/Icons'
import { ModeSwitch } from '../mode-switch/ModeSwitch'
import './ChatPanel.css'

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

  // 映射工具的中文名和主要职责
  const getToolDisplayName = (toolName: string) => {
    switch (toolName) {
      case 'ls':
        return '列出目录内容 (ls)'
      case 'read':
        return '读取文件内容 (read)'
      case 'grep':
        return '检索过滤文本 (grep)'
      case 'find':
        return '模糊检索定位文件 (find)'
      default:
        return `运行自动化工具 (${toolName})`
    }
  }

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
        <div className="tool-box__arrow">
          <ChevronIcon size={14} direction={isOpen ? 'up' : 'down'} />
        </div>
      </div>
      
      {isOpen && (
        <div className="tool-box__body">
          <div className="tool-box__section">
            <div className="tool-box__sec-title">入参 (Arguments)</div>
            <pre className="tool-box__content">
              {JSON.stringify(args, null, 2)}
            </pre>
          </div>
          
          {result && (
            <div className="tool-box__section">
              <div className="tool-box__sec-title">出参 (Result)</div>
              <pre className="tool-box__content">{result}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
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

  const [inputVal, setInputVal] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // 自动滚动到底部
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  useEffect(() => {
    scrollToBottom()
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
      <div className="chat-messages">
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

        {messages.map(msg => (
          <div 
            key={msg.id} 
            className={`chat-msg-wrapper chat-msg-wrapper--${msg.role === 'user' ? 'user' : 'assistant'}`}
          >
            <div className={`chat-msg chat-msg--${msg.role === 'user' ? 'user' : 'assistant'} ${msg.isError ? 'chat-msg--error' : ''}`}>
              {/* 渲染消息文本 */}
              {msg.content && <MarkdownRenderer content={msg.content} />}

              {/* 渲染内部包含的工具调用过程 */}
              {msg.toolCalls && msg.toolCalls.length > 0 && (
                <div style={{ marginTop: '12px' }}>
                  {msg.toolCalls.map(tc => (
                    <ToolBox
                      key={tc.id}
                      name={tc.name}
                      args={tc.arguments}
                      status={tc.status}
                      result={tc.result}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
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
