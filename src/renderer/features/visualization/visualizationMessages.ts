/**
 * 可视化回传给模型的用户消息。去向由宿主表面通过 VisualizationMessageContext 决定；
 * 这里的 submitVisualizationMessage 是开发对话的默认实现：运行中排队，空闲时直接发送。
 */
import { useChatStore } from '../../stores/useChatStore'
import { selectSessionIsRunning, useRunStore } from '../../stores/useRunStore'

const MAX_REPORTED_ERRORS = 5

export type VisualizationMessageKind = 'event' | 'repair'

export type VisualizationSubmitOutcome =
  | { readonly status: 'sent' | 'queued' }
  | { readonly status: 'blocked'; readonly notice: string }

export type VisualizationMessageSubmitter = (
  text: string,
  kind: VisualizationMessageKind
) => Promise<VisualizationSubmitOutcome>

/** 页面按约定回传 { label?, prompt } 或纯文本时转成人话；其余结构保留 JSON，模型仍能拿到完整数据。 */
function readableEventPayload(data: unknown): string | null {
  if (typeof data === 'string') return data.trim() || null
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const { label, prompt } = data as Record<string, unknown>
  const question = typeof prompt === 'string' ? prompt.trim() : ''
  if (!question) return null
  const subject = typeof label === 'string' ? label.trim() : ''
  return subject ? `${subject}：${question}` : question
}

export function formatVisualizationEventMessage(title: string, name: string, data: unknown): string {
  const header = `【可视化】${title} · ${name}`
  if (data === null || data === undefined) return header
  return `${header}\n${readableEventPayload(data) ?? JSON.stringify(data)}`
}

export function formatVisualizationRepairMessage(title: string, errors: readonly string[]): string {
  return [`【可视化报错】${title}`, ...errors.slice(0, MAX_REPORTED_ERRORS), '请修复后重新展示。'].join('\n')
}

export const submitVisualizationMessage: VisualizationMessageSubmitter = async text => {
  const chat = useChatStore.getState()
  if (selectSessionIsRunning(useRunStore.getState(), chat.currentSessionId) || chat.sendInFlight) {
    chat.enqueuePendingMessage(text, [])
    return { status: 'queued' }
  }
  // 发送守卫拦截（如分叉准备窗口）时转入排队，交互不会无声丢失
  const accepted = await chat.sendMessage(text)
  if (accepted) return { status: 'sent' }
  useChatStore.getState().enqueuePendingMessage(text, [])
  return { status: 'queued' }
}
