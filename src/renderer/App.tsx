import React, { useEffect } from 'react'
import { useAppStore } from './stores/useAppStore'
import { useAgentStore } from './stores/useAgentStore'
import { useChatStore } from './stores/useChatStore'
import { useWorkspaceStore } from './stores/useWorkspaceStore'
import { startWorkspaceDispatcher } from './stores/workspaceDispatcher'
import { SettingsIcon } from './components/Icons'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './features/chat/ChatPanel'
import { SettingsModal } from './features/settings/SettingsModal'
import { TitleBar } from './components/TitleBar'
import { useTodoStore } from './features/todo/useTodoStore'
import { useComposeStore } from './features/compose/useComposeStore'
import { createStreamDeltaBuffer } from './lib/streamDeltaBuffer'
import { installStreamingPerfMonitor } from './lib/streamingPerf'
import { gateAgentEvent } from './lib/agentEventGate'
import './App.css'

/**
 * App 根组件
 *
 * 职责：
 * 1. 启动时加载模型配置与会话列表
 * 2. 注册主进程 AgentLoop 流式事件监听器
 * 3. 装配流式缓冲（buffer → store 直连，已去掉中间 rAF 调度层）
 *
 * 流式缓冲架构（Phase 2 + Step 3）：
 * - 高频 delta（thinking / text / tool-call-args）走 buffer 时间窗口聚合
 * - buffer 到期时直接调 store.applyStreamDeltas 同步写一次 setState
 * - 低频最终事件（message-start / tool-call / tool-result / message-end / error 等）直接调 store
 * - message-end / error / dispose 之前必须 flushNow，保证最后内容不丢失
 */
