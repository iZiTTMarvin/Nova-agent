/**
 * 会话消息 append-only patch 事件
 *
 * 用于历史后补字段（如 verificationSummary），避免全量重写 messages.jsonl。
 * 加载时把 patch 叠到 base 消息上；空闲时可 compact 合并进 base。
 */
import * as fs from 'fs'
import * as path from 'path'
import type { SessionMessage } from './types'

/** patch 事件文件名（与 messages.jsonl 并列） */
export const SESSION_MESSAGE_PATCHES_FILE = 'message-patches.jsonl'

/** 单条 patch：按 messageId 叠加字段 */
export interface MessagePatchEvent {
  type: 'message_patch'
  messageId: string
  /** 要合并进目标消息的字段（浅合并） */
  patch: Partial<Pick<SessionMessage, 'verificationSummary' | 'interrupted' | 'blocks' | 'content' | 'toolCalls'>>
  timestamp: number
}

/** 追加一条 patch 事件（O(1)，不扫消息图） */
export function appendMessagePatch(sessionDir: string, event: MessagePatchEvent): void {
  const filePath = path.join(sessionDir, SESSION_MESSAGE_PATCHES_FILE)
  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8')
}

/** 读取全部 patch；损坏行跳过 */
export function readMessagePatches(sessionDir: string): MessagePatchEvent[] {
  const filePath = path.join(sessionDir, SESSION_MESSAGE_PATCHES_FILE)
  if (!fs.existsSync(filePath)) return []
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    if (!content.trim()) return []
    const events: MessagePatchEvent[] = []
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as MessagePatchEvent
        if (parsed.type === 'message_patch' && typeof parsed.messageId === 'string') {
          events.push(parsed)
        }
      } catch {
        // 损坏行跳过
      }
    }
    return events
  } catch {
    return []
  }
}

/**
 * 将 patch 叠到消息数组上（按时间顺序；同字段后写覆盖）。
 * 不 mutate 入参数组元素以外的引用——返回新数组。
 */
export function applyMessagePatches(
  messages: SessionMessage[],
  patches: MessagePatchEvent[]
): SessionMessage[] {
  if (patches.length === 0) return messages

  const byId = new Map(messages.map(m => [m.id, { ...m }]))
  for (const ev of patches) {
    const target = byId.get(ev.messageId)
    if (!target) continue
    Object.assign(target, ev.patch)
  }
  return messages.map(m => byId.get(m.id) ?? m)
}

/**
 * 空闲合并：把 patch 写回 messages，清空 patch 文件。
 * 调用方负责提供已合并的完整消息列表并重写 jsonl。
 */
export function clearMessagePatches(sessionDir: string): void {
  const filePath = path.join(sessionDir, SESSION_MESSAGE_PATCHES_FILE)
  if (fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf8')
  }
}
