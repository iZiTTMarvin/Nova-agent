import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, Profiler } from 'react'
import { useChatStore } from '../../stores/useChatStore'
import { useAgentStore } from '../../stores/useAgentStore'
import { useRunStore } from '../../stores/useRunStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { selectSupportsVisionFromConfig } from '../../stores/selectors'
import { motion, AnimatePresence } from 'framer-motion'
import {
  SendIcon,
  StopIcon,
  NovaLogo,
  ImageIcon
} from '../../components/Icons'
import { VirtualMessageList } from './VirtualMessageList'
import { preSendGate } from './sendOrchestration'
import { ModeSwitch } from '../mode-switch/ModeSwitch'
import { ModelSelector } from './ModelSelector'
import {
  AUTO_SCROLL_BOTTOM_THRESHOLD_PX,
  browserFrameScheduler,
  canFollowAutoScroll,
  createStreamAutoScrollController,
  createStreamingScrollPoller,
  getDistanceFromBottom,
  isWithinProgrammaticScrollGuard,
  markProgrammaticScroll,
  scrollContainerToBottom,
  shouldShowScrollToBottom,
  syncAutoScrollModeOnScroll,
  type AutoScrollMode
} from './autoScroll'
import { recordStreamingReactCommit, isStreamingPerfEnabled } from '../../lib/streamingPerf'
import { ContextIndicator } from './ContextIndicator'
import { ImagePreviewBar } from '../../components/ImagePreviewBar'
import { TodoPanel } from '../todo/TodoPanel'
import { useTodoStore } from '../todo/useTodoStore'
import { AskQuestionPanel } from '../ask/AskQuestionPanel'
import { ComposeProgressPanel } from '../compose/ComposeProgressPanel'
import { ComposeAskUserPanel } from '../compose/ComposeAskUserPanel'
import { useComposeStore } from '../compose/useComposeStore'
import { RecoveryBanner } from './RecoveryBanner'
import { ImagePreviewDialog } from '../../components/ImagePreviewDialog'
import {
  fileToImageAttachment,
  getPastedImageFiles,
  getDroppedImageFiles,
  getDroppedNonImageFiles,
  MAX_IMAGE_COUNT,
  type ImageAttachment
} from '../../lib/image-attachments'
import { SkillAC, type SkillACHandle } from '../skills/SkillAC'
import { useSkillsStore } from '../skills/store'
import './ChatPanel.css'
import '../todo/TodoPanel.css'

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


/** 距列表顶部小于此像素时触发向更早方向补载历史 */
const HISTORY_LOAD_SCROLL_THRESHOLD_PX = 80