function App(): JSX.Element {
  const loadModelConfig = useAppStore(state => state.loadModelConfig)
  const setConfigModalOpen = useAppStore(state => state.setConfigModalOpen)

  // 低频最终事件 action（不走 buffer）
  const handleMessageStart = useAppStore(state => state.handleMessageStart)
  const handleToolCallStart = useAppStore(state => state.handleToolCallStart)
  const handleToolCall = useAppStore(state => state.handleToolCall)
  const handleToolResult = useAppStore(state => state.handleToolResult)
  const handleDiffUpdate = useAppStore(state => state.handleDiffUpdate)
  const handleMessageEnd = useAppStore(state => state.handleMessageEnd)
  const handleUsage = useAppStore(state => state.handleUsage)
  const setContextBreakdown = useAppStore(state => state.setContextBreakdown)
  const handleError = useAppStore(state => state.handleError)
  const handleVerificationResult = useAppStore(state => state.handleVerificationResult)
  const handlePermissionRequest = useAppStore(state => state.handlePermissionRequest)
  const handleVerificationPermissionRequest = useAppStore(state => state.handleVerificationPermissionRequest)
  const clearVerificationPermissionRequest = useAppStore(state => state.clearVerificationPermissionRequest)
  // askQuestion 直接走 useAgentStore，不经 useAppStore 兼容层（避免 mergeState 漏扩展导致 selector 返回 undefined）
  const handleAskQuestionRequest = useAgentStore(state => state.handleAskQuestionRequest)
  const clearAskQuestionRequest = useAgentStore(state => state.clearAskQuestionRequest)

  // todo: 由事件总线独立维护，订阅 IPC 即可
  const applyTodoUpdate = useTodoStore(state => state.applyUpdate)

  // 编排进度 / askUser：独立 store，订阅 compose:* 事件
  const applyComposeState = useComposeStore(state => state.applyState)
  const applyComposePhase = useComposeStore(state => state.applyPhase)
  const applyComposeTasks = useComposeStore(state => state.applyTasks)
  const appendComposeLog = useComposeStore(state => state.appendLog)
  const handleComposeAskUser = useComposeStore(state => state.handleAskUser)

  // 主进程轮次归属广播（跨会话运行提示）
  const handleTurnState = useAgentStore(state => state.handleTurnState)

  // 1. 初始化时加载持久化的配置和会话列表
  //    PRD §5.1：会话列表改为由 workspace:get 统一拉取（单一事实源），
  //    startWorkspaceDispatcher 订阅 workspace:changed 并分发到 chat/settings/agent。
  useEffect(() => {
    installStreamingPerfMonitor()
    loadModelConfig()
    // 启动工作区分发器（订阅 workspace:changed）
    const stopDispatcher = startWorkspaceDispatcher()
    // 拉取初始工作区状态（会触发首次 dispatch，加载会话列表 + 选中最近会话）
    void useWorkspaceStore.getState().init()
    return () => {
      stopDispatcher()
    }
  }, [loadModelConfig])

  // 2. 注册并清理主进程中 AgentLoop 跑出来的各种流式状态推送事件
  useEffect(() => {
    // ── Phase 2 + Step 3：装配流式缓冲（直连 store，已移除 rAF 调度层） ──
    //
    // 数据流：IPC delta → buffer(16ms 文本 / 300ms 工具参数 聚合) → store.applyStreamDeltas（一次 setState）
    //
    // Step 3 之前 buffer → rAF scheduler → store 三层；
    // 现在去掉中间 rAF 聚合层（与 useStreamingRenderPool 节奏叠加 1~2 帧，且冗余），
    // buffer 在 timer 到期时直接把 batch 同步喂给 applyStreamDeltas。
    // 节奏与 React commit 的关系更可控，少 1 帧延迟。
    const buffer = createStreamDeltaBuffer((batch) => {
      useChatStore.getState().applyStreamDeltas(batch)
    })

    // 监听：Agent 思考开始
    const unsubMessageStart = window.api.on('agent:message-start', gateAgentEvent('message-start', (data) => {
      handleMessageStart(data.messageId)
    }))

    // 监听：Agent 思考实时增量 → 进 buffer
    const unsubThinkingDelta = window.api.on('agent:thinking-delta', gateAgentEvent('thinking-delta', (data) => {
      buffer.pushThinking(data.messageId, data.delta)
    }))

    // 监听：Agent 流式字符输出 → 进 buffer
    const unsubTextDelta = window.api.on('agent:text-delta', gateAgentEvent('text-delta', (data) => {
      buffer.pushText(data.messageId, data.delta)
    }))

    // 监听：Agent 流式工具调用开始（low-freq 元数据，直接 store）
    const unsubToolCallStart = window.api.on('agent:tool-call-start', gateAgentEvent('tool-call-start', (data) => {
      // 与 tool-call 最终事件同理：text_delta 走 16ms 缓冲而 start 直达 store。
      // 若不先 flush，本应落在 tool 块之前的正文会被追加到 tool 之后的 text 块，
      // 造成工具卡片与旁白顺序颠倒、Markdown 在工具边界被截断（如孤立的「`方法」）。
      buffer.flushNow()
      handleToolCallStart(data.messageId, data.toolCallId, data.toolName)
    }))

    // 监听：Agent 流式工具调用参数增量 → 进 buffer
    const unsubToolCallDelta = window.api.on('agent:tool-call-delta', gateAgentEvent('tool-call-delta', (data) => {
      buffer.pushToolCallDelta(data.messageId, data.toolCallId, data.argumentsDelta)
    }))

    // 监听：Agent 工具调用完成（最终事件，携带完整参数）→ 直接 store
    const unsubToolCall = window.api.on('agent:tool-call', gateAgentEvent('tool-call', (data) => {
      // 关键修复（竞态）：工具参数 delta 走 300ms 缓冲，而本最终事件直接进 store。
      // 若不先 flush，缓冲中迟到的 partial delta 会在 handleToolCall 写入完整 args 之后
      // 才 flush，用残缺的 partial 解析结果覆盖完整 args，导致文件名/内容丢失
      // （UI 表现为「未命名文件」+ 空内容，但后端实际已用完整 args 写盘）。
      // 因此先把缓冲中该轮残留的 delta 同步刷入 store，再用完整 args 覆盖，保证顺序正确。
      buffer.flushNow()
      handleToolCall(data.messageId, data.toolCallId, data.toolName, data.args)
    }))

    // 监听：Agent 工具执行完毕拿到结果
    const unsubToolResult = window.api.on('agent:tool-result', gateAgentEvent('tool-result', (data) => {
      handleToolResult(data.messageId, data.toolCallId, data.toolName, data.result)
    }))

    // 监听：Agent 请求用户确认权限
    const unsubPermissionRequest = window.api.on('agent:permission-request', gateAgentEvent('permission-request', (data) => {
      handlePermissionRequest(data)
    }))

    // 监听：Agent 执行中实时 diff 更新
    const unsubDiffUpdate = window.api.on('agent:diff-update', gateAgentEvent('diff-update', (data) => {
      handleDiffUpdate(data.messageId, data.phase, data.diffs, data.reviews)
    }))

    // 监听：Agent 执行出错 → 强制 flush 后再走最终事件
    const unsubError = window.api.on('agent:error', gateAgentEvent('error', (data) => {
      buffer.flushNow()
      handleError(data.messageId, data.error)
    }))

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

    // 监听：askQuestion 工具请求 → 写入 pendingAskQuestion 触发面板渲染
    const unsubAskQuestionRequest = window.api.on('agent:ask-question-request', (data) => {
      handleAskQuestionRequest({ requestId: data.requestId, questions: data.questions })
    })

    // 监听：askQuestion 已被 resolve（用户回答 / dismiss / guardFollowup / cancel）→ 清前端状态
    const unsubAskQuestionResolved = window.api.on('agent:ask-question-resolved', (data) => {
      clearAskQuestionRequest(data.requestId)
    })

    // 监听：todo 列表更新（task 5 IPC 链路终点）
    const unsubTodosUpdated = window.api.on('agent:todos-updated', (data) => {
      applyTodoUpdate({ sessionId: data.sessionId, todos: data.todos, view: data.view })
    })

    // 监听：Agent 本轮思考和应答全部完成 → 强制 flush
    const unsubMessageEnd = window.api.on('agent:message-end', gateAgentEvent('message-end', (data) => {
      buffer.flushNow()
      // await dispatchNextPending 的潜在异常，catch 后避免静默吞掉导致 UI 卡死
      Promise.resolve(handleMessageEnd(data.messageId, data.interrupted)).catch((err) => {
        console.error('[message-end] handleMessageEnd 异常:', err)
      })
    }))

    // 监听：Token 用量统计
    const unsubUsage = window.api.on('agent:usage', gateAgentEvent('usage', (data) => {
      handleUsage(data.usage)
    }))

    const unsubContextBreakdown = window.api.on('agent:context-breakdown', (data) => {
      // 不能在 effect 建立时捕获 currentSessionId；会话切换/首次打开历史会话后，
      // 旧闭包会一直拿到陈旧值，导致主进程刚推送的 breakdown 被误丢弃。
      const activeSessionId = useChatStore.getState().currentSessionId
      if (data.sessionId && data.sessionId !== activeSessionId) return
      setContextBreakdown(data)
    })

    // 监听：Hook 执行异常（不中断 Agent，仅 UI 提示）
    const unsubHookError = window.api.on('agent:hook-error', gateAgentEvent('hook-error', (data) => {
      useChatStore.getState().handleHookError(data.messageId, data.hookEvent, data.error)
    }))

    // 监听：恢复提示（重试 / 压缩上下文等）
    const unsubRecoveryHint = window.api.on('agent:recovery-hint', gateAgentEvent('recovery-hint', (data) => {
      useChatStore.getState().handleRecoveryHint(data.messageId, data.hint, data.attempt)
    }))

    // 监听：恢复状态机切换（retrying / recovering 等）
    const unsubRecoveryState = window.api.on('agent:recovery-state', gateAgentEvent('recovery-state', (data) => {
      useChatStore.getState().handleRecoveryState(data.messageId, data.state)
    }))

    // 编排：state / phase / tasks / log / askUser（透传 sessionId 供门控）
    const unsubComposeState = window.api.on('compose:state', (data) => {
      applyComposeState(data.runId, data.state, data.sessionId)
    })
    const unsubComposePhase = window.api.on('compose:phase-change', (data) => {
      applyComposePhase(data.runId, data.phase, data.sessionId)
    })
    const unsubComposeTasks = window.api.on('compose:task-update', (data) => {
      applyComposeTasks(data.runId, data.tasks, data.sessionId)
    })
    const unsubComposeLog = window.api.on('compose:log', (data) => {
      appendComposeLog(data.runId, data.message, data.sessionId)
    })
    const unsubComposeAskUser = window.api.on('compose:ask-user', (data) => {
      handleComposeAskUser(
        {
          runId: data.runId,
          requestId: data.requestId,
          question: data.question,
          options: data.options
        },
        data.sessionId
      )
    })

    // 主进程 Agent 轮次开始/结束：同步跨会话运行归属
    const unsubTurnState = window.api.on('agent:turn-state', (data) => {
      handleTurnState(data.inProgress, data.sessionId)
    })

    // 自动更新：下载完成后提示重启安装
    const unsubUpdateDownloaded = window.api.on('app:update-downloaded', (data) => {
      const install = window.confirm(`新版本 ${data.version} 已下载，是否立即重启安装？`)
      if (install) {
        void window.api.invoke('app:install-update')
      }
    })

    // 清理函数：解绑所有主进程事件监听器，释放 buffer
    // 顺序很关键（防御性）：
    // 1. 先解绑所有主进程 IPC 监听器，避免清理过程中又有新 delta 进来
    // 2. buffer.flushNow() 把 buffer 还在 pending 的 delta 同步推给 store
    //    （HMR / StrictMode 二次 effect 跑之前，旧 buffer 的最后一批 delta 不会丢失）
    // 3. dispose buffer（内部还会 flushNow 一次，此时已空，no-op）
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
      unsubAskQuestionRequest()
      unsubAskQuestionResolved()
      unsubTodosUpdated()
      unsubMessageEnd()
      unsubUsage()
      unsubContextBreakdown()
      unsubHookError()
      unsubRecoveryHint()
      unsubRecoveryState()
      unsubComposeState()
      unsubComposePhase()
      unsubComposeTasks()
      unsubComposeLog()
      unsubComposeAskUser()
      unsubTurnState()
      unsubUpdateDownloaded()
      buffer.flushNow()
      buffer.dispose()
    }
  }, [
    handleMessageStart,
    handleToolCallStart,
    handleToolCall,
    handleToolResult,
    handleDiffUpdate,
    handlePermissionRequest,
    handleError,
    handleVerificationResult,
    handleVerificationPermissionRequest,
    clearVerificationPermissionRequest,
    handleAskQuestionRequest,
    clearAskQuestionRequest,
    applyTodoUpdate,
    applyComposeState,
    applyComposePhase,
    applyComposeTasks,
    appendComposeLog,
    handleComposeAskUser,
    handleTurnState,
    handleMessageEnd,
    handleUsage,
    setContextBreakdown
  ])

  return (
    <div className="app-wrapper">
      {/* 自定义标题栏 */}
      <TitleBar />

      <div className="app-layout">
        {/* 左侧功能配置与会话管理栏 */}
        <Sidebar />

        {/* 右侧主对话面板 */}
        <main className="app-main">
          <ChatPanel />
        </main>

        {/* 模型参数配置模态窗 */}
        <SettingsModal />
      </div>
    </div>
  )
}

export default App
