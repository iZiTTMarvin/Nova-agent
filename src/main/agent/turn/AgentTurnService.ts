/**
 * Agent turn 生命周期：SEND_MESSAGE 主链（preflight → persist → start/resume → execute → cleanup）
 */
import { BrowserWindow, app } from 'electron'
import { AgentLoop, type AgentEvent } from '../../../runtime/agent'
import { loadModelConfig } from '../../../runtime/model/config'
import { resolveSupportsVision } from '../../../shared/config/types'
import type { ModelClient } from '../../../runtime/model/ModelClient'
import type { SessionMessageAppend, SerializableContentBlock } from '../../../runtime/sessions/types'
import { extractTextFromSerializableContent, generateSessionTitleFromText } from '../../../runtime/sessions/types'
import { getSessionActiveMessages } from '../../../runtime/sessions/tree'
import type { ImageStore } from '../../../runtime/storage/ImageStore'
import { createEventStallDetector } from '../../../shared/diagnostics/stallDetector'
import type { ContentBlock } from '../../../runtime/model/types'
import { loadNovaSettings } from '../../../runtime/settings/novaSettings'
import { syncTavilyApiKeyFromSettings } from '../../../runtime/settings/syncTavilyApiKey'
import { subscribeObservationCapture } from '../../../runtime/memory/MemoryObservationBridge'
import { getSessionStore } from '../../services/SessionStoreHost'
import { getWorkspaceService } from '../../services/WorkspaceService'
import { ensureObservationCaptureForSession } from '../../services/MemoryConsolidationHost'
import { onUserTurnCompleteForExtract } from '../../services/MemoryExtractHost'
import {
  getRunCoordinator,
  getXForgeRunService,
  getRunExecutionRegistry,
  setActiveRunId
} from '../../services/RunCoordinatorHost'
import {
  getMainReadState,
  isAgentTurnInProgress,
  getActiveTurnSessionId
} from '../state'
import {
  accumulateStreamEvent,
  disposeTurnStreams,
  forwardEventToRenderer
} from '../events'
import {
  prepareAgentRuntime,
  resolveToDataUrl
} from '../runtime'
import {
  pendingAskQuestions,
  dismissAllPendingAskQuestions
} from '../interaction/askQuestionWaiters'
import { interruptStartedRunAfterFailure } from './turnLifecycle'

/** 当前全局 AgentLoop（单活动 turn） */
let agentLoop: AgentLoop | null = null

/**
 * 按 runId 注册的 AgentLoop：供 RunCoordinator terminal hook 触发 onCancel（exactly-once）。
 * 多并发 run 时按 snapshot.runId 精确查找，避免打到「最新一个」错误 loop。
 */
const agentLoopsByRunId = new Map<string, AgentLoop>()
let terminalHooksRegistered = false

export function getCurrentAgentLoop(): AgentLoop | null {
  return agentLoop
}

export function getAgentLoopForRun(runId: string): AgentLoop | undefined {
  return agentLoopsByRunId.get(runId)
}

export function ensureTerminalHooksRegistered(): void {
  if (terminalHooksRegistered) return
  terminalHooksRegistered = true
  try {
    const coord = getRunCoordinator()
    coord.onTerminalHook('onCancel', async (ctx) => {
      const loop = agentLoopsByRunId.get(ctx.snapshot.runId)
      const messageId = ctx.snapshot.messageId
      if (!loop || !messageId) return
      await loop.getHookManager().trigger({
        event: 'onCancel',
        messageId,
        interrupted: true
      })
    })
  } catch {
    // RunCoordinator 尚未初始化时跳过；registerHandlers 会先 init
  }
}

export interface SendAgentMessageParams {
  sessionId: string
  content: string
  userMessageId?: string
  images?: Array<{ fileName: string; data: string; mimeType: string }>
  regenerate?: boolean
}

export interface SendAgentMessageDeps {
  getMainWindow: () => BrowserWindow | null
  getModelClient: () => ModelClient | null
  getImageStore: () => ImageStore
}

