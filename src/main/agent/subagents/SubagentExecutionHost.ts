import type { BrowserWindow } from 'electron'
import {
  SubagentExecutionService,
  type SpawnSubagentContext,
  type SpawnSubagentPort,
  type SubagentExecutionServiceDeps
} from '../../../runtime/subagents'
import type {
  FollowupSubagentCommand,
  SpawnSubagentCommand,
  SubagentExecutionResult
} from '../../../shared/subagents'
import { SUBAGENT_LINKED } from '../../../shared/ipc/channels'

export interface SubagentExecutionHostDeps extends Omit<SubagentExecutionServiceDeps, 'onLinked'> {
  readonly getMainWindow: () => BrowserWindow | null
  readonly refreshAvailableSessions: () => void
}

/** Electron 装配壳：执行仍归 runtime service，主进程只广播子代理投影失效。 */
export class SubagentExecutionHost implements SpawnSubagentPort {
  private readonly service: SubagentExecutionService

  constructor(deps: SubagentExecutionHostDeps) {
    const { getMainWindow, refreshAvailableSessions, sessionStore, ...serviceDeps } = deps
    const broadcastProjectionChanged = (parentSessionId: string, childSessionId: string): void => {
      const win = getMainWindow()
      if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
      win.webContents.send(SUBAGENT_LINKED, { parentSessionId, childSessionId })
    }
    this.service = new SubagentExecutionService({
      ...serviceDeps,
      sessionStore,
      onLinked: ({ childSession, created }) => {
        if (!created) return
        try {
          refreshAvailableSessions()
          broadcastProjectionChanged(
            childSession.subagent.lineage.parentSessionId,
            childSession.id
          )
        } catch (error) {
          console.error('[SubagentExecutionHost] 子会话关系通知失败:', error)
        }
      },
      onExecutionStarted: (context) => {
        serviceDeps.onExecutionStarted?.(context)
        // followup 不新建会话关系，出生之外的 run 启动也要让渲染层即时出现活动行
        try {
          const child = sessionStore.load(context.childSessionId)
          if (
            child?.kind === 'subagent' &&
            child.subagent.lineage.spawnRunId === context.runId
          ) {
            return
          }
          broadcastProjectionChanged(context.parentSessionId, context.childSessionId)
        } catch (error) {
          console.error('[SubagentExecutionHost] followup 启动通知失败:', error)
        }
      }
    })
  }

  spawn(
    command: SpawnSubagentCommand,
    context?: SpawnSubagentContext
  ): Promise<SubagentExecutionResult> {
    return this.service.spawn(command, context)
  }

  followup(
    command: FollowupSubagentCommand,
    context?: SpawnSubagentContext
  ): Promise<SubagentExecutionResult> {
    return this.service.followup(command, context)
  }
}
