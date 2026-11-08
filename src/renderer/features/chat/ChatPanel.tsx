import React, { lazy, Suspense, useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Profiler } from 'react'
import { Button } from '@astryxdesign/core/Button'
import { IconButton } from '@astryxdesign/core/IconButton'
import {
  ChatComposerInput,
  type ChatComposerInputHandle,
  type ChatComposerTrigger
} from '@astryxdesign/core/Chat'
import { useChatStore } from '../../stores/useChatStore'
import { useAgentStore } from '../../stores/useAgentStore'
import {
  arePendingPlanReviewsEqual,
  selectPendingPlanReview,
  selectSessionSnapshot,
  selectSessionIsRunning,
  getRunInterruptionNotice,
  useRunStore
} from '../../stores/useRunStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import { selectSupportsVisionFromConfig } from '../../stores/selectors'
import {
  SendIcon,
  StopIcon,
  NovaLogo,
  ChevronIcon,
  CloseIcon
} from '../../components/Icons'
import { VirtualMessageList } from './VirtualMessageList'
import { preSendGate } from './sendOrchestration'
import { ModeSwitch } from '../mode-switch/ModeSwitch'
import { PermissionModeButton } from '../permissions/PermissionModeButton'
import { ModelSelector } from './ModelSelector'
import { ReasoningEffortControl } from './ReasoningEffortControl'
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  browserFrameScheduler,
  canFollowAutoScroll,
  createStreamAutoScrollController,
  createStreamingScrollPoller,
  getDistanceFromBottom,
  isWithinProgrammaticScrollGuard,
  isWithinUserScrollCooldown,
  isWithinUserToggleAnchor,
  markProgrammaticScroll,
  markUserScrollInput,
  markUserToggle,
  scrollContainerToBottom,
  shouldShowScrollToBottom,
  syncAutoScrollModeOnScroll,
  type AutoScrollMode,
  type UserToggleAnchor
} from './autoScroll'
import { recordStreamingReactCommit, isStreamingPerfEnabled } from '../../lib/streamingPerf'
import { ContextIndicator } from './ContextIndicator'
import { CodeIndexStatusChip } from './CodeIndexStatusChip'
import { ComposerContextBar } from '../composer-context/ComposerContextBar'
import { ImagePreviewBar } from '../../components/ImagePreviewBar'
import { AskQuestionPanel } from '../ask/AskQuestionPanel'
import { PlanApprovalCard } from './PlanApprovalCard'
import { AssistantPendingIndicator, describeRunPhase } from './AssistantPendingIndicator'
import { RecoveryBanner } from './RecoveryBanner'
import { ComposerNoticeBanner, type ComposerNotice } from './ComposerNoticeBanner'
import {
  fileToImageAttachment,
  getDroppedImageFiles,
  getDroppedNonImageFiles,
  MAX_IMAGE_COUNT,
  type ImageAttachment
} from '../../lib/image-attachments'
import { createComposerSkillTrigger, skillComposerToken } from '../skills/composerSkillTrigger'
import { createComposerFileTrigger } from './composerFileTrigger'
import { useTriggerMenuGeometry } from './useTriggerMenuGeometry'
import { revealCaretInScroller } from './composerCaret'
import { useImeEnterGuard } from './imeEnterGuard'
import { useSkillsStore } from '../skills/store'
import { WelcomeHero } from './WelcomeHero'
import { ChatContentWidthHandle } from './ChatContentWidthHandle'
import './composerShell.css'
import './ChatPanel.css'
const SubagentSessionHeader = lazy(() => import('../subagents/SubagentSessionHeader').then(m => ({ default: m.SubagentSessionHeader })))
import { retainDevComposerDrafts, useDevComposerDraft, useDevComposerAttachments } from './devComposerDraft'
import { useLearningStore } from '../learning/useLearningStore'
import { switchToLearningSurface } from '../learning/learningSurfaceSwitch'

/** ChatPanel — 主聊天控制面板 */

/**
 * 仅在开发环境用 React.Profiler 包裹 children；生产环境直接透传 children，
 * 避免生产包携带 Profiler 的插桩开销（onRender 回调、commit 计时）。
 */
const MaybeProfiler: React.FC<{
  enabled: boolean
  id: string
  onRender: React.ProfilerOnRenderCallback
  children: React.ReactNode
}> = ({ enabled, id, onRender, children }) => {
  if (!enabled) return <>{children}</>
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  )
}


const ImagePreviewDialog = lazy(() =>
  import('../../components/ImagePreviewDialog').then(m => ({ default: m.ImagePreviewDialog }))
)

/** 距列表顶部小于此像素时触发向更早方向补载历史 */
const HISTORY_LOAD_SCROLL_THRESHOLD_PX = 80

/** 记住阅读位置的会话数上限 */
const MAX_REMEMBERED_SCROLL_POSITIONS = 50

