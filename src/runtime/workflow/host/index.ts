/**
 * 宿主能力层出口：把各能力文件组装成 definition 唯一依赖的 HostFns。
 *
 * 组装点也是依赖注入点：integrate 的冲突兜底需要子 agent，
 * 由此处把 agent 函数交给 worktreeFn，避免两个能力文件互相 import。
 */
import { createAgentFn } from './agentFn'
import { createBashFn } from './bashFn'
import { createFsFns } from './fsFn'
import { createLogFn, createProgressFn } from './progressFn'
import { createCleanupWorktreeFn, createIntegrateFn, createWorktreeFn } from './worktreeFn'
import { ensureRunDir } from '../state/paths'
import type { HostContext, HostFns } from './types'

export function createHostFns(ctx: HostContext): HostFns {
  // log / effect / journal 都写在 run 目录下，先确保其存在
  ensureRunDir(ctx.workspaceRoot, ctx.runId)
  // 写文件要落在一个 checkpoint 事务里，否则 undo 无法按消息回滚
  if (ctx.checkpointManager && !ctx.checkpointManager.getCurrentMessageId()) {
    ctx.checkpointManager.beginMessage(`workflow-${ctx.runId}`)
  }

  const agent = createAgentFn(ctx)
  const fs = createFsFns(ctx)

  return {
    agent,
    bash: createBashFn(ctx),
    read: fs.read,
    write: fs.write,
    delete: fs.delete,
    exists: fs.exists,
    glob: fs.glob,
    worktree: createWorktreeFn(ctx),
    integrate: createIntegrateFn(ctx, agent),
    cleanupWorktree: createCleanupWorktreeFn(ctx),
    progress: createProgressFn(ctx),
    log: createLogFn(ctx)
  }
}

export { assertScopeLive, hostEffectCtx } from './types'
export type {
  AgentOptions,
  AgentResult,
  BashOptions,
  BashResult,
  HostContext,
  HostFns,
  IntegrateOptions,
  IntegrateResult,
  IsolationMode,
  OwnedWorktree,
  WorktreeHandle
} from './types'
export { BASE_TOOLS, READONLY_TOOLS, resolveAgentTools } from './agentFn'
export { ensureWorktree, releaseWorktree } from './worktreeFn'
