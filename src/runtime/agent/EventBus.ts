/**
 * 类型安全的事件总线
 * runtime 内部解耦通信的核心机制，将 AgentLoop 产出的事件分发给所有订阅者
 * 订阅者包括：main 进程的 IPC 桥接、runtime 内部的日志等
 */
import type { AgentEvent, AgentEventCallback } from './types'

export class EventBus {
  private listeners: Set<AgentEventCallback> = new Set()

  /** 订阅所有事件，返回取消订阅函数 */
  on(callback: AgentEventCallback): () => void {
    this.listeners.add(callback)
    return () => {
      this.listeners.delete(callback)
    }
  }

  /** 发射事件给所有订阅者 */
  emit(event: AgentEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (err) {
        // 订阅者异常不应影响其他订阅者和主流程
        console.error('[EventBus] listener error:', err)
      }
    }
  }

  /** 移除所有监听器 */
  clear(): void {
    this.listeners.clear()
  }
}
