/**
 * Agent turn 生命周期：SEND_MESSAGE 主链（preflight → persist → start/resume → execute → cleanup）
 */
import { BrowserWindow, app } from 'electron'
import {
  AgentLoop,
  getSubAgentSpec,
  type AgentEvent
} from '../../../runtime/agent'
import { writerLeaseRegistry } from '../../../runtime/workspace'
import {
  AgentTurnExecutor,
  projectAgentEventToRun,
  resolveAgentTurnRoute
} from '../../../runtime/agent/turn'
import {
  type SpawnSubagentPort,
  type SubagentEventContext
} from '../../../runtime/subagents'
import { loadModelConfig } from '../../../runtime/model/config'
import { loadLlmRegistry } from '../../../runtime/model/config'
import { resolveSupportsVision } from '../../../shared/config/types'
import type { ModelClient } from '../../../runtime/model/ModelClient'
import type { SessionMessageAppend, SerializableContentBlock } from '../../../runtime/sessions/types'
import type { MessageBlock, Mode, PermissionMode } from '../../../shared/session/types'
import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
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
  getRunExecutionRegistry,
  setActiveRunId
} from '../../services/RunCoordinatorHost'
import {
  getReadStateForSession,
  isSessionTurnInProgress
} from '../state'
import {
  accumulateStreamEvent,
  disposeTurnStreams,
  forwardEventToRenderer
} from '../events'
import {
  prepareAgentRuntime,
  prepareSubagentRuntime,
  resolveToDataUrl
} from '../runtime'
import {
  pendingAskQuestions,
  dismissPendingAskQuestionsForSession,
  dismissPendingAskQuestionsForRun
} from '../interaction/askQuestionWaiters'
import { planReviewWaiters } from '../interaction/planReviewWaiters'
import {
  enqueueSteeringMessage,
  dequeueSteeringMessage,
  type SteeringMessage
} from './SteeringQueue'
import { resolveEntryLockAction } from './entryLock'
import { SubagentExecutionHost } from '../subagents'
import {
  resolveChildModelFromHeader,
  resolveChildModelFromProfile
} from '../subagents/childModelRouting'
import { getSubagentScheduler } from '../../services/SubagentSchedulerHost'
import {
  ensureCodeGraphForWorkspace,
  getCodeContextQueryPort
} from '../../services/CodeGraphHost'

/**
 * 按 runId 注册的 AgentLoop：供 RunCoordinator terminal hook 触发 onCancel（exactly-once）。
 * 多并发 run 时按 snapshot.runId 精确查找，避免打到「最新一个」错误 loop。
 *
 * 每个 turn 装配独立的 AgentLoop（per-run 隔离），turn 终态后从该索引移出，转入 idle 托管。
 * 不再保留全局单例 loop：并发 turn 各自独立，互不覆盖。
 */
const agentLoopsByRunId = new Map<string, AgentLoop>()

/**
 * 按会话托管的 idle 期 AgentLoop。
 *
 * turn 结束后 AgentLoop 不立即销毁：它会启动 idle 压缩计时器（266s），在用户空闲期间
 * 自动压缩对话历史以维持缓存前缀稳定。该托管表让 loop 在「执行期索引」之外继续存活，
 * 直到 idle 压缩窗口结束（下一 turn 装配 / 会话取消 / 会话删除）才真正释放。
 *
 * 每个会话同时最多托管一个 idle loop：新 turn 装配时旧 loop 立即 dispose（接替语义），
 * 与旧「全局单例靠下一 turn 覆盖」的行为一致，但精确到会话维度。
 */
const idleLoopsBySession = new Map<string, AgentLoop>()
let terminalHooksRegistered = false

/**
 * 把一个会话的 idle 期 loop 销毁（若存在）。
 *
 * 调用时机：会话被删除 / 被取消 / 不再需要 idle 压缩窗口。
 * 内部幂等：无可托管 loop 时直接返回。
 */