export const ChatPanel: React.FC = () => {
  // ── settings store（项目/模型/模式/配置弹窗） ──
  const currentProject = useSettingsStore(state => state.currentProject)
  const modelConfig = useSettingsStore(state => state.modelConfig)
  const currentMode = useSettingsStore(state => state.currentMode)
  const selectProject = useSettingsStore(state => state.selectProject)
  const composerPrefill = useSettingsStore(state => state.composerPrefill)
  const clearComposerPrefill = useSettingsStore(state => state.clearComposerPrefill)

  // Vision 门控：当前模型是否支持图片输入
  const supportsVision = selectSupportsVisionFromConfig(modelConfig)

  // ── chat store（消息/会话/diff/流式） ──
  const messages = useChatStore(state => state.messages)
  const isGenerating = useChatStore(state => state.isGenerating)
  const sendInFlight = useChatStore(state => state.sendInFlight)
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const currentGeneratingMessageId = useChatStore(state => state.currentGeneratingMessageId)
  const sendMessage = useChatStore(state => state.sendMessage)
  const regenerateAssistant = useChatStore(state => state.regenerateAssistant)
  const switchBranch = useChatStore(state => state.switchBranch)
  const editResend = useChatStore(state => state.editResend)
  const messageDiffs = useChatStore(state => state.messageDiffs)
  const loadingDiffs = useChatStore(state => state.loadingDiffs)
  const loadingDiffPlaceholders = useChatStore(state => state.loadingDiffPlaceholders)
  const rollbackErrors = useChatStore(state => state.rollbackErrors)
  const rejectFile = useChatStore(state => state.rejectFile)
  const acceptFile = useChatStore(state => state.acceptFile)
  const acceptAllFiles = useChatStore(state => state.acceptAllFiles)
  const rejectAllFiles = useChatStore(state => state.rejectAllFiles)
  const loadMessageDiffs = useChatStore(state => state.loadMessageDiffs)
  // Steering Queue
  const pendingUserMessages = useChatStore(state => state.pendingUserMessages)
  const enqueuePendingMessage = useChatStore(state => state.enqueuePendingMessage)
  const removePendingMessage = useChatStore(state => state.removePendingMessage)
  const hasMoreMessagesAbove = useChatStore(state => state.hasMoreMessagesAbove)
  const isLoadingOlderMessages = useChatStore(state => state.isLoadingOlderMessages)
  const loadOlderMessages = useChatStore(state => state.loadOlderMessages)
  const tier1BranchContext = useChatStore(state => state.tier1BranchContext)
  const dismissTier1BranchNotice = useChatStore(state => state.dismissTier1BranchNotice)
  const tier1StaleDiffSet = useMemo(
    () => new Set(tier1BranchContext?.staleDiffMessageIds ?? []),
    [tier1BranchContext]
  )

  // ── agent store（权限/取消/验证权限/askQuestion） ──
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const cancelling = useRunStore(state => state.cancelling)
  const cancelGraceExceeded = useRunStore(state => state.cancelGraceExceeded)
  const forceTerminate = useRunStore(state => state.forceTerminate)
  const interruptedRunId = useRunStore(state => state.interruptedRunId)
  const interruptedAction = useRunStore(state => state.interruptedAction)
  const clearInterrupted = useRunStore(state => state.clearInterrupted)
  const interruptedSteps = useRunStore(state => state.interruptedSteps)
  const mainTurnSessionId = useAgentStore(state => state.mainTurnSessionId)
  const pendingPermissionRequest = useAgentStore(state => state.pendingPermissionRequest)
  const pendingVerificationRequest = useAgentStore(state => state.pendingVerificationRequest)
  const respondVerificationPermission = useAgentStore(state => state.respondVerificationPermission)
  const pendingAskQuestion = useAgentStore(state => state.pendingAskQuestion)
  const dismissAskQuestion = useAgentStore(state => state.dismissAskQuestion)
  const pendingComposeAskUser = useComposeStore(state => state.pendingAskUser)
  const composeSessionId = useComposeStore(state => state.sessionId)
  const loadComposeState = useComposeStore(state => state.loadStateFromDisk)
  /** 编排面板/askUser 仅归属当前会话时渲染 */
  const composeBelongsToCurrent =
    !!currentSessionId && composeSessionId === currentSessionId
  const isPausedForUserInput =
    !!pendingAskQuestion ||
    !!pendingPermissionRequest ||
    !!pendingVerificationRequest ||
    (!!pendingComposeAskUser && composeBelongsToCurrent)
  const pausedMessageId = pendingPermissionRequest?.messageId ?? currentGeneratingMessageId

  // 跨会话运行提示：他会话在跑，或本会话失忆（切走再切回 isGenerating 未恢复）
  const showCrossSessionTurnBanner =
    !!mainTurnSessionId &&
    !!currentSessionId &&
    (mainTurnSessionId !== currentSessionId || !isGenerating)
  const crossSessionTurnIsOther =
    !!mainTurnSessionId && mainTurnSessionId !== currentSessionId

  // 新轮发起（isGenerating false→true）时清 turnTouched，避免 dock 秒弹上一轮残留 todo
  const prevGeneratingRef = useRef(isGenerating)
  useEffect(() => {
    if (!prevGeneratingRef.current && isGenerating && currentSessionId) {
      useTodoStore.getState().resetTurnTouched(currentSessionId)
    }
    prevGeneratingRef.current = isGenerating
  }, [isGenerating, currentSessionId])

  // 切换会话/项目时按 sessionId 拉取磁盘编排 state（过滤归属）
  useEffect(() => {
    if (currentProject && currentSessionId) {
      void loadComposeState(currentProject, currentSessionId)
    }
  }, [currentSessionId, currentProject, loadComposeState])

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

  // acceptFile / rejectFile 用 useCallback 包裹 store action，稳定引用
  const handleAcceptFile = useCallback(async (sessionId: string, messageId: string, filePath: string) => {
    await acceptFile(sessionId, messageId, filePath)
  }, [acceptFile])

  const handleRejectFile = useCallback(async (sessionId: string, messageId: string, filePath: string) => {
    await rejectFile(sessionId, messageId, filePath)
  }, [rejectFile])

  const [inputVal, setInputVal] = useState('')
  const [isComposing, setIsComposing] = useState(false)
  /** 用户上滚离开底部时显示「回到底部」 */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const slashSkills = useSkillsStore(state => state.skills)
  const refreshSkills = useSkillsStore(state => state.refresh)
  const setSkills = useSkillsStore(state => state.setSkills)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const composerBoxRef = useRef<HTMLDivElement>(null)
  const skillACRef = useRef<SkillACHandle>(null)

  // 应用启动即可加载技能列表；工作区切换时 reload，并订阅 skill:changed
  useEffect(() => {
    void refreshSkills()
    const unsub = window.nova.skill.onChange(list => setSkills(list))
    return unsub
  }, [refreshSkills, setSkills])

  useEffect(() => {
    if (currentProject) {
      void window.nova.skill.reload(currentProject)
    }
  }, [currentProject])

  // 设置页「使用技能」预填 composer
  useEffect(() => {
    if (composerPrefill) {
      setInputVal(composerPrefill)
      clearComposerPrefill()
      requestAnimationFrame(() => {
        textareaRef.current?.focus()
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
        }
      })
    }
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
  /** 程序滚动保护截止时间戳 */
  const programmaticScrollUntilRef = useRef(0)
  const lastScrollTopRef = useRef(0)
  /** prepend 历史消息前记录的 scrollHeight，用于补载后修正 scrollTop 防止视口跳动 */
  const scrollHeightBeforePrependRef = useRef<number | null>(null)
  // 生成阶段 rAF 合并滚动（render-pool tick 补充路径）
  const streamAutoScrollRef = useRef<ReturnType<typeof createStreamAutoScrollController> | null>(null)
  const streamScrollPollerRef = useRef<ReturnType<typeof createStreamingScrollPoller> | null>(null)

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

  const canAutoScroll = useCallback(() => {
    return canFollowAutoScroll(autoScrollModeRef.current)
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
    autoScrollModeRef.current = syncAutoScrollModeOnScroll({
      metrics,
      previousScrollTop: lastScrollTopRef.current,
      autoScrollMode: autoScrollModeRef.current,
      isOutputting: isGenerating,
      isProgrammaticScroll: isProgrammatic
    })
    lastScrollTopRef.current = container.scrollTop
    // 显隐只看距底部距离，与 autoScrollMode 解耦
    setShowScrollToBottom(shouldShowScrollToBottom(metrics))
  }, [isGenerating])

  const handleScrollToBottomClick = useCallback(() => {
    autoScrollModeRef.current = 'user'
    setShowScrollToBottom(false)
    scrollToBottomInstant('smooth')
  }, [scrollToBottomInstant])

  const tryLoadOlderMessages = useCallback(() => {
    const container = scrollContainerRef.current
    if (!container || !hasMoreMessagesAbove || isLoadingOlderMessages) return
    if (container.scrollTop > HISTORY_LOAD_SCROLL_THRESHOLD_PX) return

    scrollHeightBeforePrependRef.current = container.scrollHeight
    void loadOlderMessages()
  }, [hasMoreMessagesAbove, isLoadingOlderMessages, loadOlderMessages])

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

  // 处理文本域自动折行高度自适应
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputVal(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }

  const handleSend = async () => {
    if (!inputVal.trim() && imageAttachments.length === 0) return
    if (isGenerating || sendInFlight) return
    // 另一会话仍有主进程轮次：友好拦截，避免裸 IPC 错误
    if (mainTurnSessionId && currentSessionId && mainTurnSessionId !== currentSessionId) {
      return
    }
    if (!modelConfig) {
      alert("请先在设置中配置 LLM 服务商与模型！")
      useSettingsStore.getState().openLlmSettings()
      return
    }
    if (!currentProject) {
      alert("请先在左侧选择或新建一个项目工作区！")
      selectProject()
      return
    }

    const text = inputVal.trim()
    const images = imageAttachments

    // 用户主动发送：无论之前是否上滚离开底部，都恢复跟随，让用户看到自己刚发的消息。
    autoScrollModeRef.current = 'stream'

    // askQuestion 面板仍开着时用户发了新消息：先 dismiss 当前提问（resolve 空 answers），
    // 让旧轮次能正常走到 message_end。否则新消息只会进 steering 队列，而旧轮次被
    // 未 resolve 的 askQuestion 阻塞、永不到达 message_end → 互等死锁。
    await preSendGate({ hasPendingAskQuestion: !!pendingAskQuestion, dismissAskQuestion })

    // 竞态修复：await 跨了一个 IPC 往返，期间旧轮次可能已 message_end（isGenerating 翻 false、
    // dispatchNextPending 已尝试 drain 但队列为空提前返回）。此处必须重读最新 isGenerating，
    // 不能用本次 render 捕获的旧值——否则会用过期 true 把消息塞进队列，而轮次已结束、再无
    // message_end 来 drain，消息永久卡在 steering 队列。
    const stillGenerating = useChatStore.getState().isGenerating

    // Phase 6：Steering Queue
    // Agent 正在运行时，新消息进入挂起队列，turn boundary 自动 dispatch
    if (stillGenerating) {
      enqueuePendingMessage(text, images)
    } else {
      // 旧轮次已结束（dismiss 后 message_end 先到）：直接发送，避免消息滞留队列
      sendMessage(text, images)
    }

    setInputVal('')
    setImageAttachments([])
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleSlashSelect = useCallback((text: string) => {
    setInputVal(text)
    requestAnimationFrame(() => {
      textareaRef.current?.focus()
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`
      }
    })
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillACRef.current?.onKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleSlashButton = () => {
    setInputVal(prev => (prev.startsWith('/') ? prev : `/${prev}`))
    textareaRef.current?.focus()
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
        <div
          className="chat-messages flex-1 overflow-y-auto pt-6 px-4 pb-64"
          ref={bindScrollContainer}
          onScroll={handleScroll}
          style={{ overflowAnchor: 'none' }}
        >
          {tier1BranchContext && (
            <div className="chat-tier1-notice" role="status">
              <span className="chat-tier1-notice__text">
                已切换到分支 {tier1BranchContext.branchIndex}/{tier1BranchContext.branchTotal}
                {tier1BranchContext.partialReplay
                  ? '（部分文件改动因缺少 forward 快照未能重放）'
                  : '（仅对话历史，工作区停在分叉点状态）'}
              </span>
              <button
                type="button"
                className="chat-tier1-notice__dismiss"
                onClick={dismissTier1BranchNotice}
                aria-label="关闭提示"
              >
                ×
              </button>
            </div>
          )}

          {(isLoadingOlderMessages || hasMoreMessagesAbove) && (
            <div className="chat-messages__history-hint" aria-live="polite">
              {isLoadingOlderMessages ? '正在加载更早的消息…' : '向上滚动加载更早的消息'}
            </div>
          )}

        <MaybeProfiler enabled={isStreamingPerfEnabled()} id="ChatPanel-messages" onRender={handleChatProfilerRender}>
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
          tier1StaleDiffSet={tier1StaleDiffSet}
          rollbackErrors={rollbackErrors}
          onAcceptFile={handleAcceptFile}
          onRejectFile={handleRejectFile}
          onAcceptAllFiles={acceptAllFiles}
          onRejectAllFiles={rejectAllFiles}
          onRenderPoolTick={scheduleStreamAutoScroll}
          isPausedForUserInput={isPausedForUserInput}
          pausedMessageId={pausedMessageId}
          messageDiffs={messageDiffs}
          loadingDiffs={loadingDiffs}
          loadingDiffPlaceholders={loadingDiffPlaceholders}
          onLoadDiffs={loadMessageDiffs}
        />
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
        </MaybeProfiler>
      </div>
      )}

      {/* 底部输入框 / 空状态中央输入框 */}
      <div
        className={`chat-panel__composer-area ${
          isEmptyState ? 'chat-panel__composer-area--empty' : ''
        }`}
      >
        <div className="chat-panel__composer-inner">
          {/* 回到底部：放在 composer 栈顶，AskQuestion/Todo dock 展开时自然上移，不重叠 */}
          {!isEmptyState && showScrollToBottom && (
            <button
              type="button"
              className="chat-scroll-to-bottom"
              onClick={handleScrollToBottomClick}
              aria-label="回到底部"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M4 6.5L8 10.5L12 6.5"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}

          {/* 跨会话 / 失忆轮次提示：提供停止入口，避免裸 IPC 拒发 */}
          {showCrossSessionTurnBanner && (
            <div className="chat-cross-turn-notice" role="status">
              <span className="chat-cross-turn-notice__text">
                {crossSessionTurnIsOther
                  ? '另一个会话正在运行任务'
                  : '当前会话仍有任务在后台运行'}
              </span>
              <button
                type="button"
                className="chat-cross-turn-notice__stop"
                onClick={() => void cancelExecution()}
              >
                {cancelling ? '正在停止' : '停止'}
              </button>
            </div>
          )}

          {/* 取消 grace 超时：部分任务未退出 + 强制终止 */}
          {cancelGraceExceeded && (
            <div className="chat-cross-turn-notice" role="alert">
              <span className="chat-cross-turn-notice__text">部分任务未退出</span>
              <button
                type="button"
                className="chat-cross-turn-notice__stop"
                onClick={() => void forceTerminate()}
              >
                强制终止
              </button>
            </div>
          )}

          {/* interrupted run：继续分析 / 回滚本轮 / 查看已执行步骤 */}
          {interruptedRunId && (
            <div className="chat-cross-turn-notice" role="status">
              <span className="chat-cross-turn-notice__text">
                上次任务异常中断
                {interruptedSteps.length > 0
                  ? `（已记录 ${interruptedSteps.length} 个工具步骤）`
                  : ''}
              </span>
              <button
                type="button"
                className="chat-cross-turn-notice__stop"
                onClick={() => void interruptedAction('continue')}
              >
                继续分析
              </button>
              <button
                type="button"
                className="chat-cross-turn-notice__stop"
                onClick={() => void interruptedAction('rollback')}
              >
                回滚本轮
              </button>
              <button
                type="button"
                className="chat-cross-turn-notice__stop"
                onClick={() => void interruptedAction('inspect')}
              >
                查看已执行步骤
              </button>
              <button
                type="button"
                className="chat-cross-turn-notice__stop"
                onClick={() => clearInterrupted()}
              >
                关闭
              </button>
            </div>
          )}

          {/* 编排 askUser：仅归属当前会话时展示 */}
          {composeBelongsToCurrent && pendingComposeAskUser && (
            <div className="ask-question-dock">
              <ComposeAskUserPanel />
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
            composer 不需要布局补间动画，改为普通 div。
          */}
          <div
            className="w-full flex flex-col items-center pointer-events-auto"
          >
            {/* Agent 恢复 / Hook 状态条：贴近输入框，对齐主流 Agent IDE 的 composer 状态区 */}
            <RecoveryBanner messageId={currentGeneratingMessageId} />

            {/* 编排进度 dock：ask 面板与 TodoPanel 之间；按会话门控 */}
            {composeBelongsToCurrent && (
              <div className="w-full px-3 pointer-events-auto">
                <ComposeProgressPanel />
              </div>
            )}

            {/* 当前会话计划 dock：细条常驻至下一条消息；ask 面板在场时锁细条 */}
            <div className="w-full px-3 pointer-events-auto">
              <TodoPanel
                sessionId={currentSessionId}
                priorityDockOccupied={
                  !!pendingAskQuestion ||
                  (!!pendingComposeAskUser && composeBelongsToCurrent)
                }
              />
            </div>

            <AnimatePresence>
              {isEmptyState && (
                <motion.div
                  initial={{ opacity: 0, y: -20 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -20 }}
                  className="mb-8 flex flex-col items-center justify-center space-y-4"
                >
                  <NovaLogo size={48} />
                  <h1 className="text-4xl md:text-5xl tracking-tight font-serif text-text-primary">
                    说出你的想法
                  </h1>
                </motion.div>
              )}
            </AnimatePresence>

            {/* 同上：去掉 layout 动画，避免每次渲染强制 flush 布局 */}
            <div
              ref={composerBoxRef}
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

              <SkillAC
                ref={skillACRef}
                inputValue={inputVal}
                anchorRef={composerBoxRef}
                skills={slashSkills}
                onSelect={handleSlashSelect}
                isComposing={isComposing}
              />

              <textarea
                ref={textareaRef}
                className="w-full bg-transparent resize-none outline-none text-[15px] leading-relaxed text-text-primary placeholder:text-gray-400 min-h-[44px] max-h-[300px] overflow-y-auto px-2 py-1"
                placeholder={pendingAskQuestion
                  ? '请先回答上方问题，再发送新消息（或输入排队）'
                  : isGenerating
                    ? 'Agent 正在运行，输入将进入排队队列...'
                    : '向 Nova 提问或分配编程任务...'}
                rows={1}
                value={inputVal}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onCompositionStart={() => setIsComposing(true)}
                onCompositionEnd={() => setIsComposing(false)}
                onPaste={handlePaste}
                // Phase 6：textarea 在 Agent 运行期间不再 disabled，
                // 用户可以继续输入，新消息进入 Steering Queue 等 turn boundary 自动 dispatch
              />
              <div className="flex items-center justify-between mt-2 pt-2 border-t border-gray-50/50">
                <div className="flex items-center gap-2">
                  <button
                    className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-50 text-gray-500 hover:bg-[rgba(201,100,66,0.1)] hover:text-[#c96442] transition-colors text-sm font-medium"
                    onClick={handleSlashButton}
                    title="插入 / 命令"
                    type="button"
                  >
                    /
                  </button>
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
                  <ModelSelector />
                  <ModeSwitch />
                  <ContextIndicator />
                </div>
                <div>
                  {isGenerating || sendInFlight || cancelling ? (
                    <button
                      className="flex items-center justify-center w-8 h-8 rounded-full bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                      onClick={() => void cancelExecution()}
                      title={cancelling ? '正在停止' : '中断生成'}
                      disabled={cancelling && !cancelGraceExceeded}
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
            </div>

          </div>

        </div>
      </div>

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
