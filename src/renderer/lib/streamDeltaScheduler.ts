/**
 * streamDeltaScheduler — rAF 聚合层
 *
 * 位于 streamDeltaBuffer 与 useChatStore.applyStreamDeltas 之间。
 * 解决：即使 buffer 16ms 节流，如果同一帧内多次 flush（如 buffer flush + 手动
 * setState）仍会触发多次 React 重渲染。
 *
 * 工作原理：
 * - 所有 delta 先进入模块级 pending 队列
 * - scheduleFlush 安排一次 rAF
 * - rAF 回调一次性取出全部 delta，调用 applyStreamDeltas
 * - 已调度时不重复安排（rAF 期间的所有 push 都被同一帧吸收）
 *
 * 这层是纯前端逻辑、纯性能优化，不改变 store 数据语义。
 */
import type { StreamDelta, StreamDeltaBatch } from '../stores/useChatStore'

/** 模块级待发 delta 队列（按到达顺序） */
let _pendingDeltas: StreamDelta[] = []
/** rAF handle；非 null 表示已调度 */
let _rafHandle: number | null = null
/** rAF 在测试环境下可注入；null 时降级为 setTimeout 0 */
let _requestFrame: ((cb: () => void) => number) | null = null
let _cancelFrame: ((handle: number) => void) | null = null
/** 注入的 apply 回调：默认指向 useChatStore.applyStreamDeltas */
let _apply: ((batch: StreamDeltaBatch) => void) | null = null

/**
 * 注入 rAF 实现与 store apply 回调。供 App 启动时一次性注册。
 *
 * 必须在任何 push 调用之前注册。
 */
export function configureStreamDeltaScheduler(deps: {
  requestFrame: (cb: () => void) => number
  cancelFrame: (handle: number) => void
  apply: (batch: StreamDeltaBatch) => void
}): void {
  _requestFrame = deps.requestFrame
  _cancelFrame = deps.cancelFrame
  _apply = deps.apply
}

function flushNow(): void {
  if (_rafHandle !== null) {
    if (_cancelFrame) _cancelFrame(_rafHandle)
    _rafHandle = null
  }
  if (_pendingDeltas.length === 0) return
  const batch = _pendingDeltas
  _pendingDeltas = []
  if (_apply) {
    _apply(batch)
  }
}

/** 把一个 delta 推入待发队列，并安排 rAF flush */
function enqueue(delta: StreamDelta): void {
  _pendingDeltas.push(delta)
  scheduleFlush()
}

/** 安排一次 rAF。已调度时直接返回 */
function scheduleFlush(): void {
  if (_rafHandle !== null) return
  const request = _requestFrame
  if (request) {
    _rafHandle = request(flushNow)
  } else {
    // 兜底：未配置 rAF 时用 setTimeout 0 异步 flush
    _rafHandle = setTimeout(flushNow, 0) as unknown as number
  }
}

/** 直接推入 thinking delta */
export function pushThinkingDelta(messageId: string, delta: string): void {
  if (!delta) return
  enqueue({ kind: 'thinking', messageId, delta })
}

/** 直接推入 text delta */
export function pushTextDelta(messageId: string, delta: string): void {
  if (!delta) return
  enqueue({ kind: 'text', messageId, delta })
}

/** 直接推入 tool call 参数 delta */
export function pushToolCallDelta(messageId: string, toolCallId: string, delta: string): void {
  if (!delta) return
  enqueue({ kind: 'toolCall', messageId, toolCallId, delta })
}

/**
 * 统一的 delta 入口：接收任意 StreamDelta 对象（由 streamDeltaBuffer 投递）。
 * 与 pushXxxDelta 三个细分 API 行为一致，统一入口让 buffer 调用更简洁。
 */
export function scheduleStreamDelta(delta: StreamDelta): void {
  if (delta.kind === 'thinking') {
    if (!delta.delta) return
  } else if (delta.kind === 'text') {
    if (!delta.delta) return
  } else if (!delta.delta) {
    return
  }
  enqueue(delta)
}

/** 立即 flush 全部待发 delta。thinking→text 切换、message-end、error 时调用 */
export function flushStreamDeltasNow(): void {
  flushNow()
}

/** 清理：取消挂起的 rAF、清空队列。供测试 teardown */
export function resetStreamDeltaScheduler(): void {
  if (_rafHandle !== null) {
    if (_cancelFrame) _cancelFrame(_rafHandle)
    _rafHandle = null
  }
  _pendingDeltas = []
}
