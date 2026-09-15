/**
 * 系统通知纯函数层：策略门禁、run 快照差异检测与文案。
 * 主进程集成层（src/main/notifications.ts）只负责 Electron 展示与点击路由。
 */
import type { RunSnapshot } from '../run/types'

export interface NotificationGateInput {
  enabled: boolean
  supported: boolean
  windowFocused: boolean
  onlyWhenUnfocused: boolean
  e2e: boolean
}

/** 策略门禁：开关 + 平台支持 + 失焦（可选） + 非测试环境 */
export function shouldShowNotification(input: NotificationGateInput): boolean {
  if (!input.enabled || !input.supported || input.e2e) return false
  if (input.onlyWhenUnfocused && input.windowFocused) return false
  return true
}

export type RunNotificationTrigger =
  | { kind: 'terminal'; status: 'completed' | 'failed' }
  | { kind: 'pendingInteraction'; interactionId: string }

/**
 * 差异检测：对比同一 run 的前后快照。
 * completed/failed 才通知——cancelled 是用户主动行为，interrupted 是启动对账，都不值一弹。
 */
export function detectRunNotificationTrigger(
  prev: RunSnapshot | null,
  next: RunSnapshot
): RunNotificationTrigger | null {
  const pendingIds = new Set(
    next.pendingInteractions
      .filter(interaction => interaction.status === 'pending')
      .map(interaction => interaction.interactionId)
  )
  if (prev) {
    for (const interaction of prev.pendingInteractions) {
      pendingIds.delete(interaction.interactionId)
    }
  }
  // 新 pending 优先于终态：等待批准的通知比完成通知更急
  const firstNew = pendingIds.values().next()
  if (!firstNew.done) {
    return { kind: 'pendingInteraction', interactionId: firstNew.value }
  }
  if (next.status === 'completed' || next.status === 'failed') {
    const wasTerminal = prev !== null && (prev.status === 'completed' || prev.status === 'failed')
    if (!wasTerminal) return { kind: 'terminal', status: next.status }
  }
  return null
}


export interface RunNotificationCopy {
  title: string
  body: string
}

/** 截断上限与 Electron 桌面通知展示规格对齐 */
const TITLE_MAX = 80
const BODY_MAX = 160

function clamp(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export function describeRunNotification(
  trigger: RunNotificationTrigger,
  snapshot: RunSnapshot,
  sessionTitle?: string
): RunNotificationCopy {
  const context = sessionTitle?.trim() || `会话 #${snapshot.sessionId.slice(-6)}`
  if (trigger.kind === 'terminal') {
    return trigger.status === 'completed'
      ? { title: '任务完成', body: clamp(context, BODY_MAX) }
      : { title: '任务失败', body: clamp(`${context}：${snapshot.terminalReason ?? '运行出错'}`, BODY_MAX) }
  }
  const interaction = snapshot.pendingInteractions.find(
    item => item.interactionId === trigger.interactionId
  )
  const pendingLabel =
    interaction?.type === 'permission'
      ? '等待你的工具授权'
      : interaction?.type === 'planApproval'
        ? '等待你的计划批准'
        : '向你提了一个问题'
  return { title: '需要你的确认', body: clamp(`${context}：${pendingLabel}`, BODY_MAX) }
}
