import React, { useEffect } from 'react'
import { useAppStore } from './stores/useAppStore'
import { NovaLogo, SettingsIcon } from './components/Icons'
import { ProjectPicker } from './features/project-picker/ProjectPicker'
import { ChatPanel } from './features/chat/ChatPanel'
import { PermissionPrompt } from './features/permissions/PermissionPrompt'
import { SettingsModal } from './features/settings/SettingsModal'
import { TitleBar } from './components/TitleBar'
import { SessionList } from './features/session-list/SessionList'
import './App.css'

function App(): JSX.Element {
  const loadModelConfig = useAppStore(state => state.loadModelConfig)
  const loadSessions = useAppStore(state => state.loadSessions)
  const setConfigModalOpen = useAppStore(state => state.setConfigModalOpen)

  // 导入事件流响应 Actions
  const handleMessageStart = useAppStore(state => state.handleMessageStart)
  const handleThinkingDelta = useAppStore(state => state.handleThinkingDelta)
  const handleTextDelta = useAppStore(state => state.handleTextDelta)
  const handleToolCallStart = useAppStore(state => state.handleToolCallStart)
  const handleToolCallDelta = useAppStore(state => state.handleToolCallDelta)
  const handleToolCall = useAppStore(state => state.handleToolCall)
  const handleToolResult = useAppStore(state => state.handleToolResult)
  const handleDiffUpdate = useAppStore(state => state.handleDiffUpdate)
  const handleMessageEnd = useAppStore(state => state.handleMessageEnd)
  const handleError = useAppStore(state => state.handleError)
  const handleVerificationResult = useAppStore(state => state.handleVerificationResult)
  const handlePermissionRequest = useAppStore(state => state.handlePermissionRequest)
  const handleVerificationPermissionRequest = useAppStore(state => state.handleVerificationPermissionRequest)
  const clearVerificationPermissionRequest = useAppStore(state => state.clearVerificationPermissionRequest)

  // 1. 初始化时加载持久化的配置和会话列表
  useEffect(() => {
    loadModelConfig()
    loadSessions()
  }, [loadModelConfig, loadSessions])

  // 2. 注册并清理主进程中 AgentLoop 跑出来的各种流式状态推送事件
  useEffect(() => {
    // 监听：Agent 思考开始
    const unsubMessageStart = window.api.on('agent:message-start', (data) => {
      handleMessageStart(data.messageId)
    })

    // 监听：Agent 思考实时增量
    const unsubThinkingDelta = window.api.on('agent:thinking-delta', (data) => {
      handleThinkingDelta(data.messageId, data.delta)
    })

    // 监听：Agent 流式字符输出
    const unsubTextDelta = window.api.on('agent:text-delta', (data) => {
      handleTextDelta(data.messageId, data.delta)
    })

    // 监听：Agent 流式工具调用开始（S2 增量事件）
    const unsubToolCallStart = window.api.on('agent:tool-call-start', (data) => {
      handleToolCallStart(data.messageId, data.toolCallId, data.toolName)
    })

    // 监听：Agent 流式工具调用参数增量（S2 增量事件）
    const unsubToolCallDelta = window.api.on('agent:tool-call-delta', (data) => {
      handleToolCallDelta(data.messageId, data.toolCallId, data.argumentsDelta)
    })

    // 监听：Agent 工具调用完成（最终事件，携带完整参数）
    const unsubToolCall = window.api.on('agent:tool-call', (data) => {
      handleToolCall(data.messageId, data.toolCallId, data.toolName, data.args)
    })

    // 监听：Agent 工具执行完毕拿到结果
    const unsubToolResult = window.api.on('agent:tool-result', (data) => {
      handleToolResult(data.messageId, data.toolCallId, data.toolName, data.result)
    })

    // 监听：Agent 请求用户确认权限
    const unsubPermissionRequest = window.api.on('agent:permission-request', (data) => {
      handlePermissionRequest(data)
    })

    // 监听：Agent 执行中实时 diff 更新
    const unsubDiffUpdate = window.api.on('agent:diff-update', (data) => {
      handleDiffUpdate(data.messageId, data.phase, data.diffs, data.reviews)
    })

    // 监听：Agent 执行出错
    const unsubError = window.api.on('agent:error', (data) => {
      handleError(data.messageId, data.error)
    })

    // 监听：验证结果
    const unsubVerificationResult = window.api.on('agent:verification-result', (data) => {
      handleVerificationResult(data.messageId, data.result)
    })

    // 监听：验证权限请求（用户确认是否执行验证命令）
    const unsubVerificationPermissionRequest = window.api.on('agent:verification-permission-request', (data) => {
      handleVerificationPermissionRequest({ requestId: data.requestId, command: data.command })
    })

    const unsubVerificationPermissionCleared = window.api.on('agent:verification-permission-cleared', (data) => {
      clearVerificationPermissionRequest(data.requestId)
    })

    // 监听：Agent 本轮思考和应答全部完成
    const unsubMessageEnd = window.api.on('agent:message-end', (data) => {
      handleMessageEnd(data.messageId)
    })

    // 清理函数：解绑所有主进程事件监听器
    return () => {
      unsubMessageStart()
      unsubThinkingDelta()
      unsubTextDelta()
      unsubToolCallStart()
      unsubToolCallDelta()
      unsubToolCall()
      unsubToolResult()
      unsubPermissionRequest()
      unsubDiffUpdate()
      unsubError()
      unsubVerificationResult()
      unsubVerificationPermissionRequest()
      unsubVerificationPermissionCleared()
      unsubMessageEnd()
    }
  }, [
    handleMessageStart,
    handleThinkingDelta,
    handleTextDelta,
    handleToolCallStart,
    handleToolCallDelta,
    handleToolCall,
    handleToolResult,
    handleDiffUpdate,
    handlePermissionRequest,
    handleError,
    handleVerificationResult,
    handleVerificationPermissionRequest,
    clearVerificationPermissionRequest,
    handleMessageEnd
  ])

  return (
    <div className="app-wrapper">
      {/* 自定义标题栏 */}
      <TitleBar />
      
      <div className="app-layout">
        {/* 左侧功能配置与会话管理栏 */}
        <aside className="app-sidebar">
          <div className="app-sidebar__header" title="Nova Agent">
            <NovaLogo size={20} />
            <span className="app-sidebar__header-title">Nova Agent</span>
          </div>

          <div className="app-sidebar__content">
            {/* 工作区项目卡片 */}
            <ProjectPicker />
            {/* 会话管理列表 */}
            <SessionList />
          </div>

          <div className="app-sidebar__footer">
            <button 
              className="app-sidebar__settings-btn"
              onClick={() => setConfigModalOpen(true)}
              title="模型设置"
            >
              <SettingsIcon size={16} />
              <span>模型设置</span>
            </button>
          </div>
        </aside>

        {/* 右侧主对话面板 */}
        <main className="app-main">
          <ChatPanel />
        </main>

        {/* 模型参数配置模态窗 */}
        <SettingsModal />

        {/* 权限确认弹窗 */}
        <PermissionPrompt />
      </div>
    </div>
  )
}

export default App