export function disposeIdleLoopForSession(sessionId: string): void {
  const loop = idleLoopsBySession.get(sessionId)
  if (!loop) return
  idleLoopsBySession.delete(sessionId)
  loop.dispose()
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

  // 并发模型：不同会话可同时跑，同一会话同时最多一个 turn。
  // 该会话已有占用 turn 的 run 时，按占用者决定处理方式：编排运行中直接拒绝并回运行态信号，
  // 其余情况推入 steering queue 等当前 turn 结束后处理；其它会话不受影响。
  if (handleEntryLock(params)) return

  // guardFollowup：用户在提问面板打开时发送新消息 → 自动 dismiss 本会话挂起的 askQuestion 请求，
  // 避免旧工具死等。空 answers → formatAnswers 输出 "User dismissed the question."。
  // 按会话过滤：并发下其它会话正在等待的提问不受影响。
  dismissPendingAskQuestionsForSession(params.sessionId)

  const modelClient = getModelClient()
  if (!modelClient) {
    throw new Error('模型未配置，请先在侧边栏底部设置中配置并连接模型。')
  }

  const sessionStore = getSessionStore()
  const session = sessionStore.load(params.sessionId)
  if (!session) {
    throw new Error(`会话 ${params.sessionId} 不存在`)
  }
  if (session.kind === 'subagent') {
    throw new Error('Child Session 由父任务的执行服务管理，不能从普通消息入口启动新 turn')
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


  // 在闭包中捕获本次调用的全部上下文，后续所有操作只读这些值
  const capturedSessionId = params.sessionId
  const capturedMode = session.mode
  const capturedPermissionMode = session.permissionMode
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
  const executionRegistry = getRunExecutionRegistry()

  // 关键段复查（TOCTOU 防御）：入口锁在第一次检查后到这里隔着
  // prepareAgentRuntime / appendMessageFast 等多个 await，drain 出队的 turn 和用户新消息
  // 可能同时通过入口检查。在装配 / 持久化 / startRun 前再查一次：若该 session 期间已被
  // 另一个 turn 占用，按同一套入口锁规则处理后直接返回，绝不产生同会话双 run。
  // 此处位于 try/finally 之前，return 不会触发任何清理副作用。
  if (handleEntryLock(params)) return

  // session 持久化副作用留在 TurnService：factory 只装配，不写 session
  const promptCacheKey = sessionStore.ensureCacheRoutingKey(params.sessionId) ?? undefined
  if (promptCacheKey) {
    session.cacheRoutingKey = promptCacheKey
  }

  if (session.codeIndexEnabled) {
    const workspaceState = getWorkspaceService().getState()
    // 同根会话切换不会发 root-change；只允许当前会话启动，避免旧 turn 重开已关闭工作区。
    if (
      workspaceState.currentSessionId === params.sessionId &&
      workspaceState.currentProjectPath === projectPath &&
      getCodeContextQueryPort(projectPath) === null
    ) {
      ensureCodeGraphForWorkspace(projectPath)
    }
  }

  let spawnSubagentPort: SpawnSubagentPort | undefined
  const prepared = prepareAgentRuntime({
    session,
    sessionStore,
    sessionId: params.sessionId,
    projectPath,
    sessionsDir,
    novaSettings,
    modelClient,
    getImageStore,
    // readState 按会话隔离：同会话跨 turn 复用，不同会话互不污染
    readState: getReadStateForSession(params.sessionId),
    pendingAskQuestions,
    runCoordinator,
    promptCacheKey,
    getSpawnSubagentPort: () => spawnSubagentPort,
    getCodeContextQueryPort: () => getCodeContextQueryPort(projectPath)
  })
  // 本 turn 专属 AgentLoop（局部变量，不污染模块级状态，并发 turn 各自独立）
  const loopForRun = prepared.agentLoop
  const { eventBus, modelPool, runRefs, frozenPrompt } = prepared
  const turnExecutor = new AgentTurnExecutor(runCoordinator, executionRegistry)
  spawnSubagentPort = new SubagentExecutionHost({
    sessionStore,
    runCoordinator,
    turnExecutor,
    scheduler: getSubagentScheduler(),
    isRunExecutionActive: (runId) => executionRegistry.get(runId) !== null,
    hasSessionExecutionHandle: (sessionId) =>
      executionRegistry.listActiveRunIds().some(
        (runId) => runCoordinator.getSnapshot(runId)?.sessionId === sessionId
      ),
    hostHasArchiveRead: () => prepared.toolRegistry.getTool('archive_read') !== undefined,
    loadProfile: (profileId) => getSubAgentSpec(profileId, projectPath),
    resolveExecutionTarget: (input) => {
      const registry = loadLlmRegistry(app.getPath('userData'))
      if (!registry) throw new Error('子代理模型不可用：尚未配置模型注册表')
      if ('header' in input) {
        return resolveChildModelFromHeader(registry, input.header).header
      }
      return resolveChildModelFromProfile(registry, input.profile, {
        ...(input.modelOverride ? { modelOverride: input.modelOverride } : {}),
        ...(input.reasoningEffort !== undefined ? { reasoningEffortOverride: input.reasoningEffort } : {})
      }).header
    },
    prepareTurn: (input) => {
      const childPromptCacheKey =
        sessionStore.ensureCacheRoutingKey(input.childSession.id) ?? undefined
      const registry = loadLlmRegistry(app.getPath('userData'))
      if (!registry) throw new Error('子代理模型不可用：尚未配置模型注册表')
      const childPrepared = prepareSubagentRuntime({
        ...input,
        registry,
        // compose 阶段门禁随父会话继承，子代理能力只能收窄
        toolAuthorizationPolicy: prepared.toolAuthorizationPolicy,
        resolveTool: (name) => prepared.toolRegistry.getTool(name),
        sessionStore,
        sessionsDir,
        readState: getReadStateForSession(input.childSession.id),
        resolveImageUrl: (url) => resolveToDataUrl(getImageStore(), url),
        ...(childPromptCacheKey ? { promptCacheKey: childPromptCacheKey } : {})
      })
      const childRunId = input.childSession.subagent.lineage.spawnRunId
      childPrepared.agentLoop.setAskQuestionHandler(
        (requestId: string, questions: AskQuestionItem[]): Promise<AskQuestionAnswer[]> =>
          new Promise<AskQuestionAnswer[]>((resolve) => {
            pendingAskQuestions.set(requestId, {
              sessionId: input.childSession.id,
              runId: childRunId,
              resolve,
              eventBus: childPrepared.eventBus
            })
            const messageId = runCoordinator.getSnapshot(childRunId)?.messageId ?? ''
            const interaction = runCoordinator.inbox.enqueue({
              runId: childRunId,
              sessionId: input.childSession.id,
              messageId,
              type: 'askQuestion',
              interactionId: requestId,
              payload: { requestId, questions }
            })
            childPrepared.eventBus.emit({
              type: 'ask_question_request',
              requestId,
              questions,
              sessionId: input.childSession.id,
              messageId,
              runId: childRunId,
              interactionId: interaction.interactionId,
              version: interaction.version
            })
          })
      )
      return childPrepared
    },
    onEvent: (event, context) => {
      forwardAgentEvent(event, {
        runId: context.runId,
        executionGeneration: context.executionGeneration,
        sessionId: context.childSessionId,
        parentSessionId: context.parentSessionId,
        mode: context.mode,
        permissionMode: capturedPermissionMode,
        workspaceRoot: context.workspaceRoot,
        sessionsDir: capturedSessionsDir,
        eventBus: context.agentLoop.getEventBus(),
        getMainWindow
      })
    },
    onExecutionStarted: (context) => {
      agentLoopsByRunId.set(context.runId, context.agentLoop)
    },
    onExecutionSettled: (context) => {
      agentLoopsByRunId.delete(context.runId)
      dismissPendingAskQuestionsForRun(context.runId)
      disposeTurnStreams(context.runId, context.executionGeneration)
      writerLeaseRegistry.release(context.resourceOwnerRunId)
    },
    getMainWindow,
    refreshAvailableSessions: () => {
      getWorkspaceService().refreshAvailableSessions()
    }
  })
  if (session.frozenSystemPrompt !== frozenPrompt) {
    session.frozenSystemPrompt = frozenPrompt
    sessionStore.save(session)
  }

  const isRegenerate = params.regenerate === true

  // 构建用户消息内容（含图片时为 ContentBlock[]，否则为 string）
  // modeInstruction 统一由 AgentLoop.sendMessage 追加，持久化中不包含
  let sendContent: string | ContentBlock[]
  let persistContent: string | SerializableContentBlock[] | null = null
  let persistBlocks: MessageBlock[] = []

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
  } else if (params.images && params.images.length > 0) {
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

    sendContent = [
      { type: 'text', text: params.content },
      ...params.images.map(img => ({
        type: 'image_url' as const,
        // 模型 API 仅认识 http(s) URL 或 data URL，nova-image:// 需转回 base64
        image_url: { url: resolveToDataUrl(imageReader, img.data, img.mimeType) }
      }))
    ]

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
    // 持久化保留用户原始输入；slash 调度由 resolveAgentTurnRoute 在 startRun 前解析
    sendContent = params.content
    persistContent = params.content
  }

  // Turn 路由：在 startRun 和用户消息落盘前确定实际执行类型
  const turnRoute = resolveAgentTurnRoute({
    content: sendContent,
    mode: session.mode,
    skillRegistry: prepared.skillRegistry,
    workspacePath: projectPath
  })

  // 用户消息持久化（在 route 解析和并发限制之后，startRun 之前）
  if (!isRegenerate && persistContent !== null) {
    // 追加前记录是否已有含文字的用户消息（用于首条文字消息自动生成标题）
    const hadTextUserMsg = session.messages.some(
      m => m.role === 'user' && extractTextFromSerializableContent(m.content).trim() !== ''
    )

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
    handleAgentEvent(event, {
      runCoordinator,
      runId: runRefs.runId,
      resourceOwnerRunId: runRefs.resourceOwnerRunId,
      executionGeneration: runRefs.executionGeneration,
      sessionId: capturedSessionId,
      mode: capturedMode,
      permissionMode: capturedPermissionMode,
      workspaceRoot: capturedWorkspaceRoot,
      sessionsDir: capturedSessionsDir,
      eventBus,
      getMainWindow,
      stallMark
    })
  })

  // 工具轨迹采集（memoryEnabled 一键统控；巩固落盘由会话生命周期 / LLM 提炼触发）
  if (novaSettings.memoryEnabled && capturedWorkspaceRoot) {
    ensureObservationCaptureForSession(params.sessionId, capturedWorkspaceRoot)
    subscribeObservationCapture(eventBus, params.sessionId)
  }

  // Execution：startRun 起的全部出口必须汇入同一 cleanup（registry / loop 索引 / activeRunId / streams）。
  // 同会话的「未 settled 执行」已在入口锁 isSessionTurnInProgress 中拦截（进入 steering queue）；
  // 不同会话允许并发持有各自执行句柄，此处不再做全局互斥。

  try {
    await turnExecutor.execute({
      agentLoop: loopForRun,
      task: sendContent,
      route: turnRoute,
      sessionId: params.sessionId,
      workingDirectory: projectPath,
      isolation: 'shared',
      runRefs,
      onStarted: (context) => {
        agentLoopsByRunId.set(context.runId, loopForRun)
        setActiveRunId(context.runId)
      },
      afterOutcome: (outcome) => {
        // incomplete 轮次同样已结束（被停止策略截断），对话内容照样值得提炼
        if (outcome.status === 'completed' || outcome.status === 'incomplete') {
          onUserTurnCompleteForExtract(
            params.sessionId,
            projectPath,
            sessionStore,
            modelPool
          )
        }
      },
      onCleanup: (context) => {
        agentLoopsByRunId.delete(context.runId)
        planReviewWaiters.cancelForRun(context.runId)
        disposeTurnStreams(context.runId, context.executionGeneration)
        writerLeaseRegistry.release(context.resourceOwnerRunId)
        setActiveRunId(null)
      }
    })
  } finally {
    // 主 loop 进入 idle 托管：turn 结束后保留存活以驱动空闲压缩计时器。
    // 同会话若已有上一轮残留的 idle loop，先 dispose 接替（执行期索引此时已无重叠）。
    retireIdleLoopForSession(params.sessionId)
    idleLoopsBySession.set(params.sessionId, loopForRun)
    // 同会话排队消息：当前 turn 终态后，取出队首发起新 turn（递归，FIFO）
    drainSteeringQueue(params.sessionId, deps)
  }
}

