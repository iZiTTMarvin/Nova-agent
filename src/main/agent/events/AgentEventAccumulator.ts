import type { AgentEvent } from '../../../runtime/agent'
import { readManifest } from '../../../runtime/checkpoints/manifest'
import type { SessionMessageAppend, AppendMessageResult } from '../../../runtime/sessions/types'
import { projectAssistantFieldsFromBlocks, MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE } from '../../../runtime/sessions/messageProjection'
import type { MessageBlock } from '../../../shared/session/types'
import { appendTerminalErrorToBlocks } from '../../../shared/session/terminalErrorBlocks'
import { runVerification } from '../../../runtime/verification/service'
import { formatVerificationSummary } from '../../../runtime/verification/format'
import { getSessionStore } from '../../services/SessionStoreHost'
import { getRunCoordinator } from '../../services/RunCoordinatorHost'
import type { MessageContext, StreamAccumulator } from './types'
import { awaitVerificationPermission } from './verificationPermissionWaiters'

/** 当前正在累积的流式消息映射：messageId → 累积器（按 turn identity fencing） */
export const activeStreams = new Map<string, StreamAccumulator>()

/** 把指定 run（或缺省全部）的 active stream 标记为 cancelled */
export function markActiveStreamsCancelled(runId?: string): void {
  for (const stream of activeStreams.values()) {
    if (!runId || stream.runId === runId) {
      stream.cancelled = true
    }
  }
}

/** turn finally：丢弃本 run/generation 残留 stream，防止 late event 污染下一 turn */
export function disposeTurnStreams(runId: string, executionGeneration?: number): void {
  for (const [messageId, stream] of activeStreams) {
    if (stream.runId !== runId) continue
    if (
      executionGeneration != null &&
      stream.executionGeneration !== executionGeneration
    ) {
      continue
    }
    activeStreams.delete(messageId)
  }
}

/** generation / run 不匹配的 late event 一律丢弃 */
function resolveStreamForEvent(
  messageId: string,
  ctx: MessageContext
): StreamAccumulator | null {
  const stream = activeStreams.get(messageId)
  if (!stream) return null
  if (ctx.runId && stream.runId && ctx.runId !== stream.runId) return null
  if (
    ctx.executionGeneration != null &&
    stream.executionGeneration !== 0 &&
    ctx.executionGeneration !== stream.executionGeneration
  ) {
    return null
  }
  return stream
}

/**
 * 累积流式事件内容
 */
