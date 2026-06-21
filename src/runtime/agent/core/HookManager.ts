/**
 * HookManager — Runtime 内部生命周期干预层
 * 与 EventBus 并行：EventBus 负责观察，HookManager 负责拦截与变换
 */
import type { ChatMessage } from '../../model/types'
import type { EventBus } from '../EventBus'
import type { HookEvent as ExportedHookEvent } from '../types'

/** 9 个固定 hook 事件白名单 */
export type HookEvent = ExportedHookEvent

/** 各事件 handler 的返回类型映射 */
export interface HookEventResultMap {
  onMessageStart: void
  beforeAgentStart: { messages?: ChatMessage[]; systemPrompt?: string } | undefined
  preChat: { messages?: ChatMessage[] } | undefined
  context: { messages?: ChatMessage[] } | undefined
  preToolUse: { block?: boolean; reason?: string; modifiedArgs?: Record<string, unknown> } | undefined
  postToolUse: { content?: string; isError?: boolean } | undefined
  postMessage: void
  onError: void
  onCancel: void
}

/** 按 event 字段区分的入参联合类型 */
export type HookPayload =
  | { event: 'onMessageStart'; messageId: string; text: string }
  | { event: 'beforeAgentStart'; messageId: string; prompt: string; systemPrompt: string }
  | { event: 'preChat'; messageId: string; messages: ChatMessage[] }
  | { event: 'context'; messageId: string; messages: ChatMessage[] }
  | { event: 'preToolUse'; messageId: string; toolCallId: string; toolName: string; toolArgs: Record<string, unknown> }
  | { event: 'postToolUse'; messageId: string; toolCallId: string; toolName: string; toolResult: string; isError: boolean }
  | { event: 'postMessage'; messageId: string; message: ChatMessage }
  | { event: 'onError'; messageId: string; error: string }
  | { event: 'onCancel'; messageId: string; interrupted: true }

/** Handler 签名：可同步或异步返回结果 */
export type HookHandler<E extends HookEvent> = (
  payload: Extract<HookPayload, { event: E }>
) => HookEventResultMap[E] | Promise<HookEventResultMap[E]>

const TRANSFORM_EVENTS = new Set<HookEvent>(['beforeAgentStart', 'preChat', 'context'])
const PATCH_EVENTS = new Set<HookEvent>(['postToolUse'])

export class HookManager {
  private handlers = new Map<HookEvent, HookHandler<HookEvent>[]>()
  private eventBus?: EventBus

  /** 可选注入 EventBus，用于发射 hook_error 事件 */
  constructor(eventBus?: EventBus) {
    this.eventBus = eventBus
  }

  /** 注册 handler，返回取消函数 */
  on<E extends HookEvent>(event: E, handler: HookHandler<E>): () => void {
    const list = this.handlers.get(event) ?? []
    list.push(handler as unknown as HookHandler<HookEvent>)
    this.handlers.set(event, list)
    return () => {
      const idx = list.indexOf(handler as unknown as HookHandler<HookEvent>)
      if (idx >= 0) list.splice(idx, 1)
    }
  }

  /** 触发 hook，按事件类型选择执行策略 */
  async trigger<E extends HookEvent>(
    payload: Extract<HookPayload, { event: E }>
  ): Promise<HookEventResultMap[E]> {
    const list = this.handlers.get(payload.event) ?? []
    if (payload.event === 'preToolUse') {
      return await this.runPreToolUse(list, payload as Extract<HookPayload, { event: 'preToolUse' }>) as HookEventResultMap[E]
    }
    if (TRANSFORM_EVENTS.has(payload.event)) {
      return await this.runTransform(list, payload) as HookEventResultMap[E]
    }
    if (PATCH_EVENTS.has(payload.event)) {
      return await this.runPatch(list, payload) as HookEventResultMap[E]
    }
    for (const h of list) await this.safeCall(h, payload)
    return undefined as HookEventResultMap[E]
  }

  /** 清除指定事件或全部 handler */
  clear(event?: HookEvent): void {
    if (event) this.handlers.delete(event)
    else this.handlers.clear()
  }

  /** 统计已注册 handler 数量 */
  count(event?: HookEvent): number {
    if (event) return this.handlers.get(event)?.length ?? 0
    let n = 0
    for (const list of this.handlers.values()) n += list.length
    return n
  }

  private async safeCall(
    handler: HookHandler<HookEvent>,
    payload: HookPayload
  ): Promise<unknown> {
    try {
      return await handler(payload as never)
    } catch (error) {
      const err = error instanceof Error ? error.message : String(error)
      console.error(`[HookManager] Handler error on "${payload.event}": ${err}`)
      this.eventBus?.emit({
        type: 'hook_error',
        messageId: payload.messageId,
        hookEvent: payload.event,
        error: err
      })
      return undefined
    }
  }

  /** 提前退出策略：首个 block 立即终止 */
  private async runPreToolUse(
    list: HookHandler<HookEvent>[],
    payload: Extract<HookPayload, { event: 'preToolUse' }>
  ): Promise<HookEventResultMap['preToolUse']> {
    let mergedArgs: Record<string, unknown> | undefined
    for (const h of list) {
      const r = await this.safeCall(h, payload) as HookEventResultMap['preToolUse']
      if (r?.modifiedArgs) mergedArgs = { ...mergedArgs, ...r.modifiedArgs }
      if (r?.block) return { block: true, reason: r.reason, modifiedArgs: mergedArgs }
    }
    return mergedArgs ? { modifiedArgs: mergedArgs } : undefined
  }

  /** 顺序变换策略：后者覆盖前者 */
  private async runTransform(
    list: HookHandler<HookEvent>[],
    payload: HookPayload
  ): Promise<Record<string, unknown> | undefined> {
    let acc: Record<string, unknown> = {}
    for (const h of list) {
      const r = await this.safeCall(h, payload)
      if (r && typeof r === 'object') acc = { ...acc, ...r }
    }
    return Object.keys(acc).length > 0 ? acc : undefined
  }

  /** 累积 patch 策略 */
  private async runPatch(
    list: HookHandler<HookEvent>[],
    payload: HookPayload
  ): Promise<HookEventResultMap['postToolUse']> {
    let content: string | undefined
    let isError: boolean | undefined
    for (const h of list) {
      const r = await this.safeCall(h, payload) as HookEventResultMap['postToolUse']
      if (r?.content !== undefined) content = r.content
      if (r?.isError !== undefined) isError = r.isError
    }
    return content !== undefined || isError !== undefined ? { content, isError } : undefined
  }
}
