import React, { useState, useRef, useEffect, useCallback } from 'react'
import { useChatStore } from '../../stores/useChatStore'
import { useAgentStore } from '../../stores/useAgentStore'
import { useSettingsStore } from '../../stores/useSettingsStore'
import { selectSupportsVisionFromConfig } from '../../stores/selectors'
import { motion, AnimatePresence } from 'framer-motion'
import {
  SendIcon,
  StopIcon,
  NovaLogo,
  ImageIcon
} from '../../components/Icons'
import { MessageItem } from './MessageItem'
import { ModeSwitch } from '../mode-switch/ModeSwitch'
import { ModelSelector } from './ModelSelector'
import { browserFrameScheduler, createStreamAutoScrollController, shouldPauseAutoFollow } from './autoScroll'
import { ContextIndicator } from './ContextIndicator'
import { ImagePreviewBar } from '../../components/ImagePreviewBar'
import { TodoPanel } from '../todo/TodoPanel'
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
  const currentSessionId = useChatStore(state => state.currentSessionId)
  const currentGeneratingMessageId = useChatStore(state => state.currentGeneratingMessageId)
  const sendMessage = useChatStore(state => state.sendMessage)
  const rollbackMessage = useChatStore(state => state.rollbackMessage)
  const messageDiffs = useChatStore(state => state.messageDiffs)
  const loadingDiffs = useChatStore(state => state.loadingDiffs)
  const loadingDiffPlaceholders = useChatStore(state => state.loadingDiffPlaceholders)
  const rejectFile = useChatStore(state => state.rejectFile)
  const acceptFile = useChatStore(state => state.acceptFile)
  const acceptAllFiles = useChatStore(state => state.acceptAllFiles)
  const rejectAllFiles = useChatStore(state => state.rejectAllFiles)
  const loadMessageDiffs = useChatStore(state => state.loadMessageDiffs)
  // Steering Queue
  const pendingUserMessages = useChatStore(state => state.pendingUserMessages)
  const enqueuePendingMessage = useChatStore(state => state.enqueuePendingMessage)
  const removePendingMessage = useChatStore(state => state.removePendingMessage)

  // ── agent store（权限/取消/验证权限） ──
  const cancelExecution = useAgentStore(state => state.cancelExecution)
  const pendingVerificationRequest = useAgentStore(state => state.pendingVerificationRequest)
  const respondVerificationPermission = useAgentStore(state => state.respondVerificationPermission)

  // 处理消息回退操作（useCallback 稳定引用，供 MessageItem areEqual 比较）
  const handleRollback = useCallback(async (messageId: string) => {
    if (!currentSessionId) return
    if (window.confirm('确定要回退到此消息执行前的状态吗？这将物理恢复工作区文件，并移除此消息之后的所有对话记录。')) {
      await rollbackMessage(currentSessionId, messageId)
    }
  }, [currentSessionId, rollbackMessage])

  // acceptFile / rejectFile 用 useCallback 包裹 store action，稳定引用
  const handleAcceptFile = useCallback(async (sessionId: string, messageId: string, filePath: string) => {
    await acceptFile(sessionId, messageId, filePath)
  }, [acceptFile])

  const handleRejectFile = useCallback(async (sessionId: string, messageId: string, filePath: string) => {
    await rejectFile(sessionId, messageId, filePath)
  }, [rejectFile])

  const [inputVal, setInputVal] = useState('')
  const [isComposing, setIsComposing] = useState(false)
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
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // 用户是否主动上滚，上滚期间停止自动跟随
  const userScrolledUpRef = useRef(false)
  // 生成阶段专用的滚动调度器：统一管理 rAF 节流与取消逻辑
  const streamAutoScrollRef = useRef<ReturnType<typeof createStreamAutoScrollController> | null>(null)

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

  // 流式阶段：render pool 每次 tick 触发自动滚动，让滚动节奏与字符放出节奏同步
  // Phase 4 之前是监听 messages 变化，但 messages 在 Phase 2 buffer 后频率已大幅降低，
  // 改为 render pool tick 触发后能精确跟随"用户看到的字符展开"。
  // 取消与 scroll 都被 streamAutoScrollRef 内部用 rAF 节流，重复触发安全。
  const scheduleStreamAutoScroll = useCallback(() => {
    streamAutoScrollRef.current?.schedule()
  }, [])

  // 流式期间才挂自动滚动调度；非流式阶段由 messages 长度变化 effect 接管
  useEffect(() => {
    if (!isGenerating) {
      streamAutoScrollRef.current?.cancel()
    }
  }, [isGenerating])

  // 处理文本域自动折行高度自适应
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputVal(e.target.value)
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px'
    }
  }

  const handleSend = () => {
    if (!inputVal.trim() && imageAttachments.length === 0) return
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

    // Phase 6：Steering Queue
    // Agent 正在运行时，新消息进入挂起队列，turn boundary 自动 dispatch
    if (isGenerating) {
      enqueuePendingMessage(text, images)
      setInputVal('')
      setImageAttachments([])
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      return
    }

    // 正常路径：直接发送
    sendMessage(text, images)
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

    const toProcess = files.slice(0, remainingSlots)
    const results = await Promise.all(toProcess.map(f => fileToImageAttachment(f)))

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
  }, [imageAttachments.length, showToast])

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
          className="chat-messages flex-1 overflow-y-auto pt-6 px-4 pb-32"
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
          {/* 当前会话的 todo 计划面板（无数据时返回 null，不占视觉空间） */}
          <TodoPanel sessionId={currentSessionId} />

        {messages.map(msg => {
          const diffCache = messageDiffs[msg.id]
          const isDiffLoading = loadingDiffs.has(msg.id)
          const diffPlaceholders = loadingDiffPlaceholders[msg.id]
          return (
            <MessageItem
              key={msg.id}
              msg={msg}
              isGenerating={isGenerating}
              currentGeneratingMessageId={currentGeneratingMessageId}
              currentMode={currentMode}
              currentSessionId={currentSessionId}
              onRollback={handleRollback}
              onAcceptFile={handleAcceptFile}
              onRejectFile={handleRejectFile}
              onAcceptAllFiles={acceptAllFiles}
              onRejectAllFiles={rejectAllFiles}
              onRenderPoolTick={scheduleStreamAutoScroll}
              diffCache={diffCache}
              isDiffLoading={isDiffLoading}
              diffPlaceholders={diffPlaceholders}
              onLoadDiffs={loadMessageDiffs}
            />
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
        <div ref={messagesEndRef} />
      </div>
      )}

      {/* 底部输入框 / 空状态中央输入框 */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 300, damping: 30 }}
        className={`absolute left-0 right-0 flex flex-col items-center justify-center px-4 pointer-events-none ${
          isEmptyState ? 'top-0 bottom-0' : 'bottom-6'
        }`}
      >
        <div className="w-full max-w-3xl flex flex-col items-center pointer-events-auto">

          {/* Agent 恢复 / Hook 状态条：贴近输入框，对齐主流 Agent IDE 的 composer 状态区 */}
          <RecoveryBanner messageId={currentGeneratingMessageId} />

          <AnimatePresence>
            {isEmptyState && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="mb-8 flex flex-col items-center justify-center space-y-4"
              >
                <NovaLogo size={48} className="text-[#d97757]" />
                <h1 className="text-4xl md:text-5xl tracking-tight font-serif text-text-primary">
                  说出你的想法
                </h1>
              </motion.div>
            )}
          </AnimatePresence>

          <motion.div
            ref={composerBoxRef}
            layout
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
              placeholder={isGenerating
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
                {isGenerating ? (
                  <button
                    className="flex items-center justify-center w-8 h-8 rounded-full bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                    onClick={cancelExecution}
                    title="中断生成"
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
          </motion.div>

        </div>
      </motion.div>

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
