/**
 * streamDeltaBuffer — 高频 SSE delta 的时间窗口缓冲
 *
 * 解决：每个 SSE chunk 直接穿透到 store 会触发 React 高频重渲染。
 * 方案：把 chunk 按时间窗口聚合成批量 delta，再统一 flush 到 store。
 *
 * 缓冲策略：
 * - 文本（text + thinking）：~16ms 刷新间隔（≈60fps），保证文本流"跟得上嘴"
 * - 工具输入（toolCall arguments）：~300ms 刷新间隔，partial JSON 解析本身有开销
 *
 * 关键时刻（flushNow 触发点）：
 * - message_end：保证最后内容不滞留
 * - error：异常时立即展示
 * - thinking→text 切换：第一次 pushText 时若最近 push 的是 thinking，
 *   立即 flushNow 把思考内容刷出去，确保 block 顺序正确（避免跨帧导致
 *   thinking 和 text 块被分散到两次 setState）
 *
 * 单一 buffer 绑定单一会话（单 session 设计），不复用 OpenCowork 的多 session 模型。
 */
import type { StreamDelta, StreamDeltaBatch } from '../stores/useChatStore'

/** 文本类（thinking / text）刷新间隔：60fps */
const TEXT_FLUSH_MS = 16
/** 工具参数刷新间隔：partial 解析较慢，可容忍 300ms 延迟 */
const TOOL_INPUT_FLUSH_MS = 300

export interface StreamDeltaBuffer {
  /** 推入 thinking delta。内部按时间窗口聚合 */
  pushThinking: (messageId: string, delta: string) => void
  /** 推入 text delta。内部按时间窗口聚合；首次 push 时若紧跟 thinking 则 flushNow */
  pushText: (messageId: string, delta: string) => void
  /** 推入 tool call 参数 delta。内部按时间窗口聚合 */
  pushToolCallDelta: (messageId: string, toolCallId: string, delta: string) => void
  /**
   * 立即 flush 所有待发 delta。
   * 调用场景：message-end、error、dispose 之前
   */
  flushNow: () => void
  /**
   * 清理资源：取消所有 timer、清空 buffer。
   * 调用后 buffer 不可再使用，需要重新创建。
   */
  dispose: () => void
}

/**
 * 创建流式 delta 缓冲。
 * 工厂模式：每个流式会话一个 buffer，dispose 后重新创建。
 *
 * 切换点处理：第一次 pushText 时若最近有未刷出的 thinking delta，
 * 立即 flushNow 把思考内容刷出去，确保 thinking→text 块顺序正确。
 */
export function createStreamDeltaBuffer(
  onFlush: (deltas: StreamDeltaBatch) => void
): StreamDeltaBuffer {
  /** 待 flush 的 delta 队列 */
  const pending: StreamDelta[] = []
  let textTimer: ReturnType<typeof setTimeout> | null = null
  let toolTimer: ReturnType<typeof setTimeout> | null = null
  /** 标记 buffer 是否已 dispose（dispose 后所有方法 no-op） */
  let disposed = false
  /** 跟踪最近一次 push 的 kind，用于检测 thinking→text 切换 */
  let lastTextKind: 'thinking' | 'text' | null = null

  function scheduleTextFlush(): void {
    if (textTimer !== null || disposed) return
    textTimer = setTimeout(() => {
      textTimer = null
      if (disposed) return
      flushNow()
    }, TEXT_FLUSH_MS)
  }

  function scheduleToolFlush(): void {
    if (toolTimer !== null || disposed) return
    toolTimer = setTimeout(() => {
      toolTimer = null
      if (disposed) return
      flushNow()
    }, TOOL_INPUT_FLUSH_MS)
  }

  function flushNow(): void {
    if (textTimer !== null) {
      clearTimeout(textTimer)
      textTimer = null
    }
    if (toolTimer !== null) {
      clearTimeout(toolTimer)
      toolTimer = null
    }
    if (pending.length === 0) return
    const batch = pending.splice(0, pending.length)
    // 重置切换点：flush 后队列清空，下次 pushText 不会再触发"切换"
    lastTextKind = null
    onFlush(batch)
  }

  return {
    pushThinking: (messageId, delta) => {
      if (disposed || !delta) return
      pending.push({ kind: 'thinking', messageId, delta })
      lastTextKind = 'thinking'
      scheduleTextFlush()
    },
    pushText: (messageId, delta) => {
      if (disposed || !delta) return
      // Phase 2 切换点：第一次 pushText 且最近 push 的是 thinking →
      // 立即 flushNow 把思考内容刷出去，确保 thinking→text 块在 store 中按顺序追加。
      if (lastTextKind === 'thinking' && pending.some(d => d.kind === 'thinking')) {
        flushNow()
      }
      pending.push({ kind: 'text', messageId, delta })
      lastTextKind = 'text'
      scheduleTextFlush()
    },
    pushToolCallDelta: (messageId, toolCallId, delta) => {
      if (disposed || !delta) return
      pending.push({ kind: 'toolCall', messageId, toolCallId, delta })
      scheduleToolFlush()
    },
    flushNow,
    dispose: () => {
      // dispose 之前 flushNow 一次，保证已 push 但未到期的 delta 不丢失
      if (!disposed) {
        flushNow()
      }
      disposed = true
      pending.length = 0
      lastTextKind = null
    }
  }
}
