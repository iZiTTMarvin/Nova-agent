import { appendTerminalErrorToBlocks } from '../../../../shared/session/terminalErrorBlocks'
import { markThinkingEndedForMessage } from '../../../lib/thinkingTimingMemory'
import type { ChatState, ExtendedMessage, RendererToolBlock } from '../types'
import {
  appendLiveBlock,
  bumpRevision,
  commitMessageList,
  dispatchNextPendingMessage,
  emptyStreamTransientState,
  omitRecoveryFieldsForMessage,
  reconcileFocusedSession,
  removeLiveTurnEntry
} from '../internal'
import type { ChatSliceCreator, TurnLifecycleSliceState } from '../types'

function cancelToolBlock(block: RendererToolBlock): RendererToolBlock {
  const nestedActivities = block.nestedActivities?.map(activity =>
    activity.status === 'running'
      ? { ...activity, status: 'error' as const }
      : activity
  )
  const nestedChanged = nestedActivities?.some((activity, index) =>
    activity !== block.nestedActivities?.[index]
  ) === true
  if (block.status !== 'running' && !nestedChanged) return block

  const { argumentsRaw: _drop, ...restBlock } = block
  return {
    ...restBlock,
    ...(block.status === 'running'
      ? { status: 'error' as const, result: '用户取消执行' }
      : {}),
    ...(nestedActivities ? { nestedActivities } : {})
  }
}

export function initialTurnLifecycleState(): Pick<
  TurnLifecycleSliceState,
  'isGenerating' | 'currentGeneratingMessageId' | 'activeAgentSessionId'
> {
  return {
    isGenerating: false,
    currentGeneratingMessageId: null,
    activeAgentSessionId: null
  }
}

/**
 * 切会话时清零轮次运行态。目标会话是否运行中由 snapshot-first 水合重新判定，
 * 禁止沿用旧会话的运行态投影。
 */
export function resetTurnLifecycleOnSessionSwitch(): Pick<
  TurnLifecycleSliceState,
  'isGenerating' | 'currentGeneratingMessageId' | 'activeAgentSessionId'
> {
  return initialTurnLifecycleState()
}