/**
 * 一次用户 turn 的完整生命周期（原 SEND_MESSAGE handler 主体）。
 */
export async function sendAgentMessage(
  params: SendAgentMessageParams,
  deps: SendAgentMessageDeps
): Promise<void> {
  const { getMainWindow, getModelClient, getImageStore } = deps

  const coordinatorAtEntry = getRunCoordinator()
  const activeRuns = coordinatorAtEntry.listActiveRuns()
  const unsettledHandle = getRunExecutionRegistry().hasUnsettledHandle()
  const activeResumableXForge = activeRuns.find(run =>
    run.kind === 'xforge' &&
    run.sessionId === params.sessionId &&
    (run.status === 'waiting_user' || run.status === 'resuming') &&
    !unsettledHandle
  ) ?? null
  const sessionRunSnapshot = coordinatorAtEntry.getSnapshotForSession(params.sessionId)
  const interruptedResumableXForge =
    !activeResumableXForge &&
    sessionRunSnapshot?.kind === 'xforge' &&
    sessionRunSnapshot.status === 'interrupted' &&
    !unsettledHandle
      ? sessionRunSnapshot
      : null
  const resumableXForge = activeResumableXForge ?? interruptedResumableXForge
  if (isAgentTurnInProgress() && !resumableXForge) {
    const whereSession = getActiveTurnSessionId()
    const where = whereSession && whereSession !== params.sessionId
      ? '（在另一个会话中）'
      : ''
    throw new Error(`Agent 正在运行${where}，请先点击停止按钮结束当前任务后再发送`)
  }

  // guardFollowup：用户在提问面板打开时发送新消息 → 自动 dismiss 所有挂起的 askQuestion 请求，
  // 避免旧工具死等。空 answers → formatAnswers 输出 "User dismissed the question."。
  dismissAllPendingAskQuestions()

  const modelClient = getModelClient()
  if (!modelClient) {
    throw new Error('模型未配置，请先在侧边栏底部设置中配置并连接模型。')
  }

  const sessionStore = getSessionStore()
  const session = sessionStore.load(params.sessionId)
  if (!session) {
    throw new Error(`会话 ${params.sessionId} 不存在`)
  }

  // Preflight：不得在这些可预见的输入错误前创建 run。
  if (params.regenerate === true) {
    const activePath = getSessionActiveMessages(session)
    const leafUser = activePath[activePath.length - 1]
    if (!leafUser || leafUser.role !== 'user') {
      throw new Error('重新生成失败：当前激活叶子不是用户消息')
    }
    if (params.images && params.images.length > 0) {
      throw new Error('重新生成暂不支持含图片的消息')
    }
  }

  const projectPath = session.workspaceRoot
  const sessionsDir = sessionStore.getSessionsDir()
  const novaSettings = loadNovaSettings()

  if (!resumableXForge && session.mode === 'compose') {
    const existingXForge = activeRuns.find(run =>
      run.kind === 'xforge' && run.workspaceId === projectPath
    )
    if (existingXForge) {
      throw new Error('当前工作区已有未结束的 XForge 运行，请先继续或停止该运行。')
    }
  }

  // 在闭包中捕获本次调用的全部上下文，后续所有操作只读这些值
  const capturedSessionId = params.sessionId
  const capturedMode = session.mode
  const capturedPermissionPolicy = novaSettings.permissionPolicy
  const capturedWorkspaceRoot = projectPath
  const capturedSessionsDir = sessionsDir

  // 读取持久化配置以获取模型上下文窗口上限，用于动态压缩阈值
  const persistedConfig = loadModelConfig(app.getPath('userData'))
  const supportsVision = resolveSupportsVision(
    persistedConfig?.modelId ?? '',
    persistedConfig?.supportsVision
  )
  if (params.images && params.images.length > 0 && !supportsVision) {
    throw new Error(
      '当前模型不支持图片输入。请切换到支持视觉的模型后再发送图片，或仅发送文字。'
    )
  }
  syncTavilyApiKeyFromSettings()

  // 仅提前取得协调器；所有会抛错的装配和输入准备完成后才创建 run。
  const runCoordinator = getRunCoordinator()
  const xforgeService = getXForgeRunService()
  const executionRegistry = getRunExecutionRegistry()

  // session 持久化副作用留在 TurnService：factory 只装配，不写 session
  const promptCacheKey = sessionStore.ensureCacheRoutingKey(params.sessionId) ?? undefined
  if (promptCacheKey) {
    session.cacheRoutingKey = promptCacheKey
  }

  const prepared = prepareAgentRuntime({
    session,
    sessionStore,
    sessionId: params.sessionId,
    projectPath,
    sessionsDir,
    novaSettings,
    modelClient,
    getImageStore,
    readState: getMainReadState(),
    previousAgentLoop: agentLoop,
    pendingAskQuestions,
    runCoordinator,
    xforgeService,
    resumableXForge: !!resumableXForge,
    promptCacheKey
  })
  agentLoop = prepared.agentLoop
  const { eventBus, modelPool, runRefs, frozenPrompt } = prepared
  if (session.frozenSystemPrompt !== frozenPrompt) {
    session.frozenSystemPrompt = frozenPrompt
    sessionStore.save(session)
  }

  const isRegenerate = params.regenerate === true

  // 追加前记录是否已有含文字的用户消息（用于首条文字消息自动生成标题）
  const hadTextUserMsg = session.messages.some(
    m => m.role === 'user' && extractTextFromSerializableContent(m.content).trim() !== ''
  )

  // 构建用户消息内容（含图片时为 ContentBlock[]，否则为 string）
  // modeInstruction 统一由 AgentLoop.sendMessage 追加，持久化中不包含
  let sendContent: string | ContentBlock[]
  if (isRegenerate) {
    const activePath = getSessionActiveMessages(session)
    const leafUser = activePath[activePath.length - 1]
    if (!leafUser || leafUser.role !== 'user') {
      throw new Error('重新生成失败：当前激活叶子不是用户消息')
    }
    if (params.images && params.images.length > 0) {
      throw new Error('重新生成暂不支持含图片的消息')
    }
    sendContent = extractTextFromSerializableContent(leafUser.content)
  } else {
    let persistContent: string | SerializableContentBlock[]
    const persistBlocks: import('../../../shared/session/types').MessageBlock[] = []

    if (params.images && params.images.length > 0) {
      // 主进程双门闩：非视觉模型拒绝写入会话，避免 image_url 污染历史导致整段会话废掉。
      // 磁盘上已有的 nova-image 资产不在此删除；发 API 时由 visionProjection 按能力剥离。
      if (!supportsVision) {
        throw new Error(
          '当前模型不支持图片输入。请切换到支持视觉的模型后再发送图片，或仅发送文字。'
        )
      }
      // img.data 是 nova-image:// URL（渲染层上传时已落盘）。
      // 持久化只存 URL（几十字节）；发给模型时再把 URL 临时转回 base64 data URL。
      const imageReader = getImageStore()

      const imageContentBlocks: ContentBlock[] = [
        { type: 'text', text: params.content },
        ...params.images.map(img => ({
          type: 'image_url' as const,
          // 模型 API 仅认识 http(s) URL 或 data URL，nova-image:// 需转回 base64
          image_url: { url: resolveToDataUrl(imageReader, img.data, img.mimeType) }
        }))
      ]
      sendContent = imageContentBlocks

      // 持久化：content 与 blocks 都只存 nova-image:// URL，不再内联 base64
      persistContent = [
        { type: 'text', text: params.content },
        ...params.images.map(img => ({
          type: 'image_url' as const,
          image_url: { url: img.data }
        })) as SerializableContentBlock[]
      ]
      persistBlocks.push({ type: 'text', content: params.content })
      persistBlocks.push(...params.images.map(img => ({
        type: 'image' as const,
        fileName: img.fileName,
        dataUrl: img.data,
        mimeType: img.mimeType
      })))
    } else {
      // slash 调度由 AgentLoop.invokeSkill 处理；持久化保留用户原始输入
      sendContent = params.content
      persistContent = params.content
    }

    const userMessage: SessionMessageAppend = {
      // 与 renderer 乐观消息共用 id，避免分叉/编辑时「目标不在激活路径」
      id: params.userMessageId ?? `msg_${Date.now()}_user`,
      role: 'user',
      content: persistContent,
      blocks: persistBlocks.length > 0 ? persistBlocks : undefined,
      timestamp: Date.now()
    }
    const userAppend = sessionStore.appendMessageFast(params.sessionId, userMessage)
    if (!userAppend.ok) {
      throw new Error(`用户消息持久化失败: ${userAppend.error}`)
    }

    // 首条含文字的用户消息后自动生成标题，并刷新侧边栏列表
    if (!hadTextUserMsg) {
      const newText = extractTextFromSerializableContent(persistContent).trim()
      if (newText !== '') {
        const title = generateSessionTitleFromText(newText)
        if (sessionStore.updateTitle(params.sessionId, title, 'generated')) {
          getWorkspaceService().refreshAvailableSessions()
        }
      }
    }
  }

  // 常驻黑匣子：stall 只认「RunCoordinator=running 且 heartbeat 超时」
  // 设 NOVA_STALL_DEBUG=0 可静默。详见 shared/diagnostics/stallDetector.ts
  const stallMark = createEventStallDetector({
    getRunLiveness: () => {
      try {
        return getRunCoordinator().getStallLiveness(runRefs.runId)
      } catch {
        return null
      }
    }
  })

  eventBus.on((event: AgentEvent) => {
    // 投影关键事件到 RunCoordinator（工具对账 + message 绑定 + 权限 inbox）
    projectAgentEventToRun(runRefs.runId, capturedSessionId, event)
    // 轻量刷新心跳（不落盘），stall 只认 running + heartbeat 超时
    try {
      getRunCoordinator().touchHeartbeat(runRefs.runId)
    } catch { /* ignore */ }
    stallMark(event.type)
    forwardEventToRenderer(getMainWindow(), event)
    accumulateStreamEvent(capturedSessionId, event, {
      mode: capturedMode,
      permissionPolicy: capturedPermissionPolicy,
      workspaceRoot: capturedWorkspaceRoot,
      sessionsDir: capturedSessionsDir,
      eventBus,
      getMainWindow,
      runId: runRefs.runId,
      executionGeneration: runRefs.executionGeneration
    })
  })

  // 工具轨迹采集（memoryEnabled 一键统控；巩固落盘由会话生命周期 / LLM 提炼触发）
  if (novaSettings.memoryEnabled && capturedWorkspaceRoot) {
    ensureObservationCaptureForSession(params.sessionId, capturedWorkspaceRoot)
    subscribeObservationCapture(eventBus, params.sessionId)
  }

  // Execution：startRun 起的全部出口必须汇入同一 cleanup（registry / loop 索引 / activeRunId / streams）。
  // 全局 AgentLoop：旧 handle 未 settled 时禁止开启新的共享 loop（含 interrupted lingering）
  if (executionRegistry.hasUnsettledHandle()) {
    throw new Error('上一次 Agent 执行尚未完全退出，请稍候再发送（避免与旧 continuation 重叠）')
  }

  let resolveExecutionSettled = (): void => {}
  let executionRegistered = false
  let turnFailed = false
  let startedRunId: string | null = null

  try {
    let runSnap
    if (resumableXForge) {
      if (
        resumableXForge.status === 'waiting_user' ||
        (resumableXForge.status === 'interrupted' &&
          resumableXForge.xforge?.currentStage === 'waiting_user')
      ) {
        const resumed = xforgeService.resumeXForgeRun(resumableXForge.runId, params.content)
        if (!resumed.ok) throw new Error(resumed.message)
        runSnap = resumed.snapshot
      } else if (resumableXForge.status === 'interrupted') {
        const resumed = runCoordinator.transition(
          resumableXForge.runId,
          'resuming',
          'resumed_from_interrupted',
          { status: resumableXForge.status }
        )
        if (!resumed) throw new Error('XForge 中断运行恢复失败')
        runSnap = resumed
      } else {
        runSnap = resumableXForge
      }
    } else if (session.mode === 'compose') {
      runSnap = xforgeService.startXForgeRun({
        workspaceId: projectPath,
        sessionId: params.sessionId
      })
    } else {
      runSnap = runCoordinator.startRun({
        kind: 'agent',
        workspaceId: projectPath,
        sessionId: params.sessionId
      })
    }
    startedRunId = runSnap.runId
    runRefs.runId = runSnap.runId
    runRefs.executionGeneration = Date.now()
    const loopForRun = agentLoop
    if (!loopForRun) {
      throw new Error('AgentLoop 未初始化')
    }
    const executionSettled = new Promise<void>(resolve => {
      resolveExecutionSettled = resolve
    })
    executionRegistry.register({
      runId: runRefs.runId,
      generation: runRefs.executionGeneration,
      kind: runSnap.kind,
      abort: () => loopForRun.cancel(),
      settled: executionSettled
    })
    executionRegistered = true
    runCoordinator.bindExecutionGeneration(runRefs.runId, runRefs.executionGeneration)
    // 副作用入口 fencing：write/edit/checkpoint 经 ToolContext 校验 generation
    agentLoop.setExecutionFence(() =>
      runCoordinator.isExecutionCurrent(runRefs.runId, runRefs.executionGeneration)
    )
    // onCancel 按 runId 精确解析 loop（进程内索引，非 durable 真源；finally 必须清理）
    agentLoopsByRunId.set(runRefs.runId, loopForRun)
    setActiveRunId(runRefs.runId)
    if (runCoordinator.getSnapshot(runRefs.runId)?.status !== 'running') {
      runCoordinator.markRunning(runRefs.runId)
    }

    try {
      await agentLoop.sendMessage(sendContent)
      onUserTurnCompleteForExtract(
        params.sessionId,
        projectPath,
        sessionStore,
        modelPool
      )
    } catch (err) {
      turnFailed = true
      const reason = err instanceof Error ? err.message : String(err)
      try {
        const failedSnap = getRunCoordinator().getSnapshot(runRefs.runId)
        if (
          failedSnap?.kind === 'xforge' &&
          failedSnap.xforge &&
          !['completed', 'failed', 'cancelled'].includes(failedSnap.xforge.currentStage)
        ) {
          getXForgeRunService()
            .createExecutionCommitter(runRefs.executionGeneration)
            .commitXForgeStageTransition(runRefs.runId, {
              ok: true,
              from: failedSnap.xforge.currentStage,
              to: 'failed',
              reason
            })
        }
        getRunCoordinator().commitTerminal({
          runId: runRefs.runId,
          status: 'failed',
          reason
        })
      } catch { /* ignore */ }
      throw err
    } finally {
      // terminal 提交与 registry 清理分离：即使 commit 抛错，下方外层 finally 仍会 unregister
      try {
        const coord = getRunCoordinator()
        const snap = coord.getSnapshot(runRefs.runId)
        if (
          snap &&
          !['completed', 'failed', 'cancelled', 'interrupted', 'waiting_user'].includes(snap.status)
        ) {
          if (!turnFailed) {
            const cancelled = snap.status === 'cancelling'
            if (snap.kind === 'xforge' && snap.xforge) {
              getXForgeRunService()
                .createExecutionCommitter(runRefs.executionGeneration)
                .commitXForgeStageTransition(runRefs.runId, {
                  ok: true,
                  from: snap.xforge.currentStage,
                  to: cancelled ? 'cancelled' : 'failed',
                  reason: cancelled
                    ? '用户取消 XForge 执行'
                    : 'XForge Pipeline 未进入 waiting_user 或终态即退出'
                })
            } else {
              coord.commitTerminal({
                runId: runRefs.runId,
                status: cancelled ? 'cancelled' : 'completed'
              })
            }
          }
        }
      } catch (terminalErr) {
        console.error('[AgentTurnService] terminal 提交失败:', terminalErr)
      }
    }
  } catch (err) {
    // start/resume 后的任何异常都必须检查 durable 终态；不能用 registry 状态代替 run 状态。
    try {
      interruptStartedRunAfterFailure(getRunCoordinator(), startedRunId, err)
    } catch (terminalErr) {
      console.error('[AgentTurnService] 异常收敛提交失败:', terminalErr)
    }
    throw err
  } finally {
    // 统一进程内清理：settled → unregister → loop 索引 → activeRun → streams
    resolveExecutionSettled()
    if (executionRegistered && runRefs.runId) {
      executionRegistry.unregister(runRefs.runId, runRefs.executionGeneration)
      agentLoopsByRunId.delete(runRefs.runId)
      disposeTurnStreams(runRefs.runId, runRefs.executionGeneration)
      setActiveRunId(null)
    }
  }
}

