import { sanitizeToolInput, sanitizeToolOutput } from '../../../../shared/tool-input-sanitizer'
import { retainCommittedBlocksForRetry } from '../../../../shared/session/retainCommittedBlocksForRetry'
import type { AgentToolProcessHandle } from '../../../../shared/ipc/types'
import { parsePartialToolArgs } from '../../../lib/partialJsonArgs'
import { createAssistantMessage } from '../../../lib/focusedSessionRecovery'
import {
  clearThinkingTimingForMessage,
  markThinkingEndedForMessage,
  markThinkingStarted
} from '../../../lib/thinkingTimingMemory'
import type {
  ExtendedToolCall,
  NestedToolActivity,
  RendererMessageBlock,
  RendererToolBlock
} from '../types'
import {
  appendLiveBlock,
  bumpRevision,
  commitMessageList,
  emptyStreamTransientState,
  removeLiveTurnEntry,
  stripInlinePseudoToolCalls
} from '../internal'
import type {
  ChatSliceCreator,
  ChatState,
  LiveBlock,
  StreamDelta,
  StreamDeltaBatch,
  StreamSliceState
} from '../types'

export function initialStreamState(): Pick<StreamSliceState, 'streamingToolArgs'> {
  return emptyStreamTransientState()
}

export function resetStreamOnSessionSwitch(): Pick<StreamSliceState, 'streamingToolArgs'> {
  return initialStreamState()
}