export function accumulateStreamEvent(sessionId: string, event: AgentEvent, ctx: MessageContext): void {
  // 注意：tool_call_start / tool_call_delta 是流式增量事件，不写 stream 累积器。
  // 持久化只关心最终完整 tool_call（由 tool_call 事件写入），增量不落盘。
  // 累积器以有序 blocks 为唯一事实源；content/toolCalls 仅在 message_end 投影。
  switch (event.type) {
    case 'message_start': {
      activeStreams.set(event.messageId, {
        blocks: [],
        cancelled: false,
        runId: ctx.runId ?? '',
        executionGeneration: ctx.executionGeneration ?? 0,
        sessionId,
        messageId: event.messageId
      })
      break
    }
    case 'thinking_delta': {
      const stream = resolveStreamForEvent(event.messageId, ctx)
      if (stream) {
        const last = stream.blocks[stream.blocks.length - 1]
        if (last && last.type === 'thinking') {
          last.content += event.delta
        } else {
          stream.blocks.push({
            type: 'thinking',
            content: event.delta,
            ...(event.providerId ? { providerId: event.providerId } : {})
          })
        }
      }
      break
    }
    case 'text_delta': {
      const stream = resolveStreamForEvent(event.messageId, ctx)
      if (stream) {
        const last = stream.blocks[stream.blocks.length - 1]
        if (last && last.type === 'text') {
          last.content += event.delta
        } else {
          stream.blocks.push({ type: 'text', content: event.delta })
        }
      }
      break
    }
    case 'tool_call': {
      const stream = resolveStreamForEvent(event.messageId, ctx)
      if (stream) {
        stream.blocks.push({
          type: 'tool',
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          arguments: event.args,
          status: 'running'
        })
        // 工具参数就绪即落盘草稿，崩溃后可恢复「已准备未执行」边界
        persistTurnDraft(ctx.runId, event.messageId, stream.blocks, false, ctx.executionGeneration)
      }
      break
    }
    case 'tool_result': {
      const stream = resolveStreamForEvent(event.messageId, ctx)
      if (stream) {
        const isError = event.result.startsWith('工具执行失败') || event.result.startsWith('权限拒绝:')
        const blockIdx = stream.blocks.findIndex(b => b.type === 'tool' && b.toolCallId === event.toolCallId)
        if (blockIdx !== -1 && stream.blocks[blockIdx].type === 'tool') {
          const block = stream.blocks[blockIdx]
          stream.blocks[blockIdx] = {
            ...block,
            status: isError ? 'error' : 'success',
            result: event.result
          } as typeof block
        }
        // 工具结果边界：turnDraft 是执行中唯一事实源（fsync via RunStore）
        persistTurnDraft(ctx.runId, event.messageId, stream.blocks, false, ctx.executionGeneration)
      }
      // 异步调度：让 tool_result 当前的 EventBus 调用栈（含其他订阅者、IPC 转发）
      // 先全部跑完，避免 manifest 读盘阻塞下一个 thinking_delta 的处理。
      scheduleLiveDiffUpdate(sessionId, event.messageId, ctx)
      break
    }
    case 'message_end': {
      const stream = resolveStreamForEvent(event.messageId, ctx)
      if (stream) {
        activeStreams.delete(event.messageId)

        // cancel 期间残留的"权限拒绝"工具块不应进入持久化历史
        const blocks = stream.cancelled
          ? dropPermissionDeniedResidualBlocks(stream.blocks)
          : stream.blocks

        // 所有权转移协议：
        // turnDraft(active) → SessionStore 幂等追加成功 → message_finalized → clear turnDraft
        // 不得在 SessionStore 成功前标 finalized / clear
        try {
          finalizeAssistantTurn(sessionId, ctx.runId, event.messageId, blocks, event.interrupted, ctx.executionGeneration)
        } catch (err) {
          console.error('[message_end] finalize 失败，保留 turnDraft:', err)
          if (ctx.runId) {
            try {
              getRunCoordinator().commitTerminal({
                runId: ctx.runId,
                status: 'interrupted',
                reason: err instanceof Error ? err.message : 'finalize_failed'
              })
            } catch { /* ignore */ }
          }
        }
        triggerVerificationIfNeeded(sessionId, event.messageId, ctx)
      }
      break
    }
    case 'error': {
      // 终态错误：必须保留本轮已成功产出（正文/工具），再附加错误说明后落盘。
      // 禁止只存 error 字符串并丢掉 blocks（用户会感觉「保护把回复弄没了」）。
      const stream = resolveStreamForEvent(event.messageId, ctx)
      if (stream) {
        activeStreams.delete(event.messageId)
        let blocks = stream.cancelled
          ? dropPermissionDeniedResidualBlocks(stream.blocks)
          : [...stream.blocks]

        // attempt_failed 可能已清空内存块；用 turnDraft（工具边界已 fsync）回补
        if (blocks.length === 0 && ctx.runId) {
          const draft = getRunCoordinator().getSnapshot(ctx.runId)?.turnDraft
          if (draft?.blocks?.length) {
            blocks = draft.blocks as unknown as MessageBlock[]
          }
        }

        const finalBlocks = appendTerminalErrorToBlocks(blocks, event.error)
        try {
          finalizeAssistantTurn(
            sessionId,
            ctx.runId,
            event.messageId,
            finalBlocks,
            true,
            ctx.executionGeneration
          )
        } catch (err) {
          console.error('[error] finalize 失败，回退仅存错误文案:', err)
          saveErrorMessage(sessionId, event.messageId, event.error)
        }
      } else {
        saveErrorMessage(sessionId, event.messageId, event.error)
      }
      break
    }
    case 'attempt_failed': {
      // 失败 attempt：只丢掉本 attempt 末尾未完成输出，保留已完成的 tool 轮次
      const stream = resolveStreamForEvent(event.messageId, ctx)
      if (stream) {
        stream.blocks = retainCommittedBlocksForRetry(stream.blocks)
      }
      break
    }
  }
}

/**
 * 重试前保留已提交的工具轮次（含其前序 thinking/text）。
 * 丢掉末尾 running 工具与其后的临时 text/thinking，避免与下一 attempt 重复。
 */
function retainCommittedBlocksForRetry(blocks: MessageBlock[]): MessageBlock[] {
  let lastCommittedTool = -1
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (b.type === 'tool' && b.status !== 'running') {
      lastCommittedTool = i
    }
  }
  if (lastCommittedTool >= 0) {
    return blocks.slice(0, lastCommittedTool + 1)
  }
  // 尚无完成的工具：整段都是本 attempt 临时输出，可清空
  return []
}

