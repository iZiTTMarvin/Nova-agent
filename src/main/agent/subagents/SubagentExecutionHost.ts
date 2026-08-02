import type { BrowserWindow } from 'electron'
import {
  SubagentExecutionService,
  type SpawnSubagentContext,
  type SpawnSubagentPort,
  type SubagentExecutionServiceDeps
} from '../../../runtime/subagents'
import type {
  SpawnSubagentCommand,
  SubagentExecutionResult
} from '../../../shared/subagents'
import { SUBAGENT_LINKED } from '../../../shared/ipc/channels'

export interface SubagentExecutionHostDeps extends Omit<SubagentExecutionServiceDeps, 'onLinked'> {
  readonly getMainWindow: () => BrowserWindow | null
  readonly refreshAvailableSessions: () => void
}

/** Electron 装配壳：执行仍归 runtime service，主进程只广播 relation 失效。 */
export class SubagentExecutionHost implements SpawnSubagentPort {
  private readonly service: SubagentExecutionService

  constructor(deps: SubagentExecutionHostDeps) {
    const { getMainWindow, refreshAvailableSessions, ...serviceDeps } = deps
    this.service = new SubagentExecutionService({
      ...serviceDeps,
      onLinked: ({ childSession, created }) => {
        if (!created) return
        try {
          refreshAvailableSessions()
          const win = getMainWindow()
          if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
          win.webContents.send(SUBAGENT_LINKED, {
            parentSessionId: childSession.subagent.lineage.parentSessionId,
            childSessionId: childSession.id
          })
        } catch (error) {
          console.error('[SubagentExecutionHost] 子会话关系通知失败:', error)
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
}
