/**
 * 子代理状态的界面文案与色调：活动行与会话状态面板共用，保证同一状态处处同名。
 */
import type { SubagentActivityProjection } from '../../../shared/subagents'

export interface StatusPresentation {
  label: string
  tone: 'running' | 'attention' | 'success' | 'error' | 'muted'
}

export function presentSubagentStatus(status: SubagentActivityProjection['status']): StatusPresentation {
  switch (status) {
    case 'queued':
      return { label: '等待开始', tone: 'running' }
    case 'running':
    case 'resuming':
      return { label: '正在工作', tone: 'running' }
    case 'retrying':
      return { label: '正在重试', tone: 'running' }
    case 'waiting_user':
      return { label: '等待授权', tone: 'attention' }
    case 'cancelling':
      return { label: '正在停止', tone: 'running' }
    case 'completed':
      return { label: '已完成', tone: 'success' }
    case 'failed':
      return { label: '失败', tone: 'error' }
    case 'cancelled':
      return { label: '已取消', tone: 'muted' }
    case 'interrupted':
      return { label: '已中断', tone: 'attention' }
    case 'record_missing':
      return { label: '记录不可用', tone: 'muted' }
  }
}

/**
 * 一组活动子代理的状态摘要，如「1 个等待授权，2 个正在工作」。
 * 需要用户处理的状态排在最前；排队、恢复与运行合并为「正在工作」。
 */
export function summarizeActiveSubagents(
  statuses: readonly SubagentActivityProjection['status'][]
): { text: string; needsAttention: boolean; working: boolean } {
  const order = ['等待授权', '正在停止', '正在重试', '正在工作', '等待开始']
  const counts = new Map<string, number>()
  for (const status of statuses) {
    const { label } = presentSubagentStatus(status)
    counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const parts = order
    .filter(label => counts.has(label))
    .map(label => `${counts.get(label)} 个${label}`)
  return {
    text: parts.join('，'),
    needsAttention: counts.has('等待授权'),
    working: counts.has('正在工作') || counts.has('正在重试') || counts.has('等待开始')
  }
}