/**
 * 应用会话入口锁，返回 true 表示本次调用已被处理、调用方必须直接 return。
 *
 * 决策规则在 entryLock.ts（纯函数），本函数只负责执行副作用：
 * 排队、或向 renderer 发运行态信号。
 */
function handleEntryLock(params: SendAgentMessageParams): boolean {
  const action = resolveEntryLockAction({
    turnInProgress: isSessionTurnInProgress(params.sessionId)
  })
  if (action.kind === 'proceed') return false
  enqueueSteeringMessage(params.sessionId, params)
  return true
}

/**
 * 销毁该会话当前托管的 idle loop（若有）。
 *
 * 与 disposeIdleLoopForSession（供外部取消/删除调用）共享实现，区别在于语义：
 * - retire：新 turn 接替旧 loop（同会话天然串行，旧的不再有用）
 * - dispose：会话层面主动终止，idle 压缩窗口不再需要
 */
function retireIdleLoopForSession(sessionId: string): void {
  const loop = idleLoopsBySession.get(sessionId)
  if (!loop) return
  idleLoopsBySession.delete(sessionId)
  loop.dispose()
}

/**
 * 取出该会话 steering queue 的队首消息并发起新 turn。
 *
 * 只在当前 turn 真正结束（finally 执行）后调用，保证同会话串行。
 * 队列为空时直接返回；取出后递归进入 sendAgentMessage，下一轮结束时会再次 drain。
 */
