/** 持久进程注册表的生命周期接线：run 终态、会话删除、应用退出、headless 退出。 */
import { processRegistry } from '../../runtime/process'
import type { RunCoordinator } from '../../runtime/run'
import { getRunCoordinator } from './RunCoordinatorHost'

/**
 * run 终态终止进程会话：
 * - 用户中止杀该 run 全部会话；
 * - 其余终态只杀 subagent-run 会话，主 run 正常完成的进程跨 turn 存活，
 *   生命周期归聊天会话删除与应用退出管理。
 *   不接 AgentLoop.dispose：新 turn 接替 idle loop 时也会 dispose，
 *   在彼处杀进程会破坏主 run 进程跨 turn 存活。
 */
export function wireProcessCleanup(coord: Pick<RunCoordinator, 'onTerminalHook'>): void {
  coord.onTerminalHook('onCancel', (ctx) => {
    terminateForRun(ctx.snapshot.runId, true)
  })
  for (const hook of ['onComplete', 'onFail', 'onInterrupt'] as const) {
    coord.onTerminalHook(hook, (ctx) => {
      terminateForRun(ctx.snapshot.runId, false)
    })
  }
}

function terminateForRun(runId: string, includeMainRun: boolean): void {
  // hook 抛错会被 RunCoordinator 标记 failed 重试，终止失败不能阻塞终态交付
  processRegistry
    .terminateForRun(runId, { includeMainRun })
    .catch((err: unknown) => {
      console.error(`[ProcessCleanupHost] run 终态终止进程失败 runId=${runId}:`, err)
    })
}

let wired = false

export function ensureProcessCleanupWired(): void {
  if (wired) return
  try {
    wireProcessCleanup(getRunCoordinator())
    wired = true
  } catch {
    // RunCoordinator 尚未初始化时留待下次调用；registerIpcHandlers 会先 init
  }
}
