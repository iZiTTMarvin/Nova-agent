/**
 * 进度与日志：向 renderer 发射进度事件，同时把日志行落到 run 目录。
 *
 * 不变量：scope 关闭后静默丢弃。进度是可观测信息，不得因为取消而抛错或阻塞收尾路径。
 */
import { appendFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import type { WorkflowProgressDetail, WorkflowProgressStatus } from '../../agent/types'
import { runLogPath } from '../state/paths'
import { assertScopeLive, type HostContext } from './types'

export type ProgressFn = (
  phase: string,
  status: WorkflowProgressStatus,
  detail?: WorkflowProgressDetail
) => void

export type LogFn = (message: string) => void

/**
 * progress(phase, status, detail)。
 * status='started' 时同步更新 ctx.currentPhase —— journal key 依赖当前阶段名，
 * 阶段推进与 key 计算必须看到同一个值。
 */
export function createProgressFn(ctx: HostContext): ProgressFn {
  return (phase, status, detail) => {
    if (!assertScopeLive(ctx)) return
    const name = String(phase ?? '')
    if (status === 'started' && name) {
      ctx.currentPhase.name = name
    }
    ctx.eventBus.emit({
      type: 'workflow_progress',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      phase: name,
      status,
      ...(detail ? { detail } : {})
    })
  }
}

export function createLogFn(ctx: HostContext): LogFn {
  const logFile = runLogPath(ctx.workspaceRoot, ctx.runId)
  return (message) => {
    if (!assertScopeLive(ctx)) return
    const text = String(message ?? '')
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      appendFileSync(logFile, `[${new Date().toISOString()}] ${text}\n`, 'utf-8')
    } catch {
      // 日志落盘失败不影响编排推进
    }
    ctx.eventBus.emit({
      type: 'workflow_log',
      runId: ctx.runId,
      sessionId: ctx.sessionId,
      message: text
    })
  }
}
