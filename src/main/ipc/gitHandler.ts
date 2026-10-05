/**
 * gitHandler — Git 上下文 IPC（Composer 分支 chip）
 *
 * 只做参数校验与 workspace-busy 守卫，业务实现全部委托 gitService。
 * 读取类命令在 Agent 运行中仍可用；分支变更必须整仓空闲，避免与工具写文件互相破坏。
 */
import { existsSync, statSync } from 'fs'
import { handle } from './secureIpc'
import {
  GIT_GET_STATUS,
  GIT_LIST_BRANCHES,
  GIT_SWITCH_BRANCH,
  GIT_CREATE_BRANCH
} from '../../shared/ipc/channels'
import { isSessionTurnInProgress } from '../agent/state'
import { getWorkspaceService } from '../services/WorkspaceService'
import {
  getGitStatus,
  listGitBranches,
  switchGitBranch,
  createGitBranchAndSwitch
} from '../services/gitService'
import type { GitBranchIssue, GitBranchMutationResult } from '../../shared/git/types'

function requireWorkspaceRoot(params: { workspaceRoot?: unknown }): string {
  const root = typeof params?.workspaceRoot === 'string' ? params.workspaceRoot.trim() : ''
  if (!root) throw new Error('缺少工作区路径')
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error('工作区目录不存在或不可访问')
  }
  return root
}

/** 同工作区存在运行中会话时返回 workspace-busy（分支变更 fail-closed） */
export function findWorkspaceBusyIssue(workspaceRoot: string): GitBranchIssue | null {
  const sessions = getWorkspaceService().getState().availableSessions
  const busy = sessions.some(
    session => session.workspaceRoot === workspaceRoot && isSessionTurnInProgress(session.id)
  )
  return busy ? { code: 'workspace-busy' } : null
}

function runGuardedMutation(
  params: { workspaceRoot: string; branchName: string },
  mutate: (root: string, branchName: string) => Promise<GitBranchMutationResult>
): Promise<GitBranchMutationResult> {
  const root = requireWorkspaceRoot(params)
  const busyIssue = findWorkspaceBusyIssue(root)
  if (busyIssue) return Promise.resolve({ ok: false, issue: busyIssue })
  const branchName = typeof params?.branchName === 'string' ? params.branchName : ''
  return mutate(root, branchName)
}

export function registerGitHandler(): void {
  handle(GIT_GET_STATUS, async (_event, params: { workspaceRoot: string }) => {
    return await getGitStatus(requireWorkspaceRoot(params))
  })

  handle(GIT_LIST_BRANCHES, async (_event, params: { workspaceRoot: string }) => {
    return await listGitBranches(requireWorkspaceRoot(params))
  })

  handle(
    GIT_SWITCH_BRANCH,
    async (_event, params: { workspaceRoot: string; branchName: string }) =>
      await runGuardedMutation(params, switchGitBranch)
  )

  handle(
    GIT_CREATE_BRANCH,
    async (_event, params: { workspaceRoot: string; branchName: string }) =>
      await runGuardedMutation(params, createGitBranchAndSwitch)
  )
}
