/**
 * 命令执行：把 bash 工具包装成不抛异常的宿主能力。
 *
 * 失败语义全部体现在 exitCode 上（取消 / 越界 cwd / 权限拒绝 / 工具异常 → -1），
 * 让 definition 可以线性写「跑命令 → 看 exitCode」而不需要 try/catch。
 */
import { existsSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { bashTool } from '../../tools/bash'
import { createReadState } from '../../tools/editTool'
import { PermissionManager } from '../../permissions/PermissionManager'
import { isPathInside } from '../effects/pathSafety'
import type { ToolContext } from '../../tools/types'
import type { Mode } from '../../../shared/session/types'
import { assertScopeLive, type BashOptions, type BashResult, type HostContext } from './types'

export type BashFn = (command: string, opts?: BashOptions) => Promise<BashResult>

function cancelled(reason: string): BashResult {
  return { exitCode: -1, stdout: '', stderr: reason }
}

/**
 * 解析执行目录：必须落在工作区内（worktree 目录也在工作区内）。
 * 越界返回 null，由调用点转成 exitCode -1。
 */
function resolveCwd(workspaceRoot: string, cwd?: string): string | null {
  if (!cwd) return workspaceRoot
  const abs = isAbsolute(cwd) ? resolve(cwd) : resolve(workspaceRoot, cwd)
  if (!isPathInside(resolve(workspaceRoot), abs) || !existsSync(abs)) return null
  return abs
}

export function createBashFn(ctx: HostContext): BashFn {
  return async (command, opts) => {
    if (!assertScopeLive(ctx)) return cancelled('cancelled')
    const cmd = String(command ?? '')
    const cwd = resolveCwd(ctx.workspaceRoot, opts?.cwd)
    if (!cwd) return cancelled(`cwd 越界或不存在: ${opts?.cwd}`)

    // 编排内固定 auto 权限语义；危险命令仍由 PermissionManager 拦截
    const mode: Mode = ctx.mode ?? 'compose'
    const pm = new PermissionManager()
    pm.setPermissionPolicy('auto')
    if (ctx.sessionId) pm.setSessionId(ctx.sessionId)
    const decision = pm.check({ toolName: 'bash', args: { command: cmd } }, mode)
    if (decision.decision === 'deny') {
      return cancelled(decision.reason ?? 'permission denied')
    }

    const toolCtx: ToolContext = {
      workingDir: cwd,
      readState: createReadState(),
      checkpointManager: ctx.checkpointManager,
      abortSignal: ctx.abortSignal,
      supportsVision: ctx.supportsVision,
      sessionId: ctx.sessionId,
      eventBus: ctx.eventBus,
      ...(ctx.assertExecutionCurrent ? { assertExecutionCurrent: ctx.assertExecutionCurrent } : {})
    }

    try {
      const result = await bashTool.execute({ command: cmd }, toolCtx)
      // 命令跑完但 scope 已关闭：结果不可信（可能已被 abort 打断），按取消处理
      if (!assertScopeLive(ctx)) return cancelled('cancelled')
      // 非零退出码在工具层算"执行成功"，因此退出码只能取 exitCode 字段，不能从 success 推断
      const exitCode = result.exitCode ?? (result.success ? 0 : -1)
      return {
        exitCode,
        stdout: result.output ?? '',
        stderr: result.error ?? ''
      }
    } catch (err) {
      return cancelled(err instanceof Error ? err.message : String(err))
    }
  }
}
