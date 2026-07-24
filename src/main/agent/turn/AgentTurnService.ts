/**
 * Agent turn 生命周期：SEND_MESSAGE 主链（preflight → persist → start/resume → execute → cleanup）
 */
import { BrowserWindow, app } from 'electron'
import { AgentLoop, type AgentEvent } from '../../../runtime/agent'
import { subAgentBridgeRegistry } from '../../../runtime/tools/subAgentBridge'
import { writerLeaseRegistry } from '../../../runtime/workspace'
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
  resolveToDataUrl
} from '../runtime'
import {
  pendingAskQuestions,
  dismissPendingAskQuestionsForSession
} from '../interaction/askQuestionWaiters'
import { interruptStartedRunAfterFailure } from './turnLifecycle'
import {
  enqueueSteeringMessage,
  dequeueSteeringMessage,
  type SteeringMessage
} from './SteeringQueue'

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
  // 并发模型：不同会话可同时跑，同一会话同时最多一个 turn。
  // 该会话已有占用 turn 的 run 时，把消息推入 steering queue 等当前 turn 结束后处理，
  // 而不是直接拒绝；其它会话不受影响。
  if (!resumableXForge && isSessionTurnInProgress(params.sessionId)) {
    enqueueSteeringMessage(params.sessionId, params)
    return
  }

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

  // 关键段复查（TOCTOU 防御）：入口锁在 isSessionTurnInProgress 检查后到这里隔着
  // prepareAgentRuntime / appendMessageFast 等多个 await，drain 出队的 turn 和用户新消息
  // 可能同时通过入口检查。在装配 / 持久化 / startRun 前再查一次：若该 session 期间已被
  // 另一个 turn 占用，把消息推回 steering queue 直接返回，绝不产生同会话双 run。
  // 此处位于 try/finally 之前，return 不会触发任何清理副作用。
  if (!resumableXForge && isSessionTurnInProgress(params.sessionId)) {
    enqueueSteeringMessage(params.sessionId, params)
    return
  }

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
    // readState 按会话隔离：同会话跨 turn 复用，不同会话互不污染
    readState: getReadStateForSession(params.sessionId),
    pendingAskQuestions,
    runCoordinator,
    xforgeService,
    resumableXForge: !!resumableXForge,
    promptCacheKey
  })
  // 本 turn 专属 AgentLoop（局部变量，不污染模块级状态，并发 turn 各自独立）
  const loopForRun = prepared.agentLoop
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
    // 给每个事件打上归属会话标记，供 renderer 区分焦点 / 后台会话，避免串台。
    // 事件是 emit-and-forget 的瞬态对象，原地写入 sessionId 安全且零拷贝。
    stampSessionId(event, capturedSessionId)
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
  // 同会话的「未 settled 执行」已在入口锁 isSessionTurnInProgress 中拦截（进入 steering queue）；
  // 不同会话允许并发持有各自执行句柄，此处不再做全局互斥。

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
    // 把 runId 注入 AgentLoop，供写者租约 / 子代理权限按 run 归属
    loopForRun.setRunRef(runRefs.runId)
    // 副作用入口 fencing：write/edit/checkpoint 经 ToolContext 校验 generation
    loopForRun.setExecutionFence(() =>
      runCoordinator.isExecutionCurrent(runRefs.runId, runRefs.executionGeneration)
    )
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
    // onCancel 按 runId 精确解析 loop（进程内索引，非 durable 真源；finally 必须清理）
    agentLoopsByRunId.set(runRefs.runId, loopForRun)
    setActiveRunId(runRefs.runId)
    if (runCoordinator.getSnapshot(runRefs.runId)?.status !== 'running') {
      runCoordinator.markRunning(runRefs.runId)
    }

    try {
      await loopForRun.sendMessage(sendContent)
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
    // 统一进程内清理：settled → unregister → loop 索引 → activeRun → streams → bridge
    resolveExecutionSettled()
    if (executionRegistered && runRefs.runId) {
      executionRegistry.unregister(runRefs.runId, runRefs.executionGeneration)
      agentLoopsByRunId.delete(runRefs.runId)
      disposeTurnStreams(runRefs.runId, runRefs.executionGeneration)
      // 释放本 run 的子代理桥接，回收内存（并发 run 互不影响）
      subAgentBridgeRegistry.release(runRefs.runId)
      // 释放本 run 持有的写者租约，唤醒等待同一工作区的其它 run
      writerLeaseRegistry.release(runRefs.runId)
      setActiveRunId(null)
    }
    // 主 loop 进入 idle 托管：turn 结束后保留存活以驱动空闲压缩计时器。
    // 同会话若已有上一轮残留的 idle loop，先 dispose 接替（执行期索引此时已无重叠）。
    retireIdleLoopForSession(params.sessionId)
    idleLoopsBySession.set(params.sessionId, loopForRun)
    // 同会话排队消息：当前 turn 终态后，取出队首发起新 turn（递归，FIFO）
    drainSteeringQueue(params.sessionId, deps)
  }
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
    ...(msg.regenerate !== undefined ? { regenerate: msg.regenerate } : {})
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
      // 权限等待会让 run 进入 waiting_user，期间不写入；释放写者租约让其它会话能继续写。
      // 用户授权后 turn 恢复，下次写操作会惰性重新获取租约（幂等）。
      writerLeaseRegistry.release(runId)
      break
    }
    case 'ask_question_request': {
      // askQuestion 入队已在 askQuestionHandler 完成（让 run 进入 waiting_user）。
      // 这里只负责释放写者租约：提问等待期间不写入，让其它会话能继续写。
      // 用户回答后 turn 恢复，下次写操作惰性重新获取租约（幂等）。
      writerLeaseRegistry.release(runId)
      break
    }
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
