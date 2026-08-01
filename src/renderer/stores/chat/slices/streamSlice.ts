import { sanitizeToolInput, sanitizeToolOutput } from '../../../../shared/tool-input-sanitizer'
import { parsePartialToolArgs } from '../../../lib/partialJsonArgs'
import { createAssistantMessage } from '../../../lib/focusedSessionRecovery'
import type {
  ExtendedToolCall,
  RendererMessageBlock,
  RendererToolBlock
} from '../types'
import {
  bumpRevision,
  commitMessageList,
  emptyStreamTransientState,
  stripInlinePseudoToolCalls
} from '../internal'
import type {
  ChatSliceCreator,
  ChatState,
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

export const createStreamSlice: ChatSliceCreator<StreamSliceState> = (set, get) => ({
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
      // 失败 attempt 的临时流式内容不能和下一次重试混合；已成功落盘的 tool_result
      // 也不属于这次失败 attempt，因此一起清空并保留原消息壳。
      const next = [...state.messages]
      next[idx] = {
        ...msg,
        content: '',
        thinking: '',
        toolCalls: [],
        blocks: [],
        _revision: (msg._revision ?? 0) + 1
      }
      return commitMessageList(state, { nextMessages: next, nextIndex: state.messageIndexById, skipWindowTrim: true })
    })
  },

  handleThinkingDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const blocks = msg.blocks ? [...msg.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'thinking') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
      } else {
        blocks.push({ type: 'thinking', content: delta })
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, thinking: (msg.thinking ?? '') + delta, blocks })
      return commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true })
    })
  },

  handleTextDelta: (messageId: string, delta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state
      const blocks = msg.blocks ? [...msg.blocks] : []
      const last = blocks[blocks.length - 1]
      if (last && last.type === 'text') {
        blocks[blocks.length - 1] = { ...last, content: last.content + delta }
      } else {
        blocks.push({ type: 'text', content: delta })
      }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, content: msg.content + delta, blocks })
      return commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true })
    })
  },

  handleToolCall: (messageId: string, toolCallId: string, toolName: string, args: Record<string, unknown>) => {
    const sanitizedArgs = sanitizeToolInput(toolName, args)
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

      const cleanedMessage = stripInlinePseudoToolCalls(msg.content, msg.blocks ? [...msg.blocks] : [])
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

      const toolCalls = msg.toolCalls ? [...msg.toolCalls] : []
      const tcIdx = toolCalls.findIndex(tc => tc.id === toolCallId)
      if (tcIdx !== -1) {
        const { argumentsRaw: _tcDrop, ...restTc } = toolCalls[tcIdx]
        toolCalls[tcIdx] = { ...restTc, name: toolName, arguments: sanitizedArgs }
      } else {
        toolCalls.push(newToolCall)
      }

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, content: cleanedMessage.content, toolCalls, blocks })
      const { [toolCallId]: _drop2, ...restStreaming } = state.streamingToolArgs
      return {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        streamingToolArgs: restStreaming
      }
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

      const blocks: RendererMessageBlock[] = msg.blocks ? [...msg.blocks] : []
      blocks.push({
        type: 'tool',
        toolCallId,
        toolName,
        arguments: {},
        status: 'running',
        argumentsRaw: ''
      })

      const toolCalls = msg.toolCalls ? [...msg.toolCalls, placeholder] : [placeholder]
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, toolCalls, blocks })

      return {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: '' }
      }
    })
  },

  handleToolCallDelta: (messageId: string, toolCallId: string, argumentsDelta: string) => {
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const prevRaw = state.streamingToolArgs[toolCallId] ?? ''
      const nextRaw = prevRaw + argumentsDelta
      const existingBlock = msg.blocks?.find(
        b => b.type === 'tool' && b.toolCallId === toolCallId
      )
      const toolName = existingBlock?.type === 'tool' ? existingBlock.toolName : ''
      const partialArgs = parsePartialToolArgs(toolName, nextRaw)

      const blocks: RendererMessageBlock[] = msg.blocks ? [...msg.blocks] : []
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

      const toolCalls = msg.toolCalls ? msg.toolCalls.map(tc =>
        tc.id === toolCallId
          ? { ...tc, arguments: partialArgs, argumentsRaw: nextRaw }
          : tc
      ) : msg.toolCalls

      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, blocks, toolCalls })
      return {
        ...commitMessageList(state, { nextMessages, nextIndex: state.messageIndexById, skipWindowTrim: true }),
        streamingToolArgs: { ...state.streamingToolArgs, [toolCallId]: nextRaw }
      }
    })
  },

  handleToolResult: (messageId: string, toolCallId: string, _toolName: string, result: string) => {
    const isError = result.startsWith('工具执行失败') || result.startsWith('权限拒绝:')
    const sanitizedResult = sanitizeToolOutput(_toolName, result, isError)
    set(state => {
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const blocks = msg.blocks?.map(b => {
        if (b.type === 'tool' && b.toolCallId === toolCallId) {
          return { ...b, status: isError ? 'error' as const : 'success' as const, result: sanitizedResult }
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

  handleWorkflowProgress: (payload) => {
    set(state => {
      const messageId = state.currentGeneratingMessageId
      if (!messageId) return state
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg) return state

      const blocks: RendererMessageBlock[] = msg.blocks ? [...msg.blocks] : []
      blocks.push({
        type: 'workflow_progress',
        runId: payload.runId,
        phase: payload.phase,
        status: payload.status,
        ...(payload.detail ? { detail: payload.detail } : {})
      })
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, blocks })
      return commitMessageList(state, {
        nextMessages,
        nextIndex: state.messageIndexById,
        skipWindowTrim: true
      })
    })
  },

  handleWorkflowLog: (payload) => {
    set(state => {
      const messageId = state.currentGeneratingMessageId
      if (!messageId) return state
      const idx = state.messageIndexById[messageId]
      if (idx === undefined) return state
      const msg = state.messages[idx]
      if (!msg?.blocks?.length) return state

      // 附着到同 runId 的最后一个进度块：阶段 started 之后到达的活动行
      // 都归属于它；阶段结束后新块出现，后续活动行自然跟着新块走。
      let target = -1
      for (let i = msg.blocks.length - 1; i >= 0; i--) {
        const block = msg.blocks[i]
        if (block.type === 'workflow_progress' && block.runId === payload.runId) {
          target = i
          break
        }
      }
      if (target < 0) return state
      const block = msg.blocks[target]
      if (block.type !== 'workflow_progress' || block.activity === payload.message) return state

      const blocks = msg.blocks.slice()
      blocks[target] = { ...block, activity: payload.message }
      const nextMessages = state.messages.slice()
      nextMessages[idx] = bumpRevision({ ...msg, blocks })
      return commitMessageList(state, {
        nextMessages,
        nextIndex: state.messageIndexById,
        skipWindowTrim: true
      })
    })
  },

  applyStreamDeltas: (deltas: StreamDeltaBatch) => {
    if (deltas.length === 0) return

    // 同一帧内的所有 delta 必须在一次 set 中提交，避免每个片段各自触发订阅更新。
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

      if (!addedMissingMessage) {
        nextMessages = state.messages.slice()
      }
      const nextStreaming: Record<string, string> = { ...state.streamingToolArgs }
      let messagesChanged = false
      let streamingChanged = false

      for (const [messageId, messageDeltas] of byMessageId) {
        const idx = nextMessageIndex[messageId]
        if (idx === undefined) continue
        const msg = nextMessages[idx]
        if (!msg) continue

        let workingBlocks: RendererMessageBlock[] | undefined = msg.blocks ? [...msg.blocks] : undefined
        let workingToolCalls = msg.toolCalls
        let workingContent = msg.content
        let workingThinking = msg.thinking ?? ''

        for (const delta of messageDeltas) {
          if (delta.kind === 'thinking') {
            const blocks = workingBlocks ?? []
            const last = blocks[blocks.length - 1]
            if (last && last.type === 'thinking') {
              // 高频流式路径保留最后一个 block 的引用，避免每段内容都创建短生命周期对象。
              ;(last as { content: string }).content += delta.delta
            } else {
              blocks.push({ type: 'thinking', content: delta.delta })
            }
            workingBlocks = blocks
            workingThinking += delta.delta
          } else if (delta.kind === 'text') {
            const blocks = workingBlocks ?? []
            const last = blocks[blocks.length - 1]
            if (last && last.type === 'text') {
              // 与 thinking 同理，原地累加是流式渲染的 GC 预算约束。
              ;(last as { content: string }).content += delta.delta
            } else {
              blocks.push({ type: 'text', content: delta.delta })
            }
            workingBlocks = blocks
            workingContent += delta.delta
          } else {
            const blocks = workingBlocks ?? []
            const blockIdx = blocks.findIndex(
              b => b.type === 'tool' && b.toolCallId === delta.toolCallId
            )
            const toolBlock = blockIdx !== -1 && blocks[blockIdx].type === 'tool'
              ? blocks[blockIdx]
              : null
            // 最终 tool_call 会删除 argumentsRaw；此后缓冲区迟到的 partial 只能丢弃，
            // 否则残缺解析结果会覆盖已确认的完整 arguments。
            if (toolBlock && toolBlock.argumentsRaw === undefined) continue

            const prevRaw = nextStreaming[delta.toolCallId] ?? ''
            const nextRaw = prevRaw + delta.delta
            nextStreaming[delta.toolCallId] = nextRaw
            streamingChanged = true

            const partialArgs = toolBlock
              ? parsePartialToolArgs(toolBlock.toolName, nextRaw)
              : null
            const sanitizedPartialArgs = partialArgs !== null && toolBlock
              ? sanitizeToolInput(toolBlock.toolName, partialArgs)
              : partialArgs

            if (toolBlock && sanitizedPartialArgs !== null) {
              blocks[blockIdx] = {
                ...toolBlock,
                arguments: sanitizedPartialArgs,
                argumentsRaw: nextRaw
              } as RendererToolBlock
              workingBlocks = blocks
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
          }
        }

        nextMessages[idx] = bumpRevision({
          ...msg,
          content: workingContent,
          thinking: workingThinking,
          blocks: workingBlocks,
          toolCalls: workingToolCalls
        })
        messagesChanged = true
      }

      let finalResult: Partial<ChatState>
      if (messagesChanged) {
        finalResult = {
          ...commitMessageList(state, { nextMessages, nextIndex: nextMessageIndex }),
          ...(streamingChanged ? { streamingToolArgs: nextStreaming } : {})
        }
      } else {
        finalResult = {
          ...(streamingChanged ? { streamingToolArgs: nextStreaming } : {})
        }
      }

      return finalResult
    })
  }
})