function drainSteeringQueue(sessionId: string, deps: SendAgentMessageDeps): void {
  const next = dequeueSteeringMessage(sessionId)
  if (!next) return
  // 新 turn 在 finally 中执行；异常交给 sendAgentMessage 自身上层处理，不再吞掉
  void sendAgentMessage(fromSteeringMessage(next), deps).catch((err) => {
    console.error(`[AgentTurnService] steering queue 排队消息执行失败 session=${sessionId}:`, err)
  })
}

/** 把 steering 队列项还原为 sendAgentMessage 入参（结构一致，仅做类型收窄）。 */
function fromSteeringMessage(msg: SteeringMessage): SendAgentMessageParams {
  return {
    sessionId: msg.sessionId,
    content: msg.content,
    ...(msg.userMessageId !== undefined ? { userMessageId: msg.userMessageId } : {}),
    ...(msg.images !== undefined ? { images: msg.images } : {}),
    ...(msg.regenerate !== undefined ? { regenerate: msg.regenerate } : {}),
  }
}

/**
 * 给事件打上归属会话 id。
 *
 * 多数事件变体已声明可选 sessionId 字段；这里统一原地写入，避免每个 emit 点重复传参。
 * 事件是瞬态对象，写完后只在本次回调链路消费，不会跨会话重放，原地写安全。
 */