/**
 * 工具执行完成后实时点亮前端的占位信号
 *
 * 只读 checkpoint manifest 的文件清单，不计算 LCS（重活留给 message_end 后的
 * get-message-diffs 路径，避免在事件循环里阻塞。Renderer 收到 phase: 'live'
 * 会进入 loading skeleton 状态，不渲染 +X -Y 中间值。
 *
 * 竞态保护：本函数被 setImmediate 异步调度。若在排队期间 message_end 已经
 * 把累积器从 activeStreams 删除，说明 renderer 这边的 loadMessageDiffs 已经
 * 拿到 final 数据写入了 messageDiffs；此时再 emit 一个 live 占位会把真实
 * 数据压回骨架，且没有后续 final 来恢复。直接跳过即可。
 */
function emitLiveDiffUpdate(sessionId: string, messageId: string, ctx: MessageContext): void {
  if (!activeStreams.has(messageId)) return

  try {
    const manifest = readManifest(ctx.sessionsDir, sessionId, messageId)
    if (!manifest || manifest.status !== 'active') return

    const reviews = manifest.fileReviews ?? {}
    const liveDiffs: Array<{ filePath: string; status: 'added' | 'modified' | 'deleted' }> = [
      ...manifest.modifiedFiles.map(filePath => ({ filePath, status: 'modified' as const })),
      ...manifest.createdFiles.map(filePath => ({ filePath, status: 'added' as const })),
      ...manifest.deletedFiles.map(filePath => ({ filePath, status: 'deleted' as const }))
    ]

    if (liveDiffs.length === 0) return

    ctx.eventBus.emit({
      type: 'diff_update',
      messageId,
      phase: 'live',
      diffs: liveDiffs,
      reviews
    })
  } catch (err) {
    console.error('实时 diff 占位更新失败:', err)
  }
}

/**
 * 异步调度 emitLiveDiffUpdate。
 *
 * 用 setImmediate 把 manifest 读盘 + emit 推到下一个事件循环 tick，让 tool_result
 * 当前的 EventBus 监听器链（forwardEventToRenderer、本累积器等）先全部跑完。
 * 这样后续 thinking_delta 不会被 IO/emit 同步阻塞。
 *
 * 同时埋点 tool_result → diff_update 之间的间隔，便于排查阻塞回归。
 */
function scheduleLiveDiffUpdate(sessionId: string, messageId: string, ctx: MessageContext): void {
  const t0 = performance.now()
  setImmediate(() => {
    emitLiveDiffUpdate(sessionId, messageId, ctx)
    const dt = performance.now() - t0
    if (dt > 50) {
      console.warn(`[perf] tool_result → diff_update: ${dt.toFixed(1)}ms (>50ms)`)
    } else {
      console.debug(`[perf] tool_result → diff_update: ${dt.toFixed(1)}ms`)
    }
  })
}

/**
 * 基于 checkpoint manifest 判断本轮是否有真实文件修改
 */
function hasRealModifications(sessionsDir: string, sessionId: string, messageId: string): boolean {
  const manifest = readManifest(sessionsDir, sessionId, messageId)
  if (!manifest) return false
  return (
    manifest.createdFiles.length > 0 ||
    manifest.modifiedFiles.length > 0 ||
    manifest.deletedFiles.length > 0
  )
}

/**
 * 触发验证：所有状态通过参数传入，不依赖全局变量
 */
export function triggerVerificationIfNeeded(
  sessionId: string,
  messageId: string,
  ctx: MessageContext
): void {
  // 基于 checkpoint manifest 判定是否有真实文件修改
  const hasModifications = hasRealModifications(ctx.sessionsDir, sessionId, messageId)
  if (!hasModifications) return

  // 异步执行验证，不阻塞主流程
  // 所有状态已在闭包中捕获，不会因后续操作串线
  const verifyAsync = async () => {
    try {
      const result = await runVerification({
        workingDir: ctx.workspaceRoot,
        mode: ctx.mode,
        permissionPolicy: ctx.permissionPolicy,
        hasModifications: true,
        // default 模式：通过 EventBus → IPC 推送到 renderer 等待用户确认
        permissionCallback: async (command: string): Promise<boolean> => {
          return awaitVerificationPermission({
            messageId,
            runId: ctx.runId ?? '',
            command,
            eventBus: ctx.eventBus
          })
        }
      })

      if (!result) return

      const summary = formatVerificationSummary(result)

      ctx.eventBus.emit({
        type: 'verification_result',
        messageId,
        result: summary
      })

      appendVerificationSummary(sessionId, messageId, summary)
    } catch (err) {
      console.error('验证执行失败:', err)
    }
  }

  verifyAsync()
}