export const ChatPanel: React.FC = () => {
  const rootRef = useRef<HTMLDivElement | null>(null)
  // ── settings store（项目/模型/模式/配置弹窗） ──
  const currentProject = useSettingsStore(state => state.currentProject)
  const modelConfig = useSettingsStore(state => state.modelConfig)
  const currentMode = useSettingsStore(state => state.currentMode)
  const selectProject = useSettingsStore(state => state.selectProject)
  const composerPrefill = useSettingsStore(state => state.composerPrefill)
  const clearComposerPrefill = useSettingsStore(state => state.clearComposerPrefill)
  const openMemorySettings = useSettingsStore(state => state.openMemorySettings)
  const isSessionLoading = useWorkspaceStore(state => state.isSessionLoading)
  const setPermissionMode = useWorkspaceStore(state => state.setPermissionMode)

  // Vision 门控：当前模型是否支持图片输入
  const supportsVision = selectSupportsVisionFromConfig(modelConfig)

  // ── chat store（消息/会话/diff/流式） ──
  const messages = useChatStore(state => state.messages)
  const sendInFlight = useChatStore(state => state.sendInFlight)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const runtimeRunning = useRunStore(state => selectSessionIsRunning(state, currentSessionId))
  const isGenerating = runtimeRunning || sendInFlight
  const currentSubagentTask = useChatStore(state => state.currentSubagentTask)
  const currentSession = useChatStore(state =>
    state.sessions.find((session) => session.id === state.currentSessionId)
  )
  const currentGeneratingMessageId = useChatStore(state => state.currentGeneratingMessageId)
  const [dismissedMemoryNotices, setDismissedMemoryNotices] = useState<ReadonlySet<string>>(() => new Set())
  const memoryCount = (currentSession?.memorySnapshot?.globalCoreCount ?? 0) + (currentSession?.memorySnapshot?.projectCoreCount ?? 0)
  const memoryNoticeKey = `${currentSessionId}:${currentSession?.memorySnapshot?.capturedAt}`
  const showMemoryNotice = !isSessionLoading && currentSession?.kind === 'primary' && currentSession.mode !== 'learn'
    && !currentSession.memoryOptOut && memoryCount > 0 && !dismissedMemoryNotices.has(memoryNoticeKey)
  const sendMessage = useChatStore(state => state.sendMessage)
  const regenerateAssistant = useChatStore(state => state.regenerateAssistant)
  const switchBranch = useChatStore(state => state.switchBranch)
  const editResend = useChatStore(state => state.editResend)
  const rollbackErrors = useChatStore(state => state.rollbackErrors)
  // Steering Queue
  const pendingUserMessages = useChatStore(state => state.pendingUserMessages)
  const enqueuePendingMessage = useChatStore(state => state.enqueuePendingMessage)
  const removePendingMessage = useChatStore(state => state.removePendingMessage)
  const hasMoreMessagesAbove = useChatStore(state => state.hasMoreMessagesAbove)
  const isLoadingOlderMessages = useChatStore(state => state.isLoadingOlderMessages)
  const loadOlderMessages = useChatStore(state => state.loadOlderMessages)
  const tier1BranchContext = useChatStore(state => state.tier1BranchContext)
  const dismissTier1BranchNotice = useChatStore(state => state.dismissTier1BranchNotice)

  // ── agent store（权限/取消/验证权限/askQuestion） ──
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const cancelling = useRunStore(state => state.cancelling)
  const cancellingSessionId = useRunStore(state => state.cancellingSessionId)
  const cancelGraceExceeded = useRunStore(state => state.cancelGraceExceeded)
  const forceTerminate = useRunStore(state => state.forceTerminate)
  const cancelError = useRunStore(state =>
    state.cancelError && (state.cancelError.sessionId == null || state.cancelError.sessionId === currentSessionId)
      ? state.cancelError.message
      : null
  )
  const dismissCancelError = useRunStore(state => state.dismissCancelError)
  const interruptionNotice = useRunStore(state =>
    state.snapshot?.sessionId === currentSessionId ? getRunInterruptionNotice(state.snapshot) : null
  )
  const runPhaseLabel = useRunStore(state =>
    describeRunPhase(selectSessionSnapshot(state, currentSessionId))
  )
  const pendingPlanReview = useRunStore(
    state => selectPendingPlanReview(state.snapshot),
    arePendingPlanReviewsEqual
  )
  const pendingPermissionRequest = useAgentStore(state => state.pendingPermissionRequest)
  const pendingAskQuestion = useAgentStore(state => state.pendingAskQuestion)
  const dismissAskQuestion = useAgentStore(state => state.dismissAskQuestion)

  const isPausedForUserInput =
    !!pendingAskQuestion ||
    !!pendingPermissionRequest ||
    !!pendingPlanReview
  const pausedMessageId =
    pendingPlanReview?.messageId ?? pendingPermissionRequest?.messageId ?? currentGeneratingMessageId
  // 审批 dock 只服务当前会话的 review：快照归属其他会话时不替换输入区
  const planReviewForCurrentSession =
    pendingPlanReview && pendingPlanReview.sessionId === currentSessionId ? pendingPlanReview : null

  // 取消/中断都归属发起会话：其他会话的视图不呈现、不操作（归属未知时按旧语义放行当前会话）
  const cancellingForCurrentSession =
    cancelling && (cancellingSessionId == null || cancellingSessionId === currentSessionId)
  const graceExceededForCurrentSession = cancelGraceExceeded && cancellingForCurrentSession
  const currentGeneratingTurnStartedAt = useMemo(() => {
    if (!currentGeneratingMessageId) return undefined
    const generatingMsg = messages.find(m => m.id === currentGeneratingMessageId)
    return generatingMsg?.turnStartedAt ?? generatingMsg?.timestamp
  }, [messages, currentGeneratingMessageId])

  const handleRegenerate = useCallback(async (messageId: string) => {
    if (!currentSessionId) return
    await regenerateAssistant(currentSessionId, messageId)
  }, [currentSessionId, regenerateAssistant])

  const handleSwitchBranch = useCallback(async (targetMessageId: string) => {
    if (!currentSessionId) return
    await switchBranch(currentSessionId, targetMessageId)
  }, [currentSessionId, switchBranch])

  // 编辑用户消息并重发（分叉保留旧分支，走 workspace:edit-resend + 普通 sendMessage）
  const handleEditResend = useCallback(async (messageId: string, newContent: string) => {
    if (!currentSessionId) return
    await editResend(currentSessionId, messageId, newContent)
  }, [currentSessionId, editResend])

  // 草稿按会话暂存：切会话、切学习表面再返回时各自原文可用
  const chatSessions = useChatStore(state => state.sessions)
  const [inputVal, setInputVal] = useDevComposerDraft(currentSessionId)
  // 会话删除或工作区切换后清掉已不存在会话的草稿；
  // 空列表是 hydration 前状态，跳过以免把全部草稿误清
  useEffect(() => {
    if (chatSessions.length > 0) {
      retainDevComposerDrafts(chatSessions.map(session => session.id))
    }
  }, [chatSessions])
  /** 用户上滚离开底部时显示「回到底部」 */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const slashSkills = useSkillsStore(state => state.skills)
  const skillsDiagnostics = useSkillsStore(state => state.diagnostics)
  const refreshSkills = useSkillsStore(state => state.refresh)
  const setSnapshot = useSkillsStore(state => state.setSnapshot)
  const composerInputHandleRef = useRef<ChatComposerInputHandle>(null)
  const composerFocusVersion = useWorkspaceStore(state => state.composerFocusVersion)
  useEffect(() => {
    composerInputHandleRef.current?.focus()
  }, [currentSessionId, composerFocusVersion])
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const composerStackRef = useRef<HTMLDivElement>(null)
  const composerStackTopRef = useRef<number | null>(null)
  const composerMotionRef = useRef<Animation | null>(null)
  const imeEnterGuard = useImeEnterGuard()
  const slashSkillsRef = useRef(slashSkills)
  slashSkillsRef.current = slashSkills
  const skillsDiagnosticsRef = useRef(skillsDiagnostics)
  skillsDiagnosticsRef.current = skillsDiagnostics

  // `/`、`@` 菜单钉在 composer 盒上沿并等宽，几何由盒上 CSS 变量驱动
  useTriggerMenuGeometry(composerBoxRef)

  // 命令不依赖技能目录；trigger 保持稳定，打开菜单时读取最新技能。
  const skillTrigger = useMemo(
    () => createComposerSkillTrigger(() => slashSkillsRef.current, {
      emptySearchResultsText: '没有匹配的技能或命令',
      getDiagnostics: () => skillsDiagnosticsRef.current
    }),
    []
  )
  const fileTrigger = useMemo(
    () => createComposerFileTrigger(() => currentProject),
    [currentProject]
  )
  const composerTriggers = useMemo<ChatComposerTrigger[]>(
    () => [skillTrigger, fileTrigger],
    [skillTrigger, fileTrigger]
  )

  // 技能目录随工作区切换由主进程对齐并推送 skill:changed，这里只拉首帧并订阅
  useEffect(() => {
    void refreshSkills()
    const unsub = window.nova.skill.onChange(snapshot => setSnapshot(snapshot))
    return unsub
  }, [refreshSkills, setSnapshot])

  // 设置页「使用技能」预填 composer：纯 slash 插入芯片，其余仍写明文
  useEffect(() => {
    if (!composerPrefill) return
    const text = composerPrefill
    clearComposerPrefill()
    const slash = /^\/(\S+)\s*$/.exec(text.trim())
    if (slash?.[1]) {
      setInputVal('')
      requestAnimationFrame(() => {
        const handle = composerInputHandleRef.current
        handle?.focus()
        handle?.insertToken(skillComposerToken(slash[1]))
      })
      return
    }
    // 已有未发送草稿时不覆盖：预填内容追加其后，用户输入不丢
    setInputVal(current => current.trim() ? `${current}\n${text}` : text)
    requestAnimationFrame(() => {
      composerInputHandleRef.current?.focus()
    })
  }, [composerPrefill, clearComposerPrefill])

  useEffect(() => {
    scrollHeightBeforePrependRef.current = null
  }, [currentSessionId])

  /** 可变滚动容器引用（callback ref 写入；不用 RefObject 以免 current 只读） */
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)
  /** 供虚拟列表订阅的滚动节点（callback ref 写入，触发一次重渲染） */
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const bindScrollContainer = useCallback((node: HTMLDivElement | null) => {
    scrollContainerRef.current = node
    setScrollElement(node)
  }, [])
  /** 自动滚动模式：off=用户上滚远离底部；stream=流式跟随；user=用户点击回底 */
  const autoScrollModeRef = useRef<AutoScrollMode>('off')
  /**
   * 各会话的阅读位置：切走时记下，切回时恢复；离开时停在底部的会话回到底部继续跟随。
   * 只在本组件生命周期内有效，上限防止长时间使用后无限增长。
   */
  const scrollPositionsRef = useRef(new Map<string, { top: number; atBottom: boolean }>())
  const scrollSessionIdRef = useRef(currentSessionId)
  scrollSessionIdRef.current = currentSessionId
  /** 程序滚动保护截止时间戳 */
  const programmaticScrollUntilRef = useRef(0)
  /** 用户主动滚轮/触摸输入后的 150ms 防抢夺冷却时间戳 */
  const userScrollCooldownUntilRef = useRef(0)
  /** 用户刚点过的展开/收起控件所在的消息行：窗口内不补偿该行高度变化、不跟随到底部 */
  const userToggleAnchorRef = useRef<UserToggleAnchor>({ rowIndex: null, until: 0 })
  const lastScrollTopRef = useRef(0)

  /** prepend 历史消息前记录的 scrollHeight，用于补载后修正 scrollTop 防止视口跳动 */
  const scrollHeightBeforePrependRef = useRef<number | null>(null)
  // 生成阶段 rAF 合并滚动（render-pool tick 补充路径）
  const streamAutoScrollRef = useRef<ReturnType<typeof createStreamAutoScrollController> | null>(null)
  const streamScrollPollerRef = useRef<ReturnType<typeof createStreamingScrollPoller> | null>(null)

  // 图片附件状态
  const [imageAttachments, setImageAttachments] = useDevComposerAttachments(currentSessionId)
  const [isDragOver, setIsDragOver] = useState(false)
  const [composerNotice, setComposerNotice] = useState<ComposerNotice | null>(null)
  const composerNoticeTimerRef = useRef<number | null>(null)

  const dismissComposerNotice = useCallback(() => {
    if (composerNoticeTimerRef.current !== null) {
      window.clearTimeout(composerNoticeTimerRef.current)
      composerNoticeTimerRef.current = null
    }
    setComposerNotice(null)
  }, [])

  useEffect(() => {
    return () => {
      if (composerNoticeTimerRef.current !== null) {
        window.clearTimeout(composerNoticeTimerRef.current)
      }
    }
  }, [])
  // 全屏预览状态
  const [previewDialog, setPreviewDialog] = useState<{
    open: boolean
    images: { dataUrl: string; fileName: string }[]
    index: number
    originEl?: HTMLElement | null
  }>({
    open: false,
    images: [],
    index: 0,
    originEl: null
  })
  // 隐藏的文件上传 input
  const fileInputRef = useRef<HTMLInputElement>(null)

  const canAutoScroll = useCallback(() => {
    if (isWithinUserScrollCooldown(userScrollCooldownUntilRef.current)) {
      return false
    }
    if (isWithinUserToggleAnchor(userToggleAnchorRef.current)) {
      return false
    }
    return canFollowAutoScroll(autoScrollModeRef.current)
  }, [])

  const shouldHoldScrollAnchor = useCallback(
    (rowIndex: number) => isWithinUserToggleAnchor(userToggleAnchorRef.current, rowIndex),
    []
  )

  // 点击展开/收起控件：标题要留在原位，不能被虚拟列表的高度补偿或自动跟随带走。
  // 捕获阶段早于控件自己的处理器；此刻 aria-expanded 仍是点击前的值。
  const handleToggleCapture = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null
    const toggle = target?.closest('[aria-expanded]')
    if (!toggle) return
    const row = toggle.closest('[data-index]')
    const rowIndex = row instanceof HTMLElement ? Number(row.dataset.index) : Number.NaN
    markUserToggle(userToggleAnchorRef, Number.isNaN(rowIndex) ? null : rowIndex)
    // 展开会让内容变长，若仍在跟随底部，标题会被推出视口
    if (toggle.getAttribute('aria-expanded') === 'false') {
      autoScrollModeRef.current = 'off'
    }
  }, [])

  // 对滚动容器滚到底（scrollTo，避免 scrollIntoView 强制同步布局整棵消息树）
  const scrollToBottomInstant = useCallback((behavior: ScrollBehavior = 'auto') => {
    const container = scrollContainerRef.current
    if (!container) return
    markProgrammaticScroll(programmaticScrollUntilRef)
    scrollContainerToBottom(container, behavior)
  }, [])

  const syncBottomState = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container) return

    const metrics = {
      scrollHeight: container.scrollHeight,
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight
    }
    const isProgrammatic = isWithinProgrammaticScrollGuard(programmaticScrollUntilRef.current)
    const isCoolingDown = isWithinUserScrollCooldown(userScrollCooldownUntilRef.current)
    autoScrollModeRef.current = syncAutoScrollModeOnScroll({
      metrics,
      previousScrollTop: lastScrollTopRef.current,
      autoScrollMode: autoScrollModeRef.current,
      isOutputting: isGenerating,
      isProgrammaticScroll: isProgrammatic,
      isWithinUserCooldown: isCoolingDown
    })
    lastScrollTopRef.current = container.scrollTop
    // 显隐只看距底部距离，与 autoScrollMode 解耦
    setShowScrollToBottom(shouldShowScrollToBottom(metrics))
    const sessionId = scrollSessionIdRef.current
    if (sessionId) {
      const positions = scrollPositionsRef.current
      positions.delete(sessionId)
      positions.set(sessionId, {
        top: container.scrollTop,
        atBottom: getDistanceFromBottom(metrics) <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX
      })
      if (positions.size > MAX_REMEMBERED_SCROLL_POSITIONS) {
        positions.delete(positions.keys().next().value!)
      }
    }
  }, [isGenerating])

  const handleScrollToBottomClick = useCallback(() => {
    userScrollCooldownUntilRef.current = 0
    autoScrollModeRef.current = 'user'
    setShowScrollToBottom(false)
    scrollToBottomInstant('smooth')
  }, [scrollToBottomInstant])

  // 会话就绪后恢复阅读位置；首次打开或离开时在底部的会话落到底部并继续跟随
  useLayoutEffect(() => {
    const container = scrollElement
    if (!container || isSessionLoading || !currentSessionId) return
    const saved = scrollPositionsRef.current.get(currentSessionId)
    if (saved && !saved.atBottom) {
      autoScrollModeRef.current = 'off'
      const restore = (): void => {
        markProgrammaticScroll(programmaticScrollUntilRef)
        container.scrollTop = saved.top
      }
      restore()
      // 虚拟列表首轮测量会改变总高度，下一帧再校正一次
      const frame = requestAnimationFrame(restore)
      return () => cancelAnimationFrame(frame)
    }
    autoScrollModeRef.current = 'user'
    markProgrammaticScroll(programmaticScrollUntilRef)
    container.scrollTop = container.scrollHeight
    return undefined
  }, [currentSessionId, isSessionLoading, scrollElement])

  const tryLoadOlderMessages = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || !hasMoreMessagesAbove || isLoadingOlderMessages) return
    if (container.scrollTop > HISTORY_LOAD_SCROLL_THRESHOLD_PX) return

    scrollHeightBeforePrependRef.current = container.scrollHeight
    void loadOlderMessages()
  }, [hasMoreMessagesAbove, isLoadingOlderMessages, loadOlderMessages])

  const messagesContentRef = useRef<HTMLDivElement | null>(null)

  const followBottomInstant = useCallback(() => {
    const container = scrollContainerRef.current
    if (
      !container ||
      autoScrollModeRef.current === 'off' ||
      isWithinUserScrollCooldown(userScrollCooldownUntilRef.current) ||
      isWithinUserToggleAnchor(userToggleAnchorRef.current)
    ) {
      return
    }
    markProgrammaticScroll(programmaticScrollUntilRef)
    scrollContainerToBottom(container)
  }, [])

  const followRef = useRef(followBottomInstant)
  followRef.current = followBottomInstant

  useEffect(() => {
    const content = messagesContentRef.current
    if (!content || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      followRef.current?.()
    })
    observer.observe(content)
    return () => {
      observer.disconnect()
    }
  }, [scrollElement])

  useLayoutEffect(() => {
    followRef.current?.()
  }, [messages, isGenerating])

  useEffect(() => {
    const controller = createStreamAutoScrollController(
      () => scrollToBottomInstant(),
      () => !canAutoScroll(),
      browserFrameScheduler
    )
    streamAutoScrollRef.current = controller

    const poller = createStreamingScrollPoller({
      shouldPoll: () => isGenerating && !pendingAskQuestion,
      shouldScroll: () => canAutoScroll(),
      scrollToBottom: () => scrollToBottomInstant()
    })
    streamScrollPollerRef.current = poller

    return () => {
      controller.cancel()
      streamAutoScrollRef.current = null
      poller.stop()
      streamScrollPollerRef.current = null
    }
  }, [scrollToBottomInstant, canAutoScroll, isGenerating, pendingAskQuestion])

  const handleScroll = useCallback(() => {
    syncBottomState()
    tryLoadOlderMessages()
  }, [syncBottomState, tryLoadOlderMessages])

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (event.deltaY < 0) {
      markUserScrollInput(userScrollCooldownUntilRef)
      if (autoScrollModeRef.current === 'stream' || autoScrollModeRef.current === 'user') {
        autoScrollModeRef.current = 'off'
      }
    }
  }, [])

  // prepend 早期消息后按高度差修正 scrollTop（overflow-anchor:none 下需手动锚定）
  useLayoutEffect(() => {
    const container = scrollContainerRef.current
    const prevHeight = scrollHeightBeforePrependRef.current
    if (!container || prevHeight === null || isLoadingOlderMessages) return

    const delta = container.scrollHeight - prevHeight
    if (delta > 0) {
      container.scrollTop += delta
    }
    scrollHeightBeforePrependRef.current = null
  }, [messages, isLoadingOlderMessages])

  // 新消息加入时滚到底，但尊重用户上滚：
  // mode === 'off'（用户已主动上滚离开底部）时不打断他阅读历史。
  // 用户「主动发送」的场景由 handleSend 先把模式置回 stream，故仍会跟随。
  useEffect(() => {
    if (autoScrollModeRef.current === 'off') return
    scrollToBottomInstant()
  }, [messages.length, scrollToBottomInstant])

  // 流式输出且未等待 askQuestion → stream 模式 + 启动轮询；否则停轮询。
  //
  // 关键：依赖必须包含 pendingAskQuestion。创建 poller 的 effect 依赖
  // [isGenerating, pendingAskQuestion]，会在 askQuestion 答完（pendingAskQuestion
  // 由 true→false）时重建出一个「停止态」的新 poller；本 effect 若只依赖 isGenerating
  // 就不会重跑、不会 start()，导致 500ms 轮询永久失效（bash 撑高列表不再跟随底部）。
  // 把 pendingAskQuestion 一并纳入依赖后，重建（effect 顺序在前）→ 重启（本 effect 在后）
  // 时序正确闭合。
  useEffect(() => {
    if (isGenerating && !pendingAskQuestion) {
      autoScrollModeRef.current = 'stream'
      streamScrollPollerRef.current?.start()
    } else {
      // 等待 askQuestion 期间只停轮询、不动模式，答完后上面分支能重新进入 stream。
      // 轮次真正结束时按当前距底决定 mode，并同步按钮显隐（避免等下一次 scroll）。
      if (!isGenerating) {
        const container = scrollContainerRef.current
        if (container) {
          const metrics = {
            scrollHeight: container.scrollHeight,
            scrollTop: container.scrollTop,
            clientHeight: container.clientHeight
          }
          const atBottom =
            getDistanceFromBottom(metrics) <= AUTO_SCROLL_BOTTOM_THRESHOLD_PX
          autoScrollModeRef.current = atBottom ? 'user' : 'off'
          setShowScrollToBottom(shouldShowScrollToBottom(metrics))
        } else {
          autoScrollModeRef.current = 'off'
        }
      }
      streamScrollPollerRef.current?.stop()
      streamAutoScrollRef.current?.cancel()
    }
  }, [isGenerating, pendingAskQuestion])

  // render-pool tick 补充：打字机放出字符时 rAF 合并滚一次（轮询覆盖 bash 撑高场景）
  const scheduleStreamAutoScroll = useCallback(() => {
    streamAutoScrollRef.current?.schedule()
  }, [])

  const handleChatProfilerRender = useCallback(
    (
      _id: string,
      phase: 'mount' | 'update' | 'nested-update',
      actualDuration: number
    ) => {
      if (phase === 'mount' || phase === 'update') {
        recordStreamingReactCommit(actualDuration, { phase, id: _id })
      }
    },
    []
  )

  // 处理受控输入；行高由 ChatComposerInput maxRows 拥有，不再手调 textarea 高度
  const handleInputChange = (nextValue: string) => {
    setInputVal(nextValue)
  }

  // 「学懂这次改动」：绑定到确实改过代码的那条回复；改动文件由主进程从该消息推导
  const handleLearnChange = useCallback(async (messageId: string) => {
    const devSessionId = useWorkspaceStore.getState().currentSessionId
    if (!devSessionId) return
    await switchToLearningSurface()
    const learnSessionId = useWorkspaceStore.getState().currentSessionId
    if (!learnSessionId || learnSessionId === devSessionId) return
    await useLearningStore.getState().sendCommand({
      sessionId: learnSessionId,
      action: { type: 'explain_change', devSessionId, devMessageId: messageId }
    })
  }, [])

  /** 非阻塞内联提示：在输入框上方展示并在 3.2s 后自动消退 */
  const showToast = useCallback((message: string, tone: ComposerNotice['tone'] = 'warning') => {
    if (composerNoticeTimerRef.current !== null) {
      window.clearTimeout(composerNoticeTimerRef.current)
    }
    setComposerNotice({ message, tone })
    composerNoticeTimerRef.current = window.setTimeout(() => {
      composerNoticeTimerRef.current = null
      setComposerNotice(null)
    }, 3200)
  }, [])

  const handleSend = async () => {
    if (!inputVal.trim() && imageAttachments.length === 0) return
    if (!modelConfig) {
      showToast('请先在设置中配置 LLM 服务商与模型！', 'warning')
      useSettingsStore.getState().openLlmSettings()
      return
    }
    if (!currentProject) {
      showToast('请先在左侧选择或新建一个项目工作区！', 'warning')
      selectProject()
      return
    }

    const text = inputVal.trim()
    const images = imageAttachments
    const sendingSessionId = useChatStore.getState().currentSessionId
    const shouldRestoreFocus = composerBoxRef.current?.contains(document.activeElement) ?? false
    const restoreComposerFocus = () => {
      if (!shouldRestoreFocus) return
      requestAnimationFrame(() => composerInputHandleRef.current?.focus())
    }
    const clearAcceptedDraft = () => {
      if (useChatStore.getState().currentSessionId !== sendingSessionId) return
      setInputVal(current => current === inputVal ? '' : current)
      setImageAttachments(current => current === images ? [] : current)
      restoreComposerFocus()
    }
    // 本地拒绝恢复草稿：只在输入框仍空时回填，避免覆盖用户新输入
    const restoreRejectedDraft = (rejectedText: string) => {
      if (useChatStore.getState().currentSessionId !== sendingSessionId) return
      setInputVal(current => current === '' ? rejectedText : current)
      setImageAttachments(current => current.length === 0 ? images : current)
      restoreComposerFocus()
    }

    // 用户主动发送：无论之前是否上滚离开底部，都恢复跟随，让用户看到自己刚发的消息。
    autoScrollModeRef.current = 'stream'

    // askQuestion 面板仍开着时用户发了新消息：先 dismiss 当前提问（resolve 空 answers），
    // 让旧轮次能正常走到 message_end。否则新消息只会进 steering 队列，而旧轮次被
    // 未 resolve 的 askQuestion 阻塞、永不到达 message_end → 互等死锁。
    await preSendGate({ hasPendingAskQuestion: !!pendingAskQuestion, dismissAskQuestion })

    // 提问答复可能已经使旧 run 进入终态，发送前重新读取权威快照。
    const latestSendState = useChatStore.getState()
    if (latestSendState.currentSessionId !== sendingSessionId) return
    const stillGenerating = selectSessionIsRunning(useRunStore.getState(), sendingSessionId) || latestSendState.sendInFlight

    // Steering Queue：Agent 正在运行时，新消息进入挂起队列，turn boundary 自动 dispatch
    if (stillGenerating) {
      enqueuePendingMessage(text, images)
      clearAcceptedDraft()
      return
    }

    // 旧轮次已结束（dismiss 后 message_end 先到）：直接发送，避免消息滞留队列。
    // sendMessage 返回 false 表示被守卫拦截（如分叉准备窗口、缺工作区），
    // 此时必须保留草稿，不能让用户刚输入的内容凭空消失。
    await sendMessage(text, images, { onAccepted: clearAcceptedDraft, onRejected: restoreRejectedDraft })
  }

  /**
   * Enter 由产品层拥有：ChatComposerInput 内置 onSubmit 会在调用后无条件清空编辑器，
   * 而 Nova 的发送可被编排忙/缺配置等路径拒绝且必须保留草稿，因此在 onKeyDown 里
   * preventDefault 后走 handleSend。
   */
  const handleComposerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (imeEnterGuard.interceptKeyDown(e)) return
    if (e.key !== 'Enter' || e.shiftKey || e.altKey) return
    // 菜单打开时不发送：高亮项的 Enter 交给官方 trigger；无高亮也不要把草稿当消息发出。
    if (e.currentTarget.getAttribute('aria-expanded') === 'true') {
      e.preventDefault()
      return
    }
    e.preventDefault()
    void handleSend()
  }

  const handleSlashButton = () => {
    requestAnimationFrame(() => {
      const handle = composerInputHandleRef.current
      const editable = composerBoxRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')
      if (!handle || !editable) return

      handle.focus()
      const currentValue = handle.getValue()
      const selection = window.getSelection()
      let range = selection && selection.rangeCount > 0 && editable.contains(selection.getRangeAt(0).startContainer)
        ? selection.getRangeAt(0)
        : null
      if (range && !range.collapsed) {
        range.collapse(false)
        selection?.removeAllRanges()
        selection?.addRange(range)
      }
      if (!range && selection) {
        range = document.createRange()
        range.selectNodeContents(editable)
        range.collapse(false)
        selection.removeAllRanges()
        selection.addRange(range)
      }

      const textBeforeCursor = range?.startContainer.nodeType === Node.TEXT_NODE
        ? (range.startContainer.textContent ?? '').slice(0, range.startOffset)
        : currentValue
      const hasActiveSlash = textBeforeCursor.endsWith('/') || /(?:^|\s)\/\S*$/.test(textBeforeCursor)
      const insertion = hasActiveSlash
        ? ''
        : currentValue.trim() === ''
        ? '/'
        : /\s$/.test(textBeforeCursor)
          ? '/'
          : ' /'
      // 走编辑器公开插入接口，再派发真实 input，让官方 trigger 复用键入 `/` 的菜单状态。
      if (insertion) {
        handle.insertText(insertion)
        // 公开接口把光标留在文本节点之后的元素偏移上，而 trigger 只识别文本节点内的光标。
        const caret = window.getSelection()?.rangeCount ? window.getSelection()?.getRangeAt(0) : null
        const inserted = caret?.startContainer.nodeType === Node.ELEMENT_NODE
          ? caret.startContainer.childNodes[caret.startOffset - 1]
          : null
        if (caret && inserted?.nodeType === Node.TEXT_NODE) {
          caret.setStart(inserted, (inserted.textContent ?? '').length)
          caret.collapse(true)
        }
      }
      editable.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  // ── 图片上传交互 ─────────────────────────────────────────

  /** 按钮上传：将有效图片加入附件列表，失败项逐条提示 */
  const addImageFiles = useCallback(async (files: File[]) => {
    const remainingSlots = MAX_IMAGE_COUNT - imageAttachments.length
    if (remainingSlots <= 0) {
      showToast('最多上传 10 张图片')
      return
    }

    // 无会话时不落盘（fileToImageAttachment 需 sessionId 决定落盘目录）
    if (!currentSessionId) {
      showToast('请先选择或创建会话')
      return
    }

    const toProcess = files.slice(0, remainingSlots)
    const results = await Promise.all(toProcess.map(f => fileToImageAttachment(f, currentSessionId)))

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
  }, [imageAttachments.length, showToast, currentSessionId])

  /** 文件 input onChange */
  const handleFileInputChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!supportsVision) return
    const files = Array.from(e.target.files ?? [])
    if (files.length === 0) return
    await addImageFiles(files)
    e.target.value = '' // 允许重复选择相同文件
  }, [supportsVision, addImageFiles])

  /** ChatComposerInput onFiles：粘贴/拖入文件时只收图片附件 */
  const handleComposerFiles = useCallback((files: File[]) => {
    if (!supportsVision) return
    const imageFiles = files.filter(f => f.type.startsWith('image/'))
    if (imageFiles.length > 0) {
      void addImageFiles(imageFiles)
    }
  }, [supportsVision, addImageFiles])

  /** 输入框手动插入粘贴文本，浏览器不会自动跟随插入点；插入后补一次，返回 false 仍由输入框插入 */
  const handleComposerPaste = useCallback((): boolean => {
    requestAnimationFrame(() => revealCaretInScroller(window.getSelection()))
    return false
  }, [])

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
      requestAnimationFrame(() => {
        composerInputHandleRef.current?.focus()
      })
    }
  }, [supportsVision, addImageFiles])

  /** 点击预览条缩略图打开全屏 */
  const openPreviewFromBar = useCallback((index: number, originEl?: HTMLElement | null) => {
    setPreviewDialog({
      open: true,
      images: imageAttachments.map(a => ({ dataUrl: a.dataUrl, fileName: a.fileName })),
      index,
      originEl: originEl ?? null
    })
  }, [imageAttachments])

  /** 移除附件 */
  const removeAttachment = useCallback((id: string) => {
    setImageAttachments(prev => prev.filter(a => a.id !== id))
  }, [])

  // ── 空状态引导界面 ─────────────────────────────────────────
  const isEmptyState = messages.length === 0 && !isSessionLoading

  useLayoutEffect(() => {
    const stack = composerStackRef.current
    if (!stack) {
      composerStackTopRef.current = null
      return
    }
    const nextTop = stack.getBoundingClientRect().top
    const previousTop = composerStackTopRef.current
    composerStackTopRef.current = nextTop
    composerMotionRef.current?.cancel()
    composerMotionRef.current = null
    if (previousTop === null || isSessionLoading || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const deltaY = previousTop - nextTop
    if (Math.abs(deltaY) < 2) return
    const animation = stack.animate(
      [{ transform: `translateY(${deltaY}px)` }, { transform: 'translateY(0)' }],
      { duration: 260, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' }
    )
    composerMotionRef.current = animation
    animation.onfinish = () => {
      if (composerMotionRef.current === animation) composerMotionRef.current = null
    }
  }, [isEmptyState, isSessionLoading])

  useEffect(() => () => composerMotionRef.current?.cancel(), [])

  // ── 聊天消息渲染界面 ────────────────────────────────────────
  return (
    <div
      ref={rootRef}
      className="chat-panel relative flex flex-col h-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {currentSession?.kind === 'subagent' ? (
        <Suspense fallback={null}><SubagentSessionHeader originalTask={currentSubagentTask} /></Suspense>
      ) : null}
      {/* 拖拽高亮遮罩 */}
      {isDragOver && (
        <div className="chat-panel__drag-overlay">
          <span>拖拽图片到此处上传</span>
        </div>
      )}

      {/* 会话切换加载中等待状态 */}
      {isSessionLoading ? (
        <div className="chat-session-loading" role="status" aria-live="polite">
          <div className="chat-session-loading__spinner" aria-hidden="true" />
          <span className="chat-session-loading__text">加载中...</span>
        </div>
      ) : !isEmptyState ? (
        <div
          className="chat-messages flex-1 overflow-y-auto"
          ref={bindScrollContainer}
          onScroll={handleScroll}
          onWheel={handleWheel}
          onClickCapture={handleToggleCapture}
          style={{ overflowAnchor: 'none' }}
        >
          {showMemoryNotice && (
            <div className="chat-tier1-notice" role="status">
              <Button label={`已加载 ${memoryCount} 条记忆`} variant="ghost" size="sm" onClick={openMemorySettings} />
              <IconButton className="chat-tier1-notice__dismiss" label="关闭记忆提示" icon={<span aria-hidden="true">×</span>}
                variant="ghost" size="sm" onClick={() => setDismissedMemoryNotices(previous => new Set([...previous, memoryNoticeKey]))} />
            </div>
          )}
          {tier1BranchContext && (
            <div className="chat-tier1-notice" role="status">
              <span className="chat-tier1-notice__text">
                已切换到分支 {tier1BranchContext.branchIndex}/{tier1BranchContext.branchTotal}
                {tier1BranchContext.partialReplay
                  ? '（部分文件改动因缺少 forward 快照未能重放）'
                  : '（仅对话历史，工作区停在分叉点状态）'}
              </span>
              <IconButton
                label="关闭提示"
                icon={<span aria-hidden="true">×</span>}
                variant="ghost"
                size="sm"
                className="chat-tier1-notice__dismiss"
                onClick={dismissTier1BranchNotice}
              />
            </div>
          )}

          {(isLoadingOlderMessages || hasMoreMessagesAbove) && (
            <div className="chat-messages__history-hint" aria-live="polite">
              {isLoadingOlderMessages ? '正在加载更早的消息…' : '向上滚动加载更早的消息'}
            </div>
          )}

        <MaybeProfiler enabled={isStreamingPerfEnabled()} id="ChatPanel-messages" onRender={handleChatProfilerRender}>
        <div ref={messagesContentRef} className="chat-messages__flow-inner">
        <VirtualMessageList
          messages={messages}
          scrollElement={scrollElement}
          isGenerating={isGenerating}
          currentGeneratingMessageId={currentGeneratingMessageId}
          currentMode={currentMode}
          currentSessionId={currentSessionId}
          onRegenerate={handleRegenerate}
          onSwitchBranch={handleSwitchBranch}
          onEditResend={handleEditResend}
          rollbackErrors={rollbackErrors}
          onRenderPoolTick={scheduleStreamAutoScroll}
          shouldHoldScrollAnchor={shouldHoldScrollAnchor}
          isPausedForUserInput={isPausedForUserInput}
          pausedMessageId={pausedMessageId}
          pendingPlanReview={pendingPlanReview}
          onLearnChange={handleLearnChange}
        />

        {interruptionNotice && (
          <div className="chat-messages__interruption" role="status">
            {interruptionNotice}
          </div>
        )}

        {/* 流尾状态指示器：在 Agent 运行时稳稳挂在消息流最底部（零抖动） */}
        {isGenerating && !isPausedForUserInput && !cancellingForCurrentSession && (
          <div className="chat-messages__tail-status">
            <AssistantPendingIndicator turnStartedAt={currentGeneratingTurnStartedAt} label={runPhaseLabel} />
          </div>
        )}

        </div>
        </MaybeProfiler>
      </div>
      ) : null}

      {/* 底部输入框 / 空状态中央输入框 */}
      <div
        className={`chat-panel__composer-area ${
          isEmptyState ? 'chat-panel__composer-area--empty' : ''
        }`}
      >
        <div className="chat-panel__composer-inner">
          {/* 回到底部：悬浮小箭头；自有实心底保证叠在代码块上也清晰 */}

          {!isEmptyState && showScrollToBottom && (
            <button
              type="button"
              className="chat-scroll-to-bottom"
              aria-label="回到底部"
              onClick={handleScrollToBottomClick}
            >
              <ChevronIcon size={14} direction="down" />
            </button>
          )}

          {/* 停止请求本身失败：运行仍在继续，给出原因与重试入口 */}
          {cancelError && !cancellingForCurrentSession && (
            <div className="chat-cross-turn-notice" role="alert">
              <span className="chat-cross-turn-notice__text">{cancelError}</span>
              {isGenerating && (
                <Button
                  label="重试停止"
                  variant="secondary"
                  size="sm"
                  className="chat-cross-turn-notice__stop"
                  onClick={() => void cancelExecution()}
                />
              )}
              <IconButton
                label="关闭提示"
                icon={<CloseIcon size={12} />}
                variant="ghost"
                size="sm"
                onClick={dismissCancelError}
              />
            </div>
          )}

          {/* 取消 grace 超时：部分任务未退出 + 强制终止 */}
          {graceExceededForCurrentSession && (
            <div className="chat-cross-turn-notice" role="alert">
              <span className="chat-cross-turn-notice__text">
                {cancelError ?? '部分任务未退出'}
              </span>
              <Button
                label="强制终止"
                variant="destructive"
                size="sm"
                className="chat-cross-turn-notice__stop"
                onClick={() => void forceTerminate()}
              />
            </div>
          )}

          {/* askQuestion 工具发起的提问面板：pendingAskQuestion 为 null 时组件内自返回 null */}
          {pendingAskQuestion && (
            <div className="ask-question-dock">
              <AskQuestionPanel />
            </div>
          )}

          {/*
            composer 外层容器。
            历史上这里是 `motion.div layout`，但 framer-motion 的 layout 动画会在每次渲染时
            getBoundingClientRect 强制同步 flush 布局。ChatPanel 在 bash/流式期间因 store
            更新频繁重渲染，每次都会触发对上方巨大消息 DOM 的强制 layout + 投影 spring，
            导致合成循环（Recalculate style / Pre-paint / Layerize / Commit）持续打满、界面卡死。
            composer 不使用随渲染运行的 layout 动画，改为普通 div。
          */}
          <div
            className="w-full flex flex-col items-center pointer-events-none"
          >
            <ComposerNoticeBanner notice={composerNotice} onDismiss={dismissComposerNotice} />
            {/* Agent 恢复 / Hook 状态条：贴近输入框，对齐主流 Agent IDE 的 composer 状态区 */}
            <RecoveryBanner messageId={currentGeneratingMessageId} />

          {/* Steering Queue：排队消息吸附在 composer 上方，像一叠待发卡片 */}
          {pendingUserMessages.length > 0 && (
            <div className="w-full pointer-events-auto">
              <div className="steering-queue">
                <div className="steering-queue__header">
                  <span className="steering-queue__title">
                    已排队 {pendingUserMessages.length} 条消息
                  </span>
                  <span className="steering-queue__hint">
                    {isGenerating ? '本轮正常结束后发送' : '等待继续'}
                  </span>
                  {!isGenerating && !sendInFlight && (
                    <Button label="发送排队消息" variant="secondary" size="sm" onClick={() => void useChatStore.getState().sendNextPendingMessage()}>
                      发送排队消息
                    </Button>
                  )}
                </div>
                <div className="steering-queue__list">
                  {pendingUserMessages.map((msg, idx) => (
                    <div key={`pending-${idx}`} className="steering-queue__item">
                      <span className="steering-queue__index">{idx + 1}</span>
                      <span className="steering-queue__text">{msg.text || '(空文本)'}</span>
                      <IconButton
                        label="从队列移除"
                        icon={<span aria-hidden="true">×</span>}
                        variant="ghost"
                        size="sm"
                        className="steering-queue__remove"
                        onClick={() => removePendingMessage(idx)}
                      />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

            {isEmptyState && <WelcomeHero />}

            {/* Child Session 是 durable 执行记录；继续/恢复必须回到统一子代理执行服务。 */}
            {currentSession?.kind === 'subagent' ? (
              <div
                className="chat-subagent-note w-full px-4 py-3 text-sm"
                role="note"
              >
                子会话为只读执行记录。请从父会话的子任务行继续、授权或重试。
              </div>
            ) : planReviewForCurrentSession ? (
              /* 计划审批 dock：替换输入区（同 ZCode 形态），审批期间不再排队输入 */
              <div className="plan-approval-dock w-full">
                <PlanApprovalCard review={planReviewForCurrentSession} />
              </div>
            ) : (
              /* 输入栈仅在空态切换时做一次位置补间；上下文条垫在卡片正下方并与之连体 */
              <div ref={composerStackRef} className="chat-composer-stack w-full">
              <div
              ref={composerBoxRef}
              onCompositionEnd={imeEnterGuard.handleCompositionEnd}
              onKeyUp={imeEnterGuard.handleKeyUp}
              className={`chat-composer-box w-full flex flex-col p-3 ${
                isDragOver ? 'chat-composer-box--dragover' : ''
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

              <ChatComposerInput
                className="chat-composer__input"
                handleRef={composerInputHandleRef}
                label="消息输入"
                placeholder={pendingAskQuestion
                  ? '请先回答上方问题，再发送新消息（或输入排队）'
                  : isGenerating
                    ? 'Agent 正在运行，输入将进入排队队列...'
                    : '向 Nova 提问或分配编程任务...'}
                value={inputVal}
                onChange={handleInputChange}
                onKeyDown={handleComposerKeyDown}
                onFiles={handleComposerFiles}
                onPaste={handleComposerPaste}
                triggers={composerTriggers}
                // Nova 无跨会话持久化 prompt history；内置 hasHistory 是 per-mount 且不可清除。
                hasHistory={false}
                // 长文本保持明文粘贴，不转 token chip（与迁移前语义一致）。
                pasteAsToken={false}
                maxRows={14}
              />
              <div className="chat-composer__footer">
                <div className="chat-composer__footer-start">
                  <ModeSwitch
                    supportsVision={supportsVision}
                    onSelectImage={() => fileInputRef.current?.click()}
                    onSelectSkills={handleSlashButton}
                  />
                  {currentSession && (
                    <PermissionModeButton
                      permissionMode={currentSession.permissionMode}
                      isDisabled={isGenerating || sendInFlight || !!pendingPermissionRequest}
                      onChange={setPermissionMode}
                    />
                  )}
                  <CodeIndexStatusChip />
                </div>
                <div className="chat-composer__footer-end">
                  <ContextIndicator />
                  <ModelSelector />
                  <ReasoningEffortControl />
                  {isGenerating || sendInFlight || cancellingForCurrentSession ? (
                    <IconButton
                      label={cancellingForCurrentSession ? '正在停止' : '中断生成'}
                      icon={<StopIcon size={14} />}
                      variant="destructive"
                      size="md"
                      onClick={() => void cancelExecution()}
                      isDisabled={cancellingForCurrentSession && !cancelGraceExceeded}
                    />
                  ) : (
                    <IconButton
                      label="发送"
                      icon={<SendIcon size={14} />}
                      variant="primary"
                      size="md"
                      onClick={handleSend}
                      isDisabled={!inputVal.trim() && imageAttachments.length === 0}
                    />
                  )}
                </div>
              </div>
              </div>
              <ComposerContextBar />
              </div>
            )}

          </div>

        </div>
      </div>

      {/* 全屏图片预览 */}
      {(previewDialog.open || previewDialog.images.length > 0) && (
        <Suspense fallback={null}>
          <ImagePreviewDialog
            images={previewDialog.images}
            currentIndex={previewDialog.index}
            isOpen={previewDialog.open}
            originElement={previewDialog.originEl ?? null}
            onClose={() => setPreviewDialog(prev => ({ ...prev, open: false }))}
            onNavigate={(idx) => setPreviewDialog(prev => ({ ...prev, index: idx }))}
          />
        </Suspense>
      )}

      {/* 阅读区宽度手柄：贴阅读柱左缘的隐形热区，空会话（尚无消息）不挂载 */}
      <ChatContentWidthHandle enabled={!isEmptyState} />
    </div>
  )
}