export const createTurnLifecycleSlice: ChatSliceCreator<TurnLifecycleSliceState> = (set, get) => ({
  ...initialTurnLifecycleState(),

  handleMessageEnd: async (messageId: string, interrupted?: boolean) => {
    set(state => {
      const nextMessages = state.messages.slice()
      const idx = state.messageIndexById[messageId]
      // 轮次终态前先回收未封存的活跃文本/思考，避免内容停留在活跃回合里。
      const live = state.liveTurn[messageId]
      const endedThinkingMs =
        live?.type === 'thinking' ? markThinkingEndedForMessage(messageId) : null
      if (idx !== undefined && nextMessages[idx]) {
        let base = live ? appendLiveBlock(nextMessages[idx]!, live) : nextMessages[idx]!
        if (endedThinkingMs != null && base.blocks && base.blocks.length > 0) {
          const blocks = [...base.blocks]
          for (let i = blocks.length - 1; i >= 0; i--) {
            const block = blocks[i]
            if (block.type !== 'thinking') continue
            if (block.durationMs == null) {
              blocks[i] = { ...block, durationMs: endedThinkingMs }
              base = { ...base, blocks }
            }
            break
          }
        }
        if (interrupted) {
          // 取消中断结束时，把该消息的 running tool 块标记为 error
          // 并清空 argumentsRaw、附上 "用户取消执行" 结果。同时标记消息 interrupted。
          const blocks = base.blocks?.map(b => {
            return b.type === 'tool' ? cancelToolBlock(b as RendererToolBlock) : b
          })
          const toolCalls = base.toolCalls?.map(tc => {
            if (tc.status === 'running') {
              const { argumentsRaw: _tcDrop, ...restTc } = tc
              return { ...restTc, status: 'error' as const, result: '用户取消执行' }
            }
            return tc
          })
          nextMessages[idx] = bumpRevision({
            ...base,
            interrupted: true,
            blocks,
            toolCalls,
            turnEndedAt: Date.now()
          })
        } else {
          nextMessages[idx] = bumpRevision({
            ...base,
            turnEndedAt: Date.now()
          })
        }
      }
      const patch: Partial<ChatState> = {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        isGenerating: false,
        currentGeneratingMessageId: null,
        activeAgentSessionId: null,
        sendInFlight: false,
        branchForkInProgress: false,
        ...omitRecoveryFieldsForMessage(state, messageId),
        // 中断时清空所有流式工具参数累积
        ...(interrupted ? emptyStreamTransientState() : {})
      }
      if (live) patch.liveTurn = removeLiveTurnEntry(state.liveTurn, messageId)
      return patch
    })

    // 后台启动的回复可能缺少早期流式片段；终态始终回到 SessionStore
    // 做按 id 对账。已持久化消息优先，下一轮刚产生的实时消息仍会被保留。
    const sessionIdAtEnd = get().currentSessionId
    if (sessionIdAtEnd) {
      try {
        await reconcileFocusedSession({ getState: get, setState: set }, sessionIdAtEnd)
      } catch (err) {
        console.error('[useChatStore] message_end 终态消息对账失败:', err)
      }
    }

    // 更新当前会话的消息数属性，并自动加载 diff
    const { currentSessionId, sessions, messages } = get()
    if (currentSessionId) {
      get().loadMessageDiffs(currentSessionId, messageId)
      set({
        sessions: sessions.map(s =>
          s.id === currentSessionId ? { ...s, messageCount: messages.length, updatedAt: Date.now() } : s
        )
      })
    }

    // 正常完成路径：清除 agent store 的 5s 兜底定时器。
    // 即使是 interrupted 路径，message-end 已正常到达，定时器也不应再触发。
    const { useAgentStore } = await import('../../useAgentStore')
    useAgentStore.getState().clearCancelFallback()

    // turn boundary 自动 dispatch 挂起消息
    await dispatchNextPendingMessage({ getState: get, setState: set })

    // 分叉轮次正常结束：补 bump revision 拉取 branch 元信息（翻页器）
    await get().finishBranchMetaRefresh()
  },

  handleError: async (messageId: string, error: string) => {
    const { currentSessionId } = get()
    const activeSessionId = currentSessionId || 'session_default'

    set(state => {
      const idx = state.messageIndexById[messageId]
      const live = state.liveTurn[messageId]
      const commonFields = {
        isGenerating: false,
        currentGeneratingMessageId: null,
        branchForkInProgress: false,
        // error 路径不发射 message-end，此处同步清理恢复状态，避免残留
        ...omitRecoveryFieldsForMessage(state, messageId)
      }
      const livePatch: Partial<ChatState> = live
        ? { liveTurn: removeLiveTurnEntry(state.liveTurn, messageId) }
        : {}

      if (idx !== undefined && state.messages[idx]) {
        // 消息已存在：先把未封存的活跃文本/思考回收，再附加错误标记与文案。
        // 禁止清空 blocks（否则用户看到「保护把正常回复弄没了」）。
        const prev0 = state.messages[idx]!
        const prev = live ? appendLiveBlock(prev0, live) : prev0
        const hasBlocks = !!(prev.blocks && prev.blocks.length > 0)
        const nextBlocks = hasBlocks
          ? appendTerminalErrorToBlocks(prev.blocks!, error)
          : prev.blocks
        const nextMessages = state.messages.slice()
        nextMessages[idx] = bumpRevision({
          ...prev,
          // 无 blocks 时用错误文案；有 blocks 时保留原 content，由 blocks 渲染
          content: hasBlocks ? prev.content || '' : error,
          isError: true,
          interrupted: true,
          thinking: prev.thinking,
          blocks: nextBlocks,
          toolCalls: prev.toolCalls
        })
        return {
          ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
          ...commonFields,
          ...livePatch
        }
      }

      // 罕见 fallback：error 在 message_start 之前到达，此时列表里还没有这条消息，
      // 才走追加路径（保持 messageIndexById 一致性）
      const errorMsg: ExtendedMessage = {
        id: messageId,
        sessionId: activeSessionId,
        role: 'assistant',
        content: error,
        isError: true,
        timestamp: Date.now(),
        _revision: 0
      }
      const nextMessages = [...state.messages, errorMsg]
      return {
        ...commitMessageList(state, {
          nextMessages,
          nextIndex: { ...state.messageIndexById, [messageId]: nextMessages.length - 1 },
          skipWindowTrim: true
        }),
        ...commonFields,
        ...livePatch
      }
    })

    if (currentSessionId) {
      try {
        await reconcileFocusedSession({ getState: get, setState: set }, currentSessionId)
      } catch (reloadError) {
        console.error('[useChatStore] error 终态消息对账失败:', reloadError)
      }
    }

    // error 终态同样是 turn boundary：派发队列首条，防止「已排队 N 条」
    // 滞留到用户手动发消息才触发（还会打乱 FIFO 顺序）
    await dispatchNextPendingMessage({ getState: get, setState: set })

    if (get().pendingBranchMetaReload) {
      await get().finishBranchMetaRefresh()
    }
  },

  markRunningAsCancelled: async () => {
    set(state => {
      const nextMessages = state.messages.map(msg => {
        // 取消兜底也是 turn boundary：把未封存的活跃文本/思考回收进消息，保留部分回答。
        const live = state.liveTurn[msg.id]
        const base = live ? appendLiveBlock(msg, live) : msg
        if (!base.blocks && !base.toolCalls && !live) return msg
        let changed = !!live

        const blocks = base.blocks?.map(b => {
          if (b.type !== 'tool') return b
          const cancelled = cancelToolBlock(b as RendererToolBlock)
          if (cancelled !== b) changed = true
          return cancelled
        })

        const toolCalls = base.toolCalls?.map(tc => {
          if (tc.status === 'running') {
            changed = true
            const { argumentsRaw: _tcDrop, ...restTc } = tc
            return { ...restTc, status: 'error' as const, result: '用户取消执行' }
          }
          return tc
        })

        return changed ? bumpRevision({ ...base, blocks, toolCalls }) : msg
      })

      return {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        isGenerating: false,
        currentGeneratingMessageId: null,
        liveTurn: {},
        ...emptyStreamTransientState()
      }
    })

    // cancel 兜底路径也是 turn boundary。派发下一条消息前必须清除旧轮次定时器，
    // 避免迟到的 fallback 作用于刚启动的新轮次。
    const { useAgentStore } = await import('../../useAgentStore')
    useAgentStore.getState().clearCancelFallback()
    await dispatchNextPendingMessage({ getState: get, setState: set })
  }
})