/** 将验证摘要追加到已保存的 assistant 消息（append-only patch，不重写全历史） */
function appendVerificationSummary(sessionId: string, messageId: string, summary: string): void {
  const sessionStore = getSessionStore()
  sessionStore.appendMessagePatch(sessionId, messageId, { verificationSummary: summary })
}

/** 保存完整的 assistant 消息到会话存储（blocks 为事实源，content/toolCalls 为投影） */
function saveAssistantMessage(
  sessionId: string,
  messageId: string,
  blocks: MessageBlock[],
  interrupted?: boolean
): AppendMessageResult {
  const sessionStore = getSessionStore()
  const projected = projectAssistantFieldsFromBlocks(blocks)
  const assistantMessage: SessionMessageAppend = {
    id: messageId,
    role: 'assistant',
    content: projected.content,
    toolCalls: projected.toolCalls,
    blocks: projected.blocks.length > 0 ? projected.blocks : undefined,
    messageSchemaVersion: MESSAGE_SCHEMA_VERSION_BLOCKS_SOURCE,
    timestamp: Date.now(),
    ...(interrupted ? { interrupted: true } : {})
  }
  return sessionStore.appendMessageFast(sessionId, assistantMessage)
}

/**
 * 所有权转移：SessionStore 成功后才标 finalized 并清草稿。
 * 失败时保留 draft，由调用方将 run 标为 interrupted。
 */
function finalizeAssistantTurn(
  sessionId: string,
  runId: string | undefined,
  messageId: string,
  blocks: MessageBlock[],
  interrupted?: boolean,
  executionGeneration?: number
): void {
  // 1) 确保草稿仍为 active（未 finalized）
  if (runId) {
    persistTurnDraft(runId, messageId, blocks, false, executionGeneration)
  }

  // 2) SessionStore 幂等追加
  const appendResult = saveAssistantMessage(sessionId, messageId, blocks, interrupted)
  if (!appendResult.ok) {
    throw new Error(`SessionStore 追加失败: ${appendResult.error}`)
  }

  // 3) 写 message_finalized receipt（turnDraft.finalized=true）
  if (runId) {
    persistTurnDraft(runId, messageId, blocks, true, executionGeneration)
    // 4) 清除草稿
    getRunCoordinator().clearTurnDraft(runId)
  }
}

/**
 * 工具边界：把当前 blocks 写入 RunSnapshot.turnDraft（fsync）。
 * 执行中唯一事实源；SessionStore 仅在 finalize 后接手。
 * generation 失效后拒绝写入，防止 lingering continuation 覆盖。
 */
function persistTurnDraft(
  runId: string | undefined,
  messageId: string,
  blocks: MessageBlock[],
  finalized = false,
  executionGeneration?: number
): void {
  if (!runId) return
  const coord = getRunCoordinator()
  if (
    executionGeneration != null &&
    !coord.isExecutionCurrent(runId, executionGeneration)
  ) {
    console.warn(
      `[persistTurnDraft] generation 已失效，拒绝写入 runId=${runId} gen=${executionGeneration}`
    )
    return
  }
  // 落盘失败必须抛出，不得吞掉后继续宣称可恢复
  coord.upsertTurnDraft(runId, {
    messageId,
    blocks: blocks as unknown as Array<Record<string, unknown>>,
    finalized
  })
}

/** SessionStore 写入成功后清除草稿，完成所有权转移 */
function clearTurnDraftAfterFinalize(runId: string | undefined): void {
  if (!runId) return
  try {
    getRunCoordinator().clearTurnDraft(runId)
  } catch {
    /* ignore */
  }
}

/**
 * 兜底过滤：剔除"权限拒绝: 用户拒绝"残留 tool 块。
 * 只剔除用户拒绝产生的条目，保留模式策略引发的拒绝。
 */
function dropPermissionDeniedResidualBlocks(blocks: MessageBlock[]): MessageBlock[] {
  return blocks.filter(b => {
    if (b.type !== 'tool') return true
    const result = b.result ?? ''
    return !(result.startsWith('权限拒绝:') && result.includes('用户拒绝'))
  })
}

/** 保存错误消息到会话存储 */
function saveErrorMessage(sessionId: string, messageId: string, error: string): void {
  const sessionStore = getSessionStore()
  const errorMessage: SessionMessageAppend = {
    id: messageId,
    role: 'assistant',
    content: error,
    timestamp: Date.now()
  }
  const result = sessionStore.appendMessageFast(sessionId, errorMessage)
  if (!result.ok) {
    throw new Error(`错误消息持久化失败: ${result.error}`)
  }
}