export const createStreamSlice: ChatSliceCreator<StreamSliceState> = (set, get) => {
  /**
   * 嵌套工具活动（run_code 沙箱内调用）更新：定位父工具块并重写其
   * nestedActivities；无父块或更新函数返回 null 时不改动消息。
   */
  const updateNestedActivity = (
    messageId: string,
    parentToolCallId: string,
    update: (activities: NestedToolActivity[]) => NestedToolActivity[] | null
  ): void => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg || !msg.blocks) return state
      let changed = false
      const blocks = msg.blocks.map(b => {
        if (b.type !== 'tool' || b.toolCallId !== parentToolCallId) return b
        const next = update(b.nestedActivities ?? [])
        if (!next) return b
        changed = true
        return { ...b, nestedActivities: next }
      })
      if (!changed) return state
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, blocks })
      return commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true })
    })
  }

  return {
  ...initialStreamState(),

  handleMessageStart: (messageId: string) => {
    const { currentSessionId } = get()
    const activeSessionId = currentSessionId || 'session_default'

    set(state => {
      const existingIndex = state.messageIndexById[messageId]
      if (existingIndex !== undefined) {
        return {
          currentGeneratingMessageId: messageId,
          sendInFlight: false
        }
      }

      // 会话切回时 delta 可能先于 message_start 抵达；仅为当前运行中的同一消息补壳，
      // 让重复或乱序事件仍落到同一个 assistant 消息，而不误建历史消息。
      const assistantMsg = createAssistantMessage(activeSessionId, messageId)
      const nextMessages = [...state.messages, assistantMsg]
      return {
        ...commitMessageList(state, {
          nextMessages,
          nextIndex: { ...state.messageIndexById, [messageId]: nextMessages.length - 1 },
          skipWindowTrim: true
        }),
        currentGeneratingMessageId: messageId,
        sendInFlight: false
      }
    })
  },

  handleAttemptFailed: (messageId: string, _attemptId: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      // 失败 attempt 只丢掉本段未完成输出；已完成工具轮次与主进程累积器同一套保留规则。
      const blocksBefore = msg.blocks ?? []
      const retained = retainCommittedBlocksForRetry(blocksBefore)
      const retainedToolIds = new Set(
        retained.flatMap(b => (b.type === 'tool' ? [b.toolCallId] : []))
      )
      let thinking = ''
      let content = ''
      for (const block of retained) {
        if (block.type === 'thinking') thinking += block.content
        if (block.type === 'text') content += block.content
      }
      const toolCalls = (msg.toolCalls ?? []).filter(tc => retainedToolIds.has(tc.id))
      const next = [...state.messages]
      next[idx] = bumpRevision({
        ...msg,
        content,
        thinking,
        toolCalls,
        blocks: retained
      })
      const patch: Partial<ChatState> = commitMessageList(state, {
        nextMessages: next,
        nextIndex: state.messageIndexById,
        skipWindowTrim: true
      })
      if (state.liveTurn[messageId]) {
        patch.liveTurn = removeLiveTurnEntry(state.liveTurn, messageId)
      }
      clearThinkingTimingForMessage(messageId)
      return patch
    })
  },

  handleThinkingDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      // @deprecated 路径仍可能与 applyStreamDeltas 混用：先 fold 活跃回合，避免 liveTurn 与 messages 分裂。
      const live = state.liveTurn[messageId]
      const base = live ? appendLiveBlock(msg, live) : msg
      const blocks = base.blocks ? [...base.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'thinking') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
        markThinkingStarted(messageId, blocks.length - 1)
      } else {
        blocks.push({ type: 'thinking', content: delta })
        markThinkingStarted(messageId, blocks.length - 1)
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...base, thinking: (base.thinking ?? '') + delta, blocks })
      const patch: Partial<ChatState> = commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true })
      if (live) patch.liveTurn = removeLiveTurnEntry(state.liveTurn, messageId)
      return patch
    })
  },

  handleTextDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const live = state.liveTurn[messageId]
      const base = live ? appendLiveBlock(msg, live) : msg
      const blocks = base.blocks ? [...base.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
      } else {
        markThinkingEndedForMessage(messageId)
        blocks.push({ type: 'text', content: delta })
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...base, content: base.content + delta, blocks })
      const patch: Partial<ChatState> = commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true })
      if (live) patch.liveTurn = removeLiveTurnEntry(state.liveTurn, messageId)
      return patch
    })
  },

  handleToolCall: (
    messageId: string,
    toolCallId: string,
    toolName: string,
    args: Record<string, unknown>,
    parentToolCallId?: string
  ) => {
    const sanitizedArgs = sanitizeToolInput(toolName, args)

    // 嵌套调用：不创建顶级工具块，追加为父块的紧凑活动
    if (parentToolCallId) {
      updateNestedActivity(messageId, parentToolCallId, activities => {
        const entry: NestedToolActivity = {
          toolCallId,
          toolName,
          args: sanitizedArgs,
          status: 'running'
        }
        const existing = activities.findIndex(a => a.toolCallId === toolCallId)
        if (existing === -1) return [...activities, entry]
        const next = [...activities]
        next[existing] = entry
        return next
      })
      return
    }

    const newToolCall: ExtendedToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: sanitizedArgs,
      status: 'running'
    }

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      // 工具调用前若仍有未封存的活跃文本/思考，先回收到 messages，再剥伪工具 JSON。
      const live = state.liveTurn[messageId]
      const base = live ? appendLiveBlock(msg, live) : msg

      const cleanedMessage = stripInlinePseudoToolCalls(base.content, base.blocks ? [...base.blocks] : [])
      const blocks = cleanedMessage.blocks
      const existingBlockIdx = blocks.findIndex(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )

      if (existingBlockIdx !== -1) {
        const existing = blocks[existingBlockIdx]
        if (existing.type === 'tool') {
          const { argumentsRaw: _drop, ...restBlock } = existing as RendererToolBlock
          blocks[existingBlockIdx] = {
            ...restBlock,
            type: 'tool',
            toolCallId,
            toolName,
            arguments: sanitizedArgs,
            status: 'running'
          }
        }
      } else {
        blocks.push({
          type: 'tool',
          toolCallId,
          toolName,
          arguments: sanitizedArgs,
          status: 'running'
        })
      }

      const toolCalls = base.toolCalls ? [...base.toolCalls] : []
      const tcIdx = toolCalls.findIndex(tc => tc.id === toolCallId)
      if (tcIdx !== -1) {
        const { argumentsRaw: _tcDrop, ...restTc } = toolCalls[tcIdx]
        toolCalls[tcIdx] = { ...restTc, name: toolName, arguments: sanitizedArgs }
      } else {
        toolCalls.push(newToolCall)
      }

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...base, content: cleanedMessage.content, toolCalls, blocks })
      const { [toolCallId]: _drop2, ...restStreaming } = state.streamingToolArgs
      const patch: Partial<ChatState> = {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        streamingToolArgs: restStreaming
      }
      if (live) patch.liveTurn = removeLiveTurnEntry(state.liveTurn, messageId)
      return patch
    })
  },

  handleToolCallStart: (messageId: string, toolCallId: string, toolName: string) => {
    const placeholder: ExtendedToolCall = {
      id: toolCallId,
      name: toolName,
      arguments: {},
      status: 'running'
    }

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      // 工具调用前的文本/思考须先封存为终态块，避免错落到 tool 块之后。
      const live = state.liveTurn[messageId]
      const base = live ? appendLiveBlock(msg, live) : msg

      const blocks: RendererMessageBlock[] = base.blocks ? [...base.blocks] : []
      blocks.push({
        type: 'tool',
        toolCallId,
        toolName,
        arguments: {},
        status: 'running',
        argumentsRaw: ''
      })

      const toolCalls = base.toolCalls ? [...base.toolCalls, placeholder] : [placeholder]
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...base, toolCalls, blocks })

      const patch: Partial<ChatState> = {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: '' }
      }
      if (live) patch.liveTurn = removeLiveTurnEntry(state.liveTurn, messageId)
      return patch
    })
  },

  handleToolCallDelta: (messageId: string, toolCallId: string, argumentsDelta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const live = state.liveTurn[messageId]
      const base = live ? appendLiveBlock(msg, live) : msg

      const prevRaw = state.streamingToolArgs[toolCallId] ?? ''
      const nextRaw = prevRaw + argumentsDelta
      const existingBlock = base.blocks?.find(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )
      const toolName = existingBlock?.type === 'tool' ? existingBlock.toolName : ''
      const partialArgs = parsePartialToolArgs(toolName, nextRaw)

      const blocks: RendererMessageBlock[] = base.blocks ? [...base.blocks] : []
      const blockIdx = blocks.findIndex(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )
      if (blockIdx !== -1 && blocks[blockIdx].type === 'tool') {
        blocks[blockIdx] = {
          ...blocks[blockIdx],
          arguments: partialArgs,
          argumentsRaw: nextRaw
        } as RendererToolBlock
      }

      const toolCalls = base.toolCalls ? base.toolCalls.map(tc =>
        tc.id === toolCallId
          ? { ...tc, arguments: partialArgs, argumentsRaw: nextRaw }
          : tc
      ) : base.toolCalls

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...base, blocks, toolCalls })
      const patch: Partial<ChatState> = {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: nextRaw }
      }
      if (live) patch.liveTurn = removeLiveTurnEntry(state.liveTurn, messageId)
      return patch
    })
  },

  handleToolResult: (
    messageId: string,
    toolCallId: string,
    _toolName: string,
    result: string,
    parentToolCallId?: string,
    failed?: boolean,
    processHandle?: AgentToolProcessHandle
  ) => {
    const isError = failed ?? (result.startsWith('工具执行失败') || result.startsWith('权限拒绝:'))

    // 嵌套调用：只更新父块下的紧凑活动状态
    if (parentToolCallId) {
      updateNestedActivity(messageId, parentToolCallId, activities => {
        if (!activities.some(a => a.toolCallId === toolCallId)) return null
        return activities.map(a =>
          a.toolCallId === toolCallId
            ? { ...a, status: isError ? ('error' as const) : ('success' as const) }
            : a
        )
      })
      return
    }

    const sanitizedResult = sanitizeToolOutput(_toolName, result, isError)

    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const blocks = msg.blocks?.map(b => {
        if (b.type === 'tool' && b.toolCallId === toolCallId) {
          return {
            ...b,
            status: isError ? 'error' as const : 'success' as const,
            result: sanitizedResult,
            ...(processHandle ? { processHandle } : {})
          }
        }
        return b
      })

      const toolCalls = msg.toolCalls?.map(tc => {
        if (tc.id === toolCallId) {
          return { ...tc, result: sanitizedResult, status: isError ? 'error' as const : 'success' as const }
        }
        return tc
      })

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, blocks, toolCalls })
      return commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true })
    })
  },

  applyStreamDeltas: (deltas: StreamDeltaBatch) => {
    if (deltas.length === 0) return

    // 同一帧内的所有 delta 必须在一次 set 中提交，避免每个片段各自触发订阅更新。
    // text/thinking 只写活跃回合（liveTurn），不触碰 messages —— 流式期间 messages
    // 引用稳定，ChatPanel 不再每帧重提交。仅当本批触发封存（类型切换 / 工具 delta）
    // 或补建缺失消息壳时才写回 messages。
    set(state => {
      let nextMessages = state.messages
      let nextMessageIndex = state.messageIndexById
      let addedMissingMessage = false

      for (const delta of deltas) {
        if (nextMessageIndex[delta.messageId] !== undefined) continue
        if (!state.isGenerating || state.currentGeneratingMessageId !== delta.messageId) {
          continue
        }
        if (!addedMissingMessage) {
          nextMessages = state.messages.slice()
          nextMessageIndex = { ...state.messageIndexById }
          addedMissingMessage = true
        }
        const assistant = createAssistantMessage(
          state.currentSessionId ?? 'session_default',
          delta.messageId
        )
        nextMessageIndex[delta.messageId] = nextMessages.length
        nextMessages.push(assistant)
      }

      const byMessageId = new Map<string, StreamDelta[]>()
      for (const delta of deltas) {
        if (nextMessageIndex[delta.messageId] === undefined) continue
        let arr = byMessageId.get(delta.messageId)
        if (!arr) {
          arr = []
          byMessageId.set(delta.messageId, arr)
        }
        arr.push(delta)
      }

      const nextStreaming: Record<string, string> = { ...state.streamingToolArgs }
      let nextLiveTurn = state.liveTurn
      let messagesChanged = addedMissingMessage
      let messagesCloned = addedMissingMessage
      let streamingChanged = false
      let liveTurnChanged = false

      const ensureMessagesCloned = () => {
        if (!messagesCloned) {
          nextMessages = state.messages.slice()
          messagesCloned = true
        }
      }

      for (const [messageId, messageDeltas] of byMessageId) {
        const idx = nextMessageIndex[messageId]
        if (idx === undefined) continue
        const msg = nextMessages[idx]
        if (!msg) continue

        // 活跃尾部块跨 batch 续接：从上一帧的 liveTurn 继续累积。
        const existingLive = state.liveTurn[messageId]
        let open: LiveBlock | undefined = existingLive ? { ...existingLive } : undefined
        let sealedBlocks: RendererMessageBlock[] | undefined
        let workingToolCalls = msg.toolCalls
        let workingContent = msg.content
        let workingThinking = msg.thinking ?? ''
        let messageSealed = false

        const sealOpen = () => {
          if (!open) return
          if (sealedBlocks === undefined) sealedBlocks = msg.blocks ? [...msg.blocks] : []
          if (open.type === 'thinking') {
            const durationMs = markThinkingEndedForMessage(messageId)
            sealedBlocks.push({
              type: 'thinking',
              content: open.content,
              ...(durationMs != null ? { durationMs } : {})
            })
            workingThinking += open.content
          } else {
            sealedBlocks.push({ type: 'text', content: open.content })
            workingContent += open.content
          }
          open = undefined
          messageSealed = true
        }

        for (const delta of messageDeltas) {
          if (delta.kind === 'thinking' || delta.kind === 'text') {
            const blockType: 'thinking' | 'text' = delta.kind === 'thinking' ? 'thinking' : 'text'
            if (open && open.type !== blockType) {
              sealOpen()
            }
            if (!open) {
              open = { type: blockType, content: delta.delta }
              if (blockType === 'thinking') {
                const nextIndex = (sealedBlocks ?? msg.blocks)?.length ?? 0
                markThinkingStarted(messageId, nextIndex)
              } else {
                markThinkingEndedForMessage(messageId)
              }
            } else {
              open.content += delta.delta
            }
          } else {
            // 工具 partial delta：先封存活跃块（工具前的文本/思考须落盘），再更新工具块。
            sealOpen()
            const sourceBlocks = sealedBlocks ?? msg.blocks ?? []
            const blockIdx = sourceBlocks.findIndex(
              b => b.type === 'tool' && b.toolCallId === delta.toolCallId
            )
            const toolBlock = blockIdx !== -1 && sourceBlocks[blockIdx].type === 'tool'
              ? sourceBlocks[blockIdx]
              : null
            // 最终 tool_call 会删除 argumentsRaw；此后缓冲区迟到的 partial 只能丢弃，
            // 否则残缺解析结果会覆盖已确认的完整 arguments。
            if (toolBlock && toolBlock.argumentsRaw === undefined) continue

            const prevRaw = nextStreaming[delta.toolCallId] ?? ''
            const nextRaw = prevRaw + delta.delta
            nextStreaming[delta.toolCallId] = nextRaw
            streamingChanged = true

            if (sealedBlocks === undefined) sealedBlocks = msg.blocks ? [...msg.blocks] : []
            const partialArgs = toolBlock
              ? parsePartialToolArgs(toolBlock.toolName, nextRaw)
              : null
            const sanitizedPartialArgs = partialArgs !== null && toolBlock
              ? sanitizeToolInput(toolBlock.toolName, partialArgs)
              : partialArgs

            if (toolBlock && sanitizedPartialArgs !== null) {
              sealedBlocks[blockIdx] = {
                ...toolBlock,
                arguments: sanitizedPartialArgs,
                argumentsRaw: nextRaw
              } as RendererToolBlock
            }

            if (workingToolCalls && toolBlock && sanitizedPartialArgs !== null) {
              workingToolCalls = workingToolCalls.map(tc =>
                tc.id === delta.toolCallId
                  ? { ...tc, arguments: sanitizedPartialArgs, argumentsRaw: nextRaw }
                  : tc
              )
            } else if (workingToolCalls && !toolBlock) {
              // tool_call_start 可能晚于 partial delta；先保留 raw，之后创建占位块时才不会丢失进度。
              workingToolCalls = workingToolCalls.map(tc =>
                tc.id === delta.toolCallId
                  ? { ...tc, argumentsRaw: nextRaw }
                  : tc
              )
            }
            messageSealed = true
          }
        }

        if (messageSealed) {
          ensureMessagesCloned()
          nextMessages[idx] = bumpRevision({
            ...msg,
            content: workingContent,
            thinking: workingThinking,
            blocks: sealedBlocks ?? msg.blocks,
            toolCalls: workingToolCalls
          })
          messagesChanged = true
        }

        if (open) {
          if (nextLiveTurn === state.liveTurn) nextLiveTurn = { ...state.liveTurn }
          nextLiveTurn[messageId] = open
          liveTurnChanged = true
        } else if (existingLive) {
          if (nextLiveTurn === state.liveTurn) nextLiveTurn = { ...state.liveTurn }
          delete nextLiveTurn[messageId]
          liveTurnChanged = true
        }
      }

      const patch: Partial<ChatState> = {}
      if (messagesChanged) {
        // 仅封存/补壳/工具 delta 才写 messages（并经 commitMessageList 走窗口裁剪）；
        // 纯 text/thinking 不写 messages，故裁剪顺延到下一次写 messages 的边界——
        // 生成中的消息本就必须留在视窗内，短暂超过 240 上限无害。
        Object.assign(patch, commitMessageList(state, { nextMessages, nextIndex: nextMessageIndex }))
      }
      if (streamingChanged) patch.streamingToolArgs = nextStreaming
      if (liveTurnChanged) patch.liveTurn = nextLiveTurn
      return patch
    })
  }
  }
}