function stampSessionId(event: AgentEvent, sessionId: string): void {
  ;(event as { sessionId?: string }).sessionId = sessionId
}

/**
 * 子代理事件携带直接父会话归属：renderer 的会话门控据此把关键交互
 * （如权限请求）路由到父会话视图，不依赖 renderer 侧子会话列表的时序。
 */
function stampParentSessionId(event: AgentEvent, parentSessionId: string): void {
  if (event.type === 'permission_request') {
    event.parentSessionId = parentSessionId
  }
}

interface ForwardAgentEventContext {
  readonly runId: string
  readonly executionGeneration: number
  readonly sessionId: string
  /** 子代理事件携带直接父会话归属；主会话事件不设置 */
  readonly parentSessionId?: string
  readonly mode: Mode
  readonly permissionMode: PermissionMode
  readonly workspaceRoot: string
  readonly sessionsDir: string
  readonly eventBus: ReturnType<AgentLoop['getEventBus']>
  readonly getMainWindow: () => BrowserWindow | null
  readonly stallMark?: (eventType: string) => void
}

interface HandleAgentEventContext extends ForwardAgentEventContext {
  readonly runCoordinator: ReturnType<typeof getRunCoordinator>
  readonly resourceOwnerRunId: string
}

/** 普通与 delegated turn 共用同一套 Run 投影和既有 renderer 事件顺序。 */
function handleAgentEvent(
  event: AgentEvent,
  context: HandleAgentEventContext
): void {
  projectAgentEventToRun(
    {
      runCoordinator: context.runCoordinator,
      runId: context.runId,
      resourceOwnerRunId: context.resourceOwnerRunId,
      sessionId: context.sessionId
    },
    event
  )
  try {
    context.runCoordinator.touchHeartbeat(context.runId)
  } catch {
    // 事件投影不能因并发终态导致 renderer 事件丢失。
  }
  forwardAgentEvent(event, context)
}

function forwardAgentEvent(
  event: AgentEvent,
  context: ForwardAgentEventContext
): void {
  context.stallMark?.(event.type)
  stampSessionId(event, context.sessionId)
  if (context.parentSessionId) stampParentSessionId(event, context.parentSessionId)
  forwardEventToRenderer(context.getMainWindow(), event)
  accumulateStreamEvent(context.sessionId, event, {
    mode: context.mode,
    permissionMode: context.permissionMode,
    workspaceRoot: context.workspaceRoot,
    sessionsDir: context.sessionsDir,
    eventBus: context.eventBus,
    getMainWindow: context.getMainWindow,
    runId: context.runId,
    executionGeneration: context.executionGeneration
  })
}
