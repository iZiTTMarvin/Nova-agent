/**
 * Git 上下文共享类型（Composer 分支 chip 的跨进程契约）
 *
 * 只描述主进程 gitService 返回的结构化结果；主进程把 Git 原生报错归一为
 * 稳定 issue code，用户可见文案由 renderer 侧映射，避免 UI 依赖易变的 stderr 文本。
 */

/** HEAD 引用类型：普通分支或游离 HEAD */
export type GitHeadRefType = 'branch' | 'detached'

/** 当前工作区 Git 摘要（chip 与菜单展示用） */
export interface GitStatusSummary {
  /** git 可执行文件在当前环境是否可用 */
  isGitAvailable: boolean
  /** 工作区是否位于某个 Git 仓库的 work tree 内 */
  isRepository: boolean
  /** 当前分支名；游离 HEAD 或未出生分支时为 null */
  branchName: string | null
  headRefType: GitHeadRefType
  /** 未提交文件数（含未跟踪），按路径去重 */
  dirtyFileCount: number
}

/** 分支列表查询结果：与摘要同一次快照，避免两次 RPC 口径漂移 */
export interface GitBranchListResult {
  summary: GitStatusSummary
  /** 本地分支短名，按 git for-each-ref 顺序 */
  branches: string[]
}

/** 分支变更失败原因（稳定枚举，不用原始报错做主文案） */
export type GitBranchIssueCode =
  | 'invalid-branch-name'
  | 'branch-already-exists'
  | 'target-branch-not-found'
  | 'tracked-changes-would-be-overwritten'
  | 'untracked-changes-would-be-overwritten'
  | 'conflicts-present'
  | 'operation-in-progress'
  | 'branch-in-other-worktree'
  | 'not-a-repository'
  | 'workspace-busy'
  | 'mutation-failed'

export interface GitBranchIssue {
  code: GitBranchIssueCode
  /** overwrite 类问题的受影响文件（仓库相对路径） */
  paths?: string[]
  /** git 原始输出，仅作次要诊断展示 */
  detail?: string
}

/** 分支切换 / 创建并切换的结果（判别联合） */
export type GitBranchMutationResult =
  | {
      ok: true
      /** false 表示目标即当前分支等 no-op */
      didChange: boolean
      created: boolean
      summary: GitStatusSummary
    }
  | { ok: false; issue: GitBranchIssue }
