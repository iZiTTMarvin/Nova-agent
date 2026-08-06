/**
 * Mid-turn 安全可折叠前缀选择器。
 * 永不切断 tool call/result 对，永不覆盖 partial，找不到安全前缀时显式失败（不抛异常）。
 */
import type { ChatMessage } from '../../model/types'

export interface MidTurnBoundaryOptions {
  /** 保留为原文 tail 的最少尾部消息数；默认 1 */
  reserveTailMessages?: number
  /** partial / 流式未完成内容：切点必须严格落在其之前 */
  isPartial?: (message: ChatMessage, index: number) => boolean
  /** 钉住消息：切点必须严格落在其之前（与 partial 同效） */
  isPinned?: (message: ChatMessage, index: number) => boolean
}

export type MidTurnBoundary =
  | { ok: true; coveredCount: number }
  | { ok: false; reason: 'no_safe_completed_span' }

interface ToolPairSpan {
  callIndex?: number
  responseIndex?: number
}

/**
 * 选出最大可安全压缩前缀（coveredCount 为 exclusive 切点）。
 * 入参应为已去掉 system 的消息序列。
 */
export function selectMidTurnSafeBoundary(
  messages: readonly ChatMessage[],
  options: MidTurnBoundaryOptions = {}
): MidTurnBoundary {
  const reserveTail = Math.max(0, Math.floor(options.reserveTailMessages ?? 1))
  const firstPartialIndex = options.isPartial
    ? messages.findIndex((message, index) => options.isPartial!(message, index))
    : -1
  const firstPinnedIndex = options.isPinned
    ? messages.findIndex((message, index) => options.isPinned!(message, index))
    : -1
  const maxCut = Math.min(
    messages.length - reserveTail,
    firstPartialIndex === -1 ? messages.length : firstPartialIndex,
    firstPinnedIndex === -1 ? messages.length : firstPinnedIndex
  )
  const pairSpans = toolPairSpans(messages)
  for (let cut = maxCut; cut >= 1; cut -= 1) {
    if (straddlesToolPair(pairSpans, cut)) continue
    return { ok: true, coveredCount: cut }
  }
  return { ok: false, reason: 'no_safe_completed_span' }
}

function toolPairSpans(messages: readonly ChatMessage[]): ToolPairSpan[] {
  const byCallId = new Map<string, ToolPairSpan>()
  messages.forEach((message, index) => {
    if (message.role === 'assistant' && message.toolCalls) {
      for (const call of message.toolCalls) {
        const span = byCallId.get(call.id) ?? {}
        span.callIndex = index
        byCallId.set(call.id, span)
      }
    } else if (message.role === 'tool' && message.toolCallId) {
      const span = byCallId.get(message.toolCallId) ?? {}
      span.responseIndex = index
      byCallId.set(message.toolCallId, span)
    }
  })
  return [...byCallId.values()]
}

/**
 * cut 为 exclusive 下标。覆盖 call 但未覆盖其 result、或覆盖尚未落地的 open call，均不安全。
 */
function straddlesToolPair(spans: readonly ToolPairSpan[], cut: number): boolean {
  for (const span of spans) {
    if (span.callIndex !== undefined && span.responseIndex === undefined) {
      if (span.callIndex < cut) return true
      continue
    }
    if (span.callIndex === undefined || span.responseIndex === undefined) continue
    const callCovered = span.callIndex < cut
    const responseCovered = span.responseIndex < cut
    if (callCovered !== responseCovered) return true
  }
  return false
}