/**
 * 将 AgentEvent 投影到 RunCoordinator（工具对账 / 权限 inbox / message 绑定）。
 * 旧 EventBus → IPC 路径保持不变，本函数只做旁路持久化。
 */
function projectAgentEventToRun(
  runId: string,
  sessionId: string,
  event: AgentEvent
): void {
  let coord: ReturnType<typeof getRunCoordinator>
  try {
    coord = getRunCoordinator()
  } catch {
    return
  }

  switch (event.type) {
    case 'message_start':
      coord.setMessageId(runId, event.messageId)
      if (!coord.getSnapshot(runId)?.turnStartedAt) {
        coord.markRunning(runId, event.messageId)
      }
      break
    case 'tool_call': {
      // prepared → executing：工具参数已就绪，即将执行
      const idempotent = isIdempotentToolName(event.toolName)
      coord.recordToolPhase(runId, event.toolCallId, event.toolName, 'prepared', { idempotent })
      coord.recordToolPhase(runId, event.toolCallId, event.toolName, 'executing', { idempotent })
      break
    }
    case 'tool_result': {
      const isError =
        event.result.startsWith('工具执行失败') || event.result.startsWith('权限拒绝:')
      coord.recordToolPhase(
        runId,
        event.toolCallId,
        event.toolName,
        isError ? 'failed' : 'committed',
        { idempotent: isIdempotentToolName(event.toolName) }
      )
      break
    }
    case 'permission_request': {
      coord.inbox.enqueue({
        runId,
        sessionId,
        messageId: event.messageId,
        type: 'permission',
        interactionId: event.requestId,
        payload: {
          requestId: event.requestId,
          toolName: event.toolName,
          args: event.args,
          riskLevel: event.riskLevel,
          reason: event.reason,
          commands: event.commands,
          toolCallIds: event.toolCallIds
        }
      })
      break
    }
    // verification_permission_request：message_end 后的异步验证 + 超时 waiter，
    // 不得写入 InteractionInbox（会把即将终态的 run 拖入 waiting_user）。
    case 'message_end': {
      // 终态由 SEND_MESSAGE finally 统一 commit；此处只心跳
      coord.heartbeat(runId, { label: event.interrupted ? 'interrupted' : 'message_end' })
      break
    }
    default:
      break
  }
}

/** 只读类工具可视为幂等；写入类默认非幂等，中断后不自动重放 */
function isIdempotentToolName(toolName: string): boolean {
  const readOnly = new Set([
    'read',
    'ls',
    'grep',
    'find',
    'webSearch',
    'memorySearch',
    'askQuestion'
  ])
  return readOnly.has(toolName)
}
