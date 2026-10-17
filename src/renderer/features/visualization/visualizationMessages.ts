/**
 * 可视化回传给模型的用户消息：交互事件与修复请求都以普通用户消息进入对话，
 * 与手动输入走同一条发送路径（运行中进入排队，空闲时直接发送）。
 */
import { useChatStore } from '../../stores/useChatStore'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'

const MAX_REPORTED_ERRORS = 5

export function formatVisualizationEventMessage(title: string, name: string, data: unknown): string {
  const header = `【可视化】${title} · ${name}`
  return data === null || data === undefined ? header : `${header}\n${JSON.stringify(data)}`
}

export function formatVisualizationRepairMessage(title: string, errors: readonly string[]): string {
  return [`【可视化报错】${title}`, ...errors.slice(0, MAX_REPORTED_ERRORS), '请修复后重新展示。'].join('\n')
}

export async function submitVisualizationMessage(text: string): Promise<void> {
  const chat = useChatStore.getState()
  if (selectSessionIsRunning(useRunStore.getState(), chat.currentSessionId) || chat.sendInFlight) {
    chat.enqueuePendingMessage(text, [])
    return
  }
  // 发送守卫拦截（如分叉准备窗口）时转入排队，交互不会无声丢失
  const accepted = await chat.sendMessage(text)
  if (!accepted) useChatStore.getState().enqueuePendingMessage(text, [])
}
