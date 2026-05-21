import React, { useEffect } from 'react'
import { useAppStore } from './stores/useAppStore'
import { NovaLogo, SettingsIcon } from './components/Icons'
import { ProjectPicker } from './features/project-picker/ProjectPicker'
import { ChatPanel } from './features/chat/ChatPanel'
import { PermissionPrompt } from './features/permissions/PermissionPrompt'
import { SettingsModal } from './features/settings/SettingsModal'
import './App.css'

function App(): JSX.Element {
  const loadModelConfig = useAppStore(state => state.loadModelConfig)
  const loadSessions = useAppStore(state => state.loadSessions)
  const setConfigModalOpen = useAppStore(state => state.setConfigModalOpen)

  // 导入事件流响应 Actions
  const handleMessageStart = useAppStore(state => state.handleMessageStart)
  const handleTextDelta = useAppStore(state => state.handleTextDelta)
  const handleToolCall = useAppStore(state => state.handleToolCall)
  const handleToolResult = useAppStore(state => state.handleToolResult)
  const handleMessageEnd = useAppStore(state => state.handleMessageEnd)
  const handleError = useAppStore(state => state.handleError)
  const handlePermissionRequest = useAppStore(state => state.handlePermissionRequest)

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

    // 监听：Agent 流式字符输出
    const unsubTextDelta = window.api.on('agent:text-delta', (data) => {
      handleTextDelta(data.messageId, data.delta)
    })

    // 监听：Agent 触发工具调用
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

    // 监听：Agent 执行出错
    const unsubError = window.api.on('agent:error', (data) => {
      handleError(data.messageId, data.error)
    })

    // 监听：Agent 本轮思考和应答全部完成
    const unsubMessageEnd = window.api.on('agent:message-end', (data) => {
      handleMessageEnd(data.messageId)
    })

    // 清理函数：解绑所有主进程事件监听器
    return () => {
      unsubMessageStart()
      unsubTextDelta()
      unsubToolCall()
      unsubToolResult()
      unsubPermissionRequest()
      unsubError()
      unsubMessageEnd()
    }
  }, [
    handleMessageStart,
    handleTextDelta,
    handleToolCall,
    handleToolResult,
    handlePermissionRequest,
    handleError,
    handleMessageEnd
  ])

  return (
    <div className="app-layout">
      {/* 左侧功能配置栏 */}
      <aside className="app-sidebar">
        <div className="app-sidebar__header" title="Nova Agent">
          <NovaLogo size={28} />
        </div>

        <div className="app-sidebar__content">
          {/* 工作区项目卡片 */}
          <ProjectPicker />
        </div>

        <div className="app-sidebar__footer">
          <button 
            className="app-sidebar__settings-btn"
            onClick={() => setConfigModalOpen(true)}
            title="模型设置"
          >
            <SettingsIcon size={18} />
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
  )
}

export default App
