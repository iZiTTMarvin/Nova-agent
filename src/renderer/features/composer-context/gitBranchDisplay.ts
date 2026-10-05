/**
 * Composer 分支 chip 的纯展示逻辑：触发标签、未提交文案、搜索与 issue 中文映射。
 * 与 ZCode git-branch-switcher/display 对齐；用户可见文案全部在这里，主进程只给稳定 code。
 */
import type { GitBranchIssue, GitStatusSummary } from '../../../shared/git/types'

/** 触发按钮标签：分支名 / 游离 HEAD 兜底 */
export function resolveGitBranchTriggerLabel(summary: GitStatusSummary): string {
  if (summary.headRefType === 'detached') return '游离 HEAD'
  const name = summary.branchName?.trim()
  return name && name.length > 0 ? name : '分支'
}

/** 当前分支下的未提交文案；无未提交时为 null（不渲染该行） */
export function resolveDirtyLabel(dirtyFileCount: number): string | null {
  if (dirtyFileCount <= 0) return null
  return `未提交的更改：${dirtyFileCount} 个文件`
}

/** 分支搜索：本地子串匹配，不区分大小写；空查询全部命中 */
export function matchesBranchSearch(branchName: string, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase()
  if (normalized.length === 0) return true
  return branchName.trim().toLocaleLowerCase().includes(normalized)
}

/** 受影响路径摘要：可见前 N 条 + 剩余计数 */
export function summarizeIssuePaths(
  paths: readonly string[] | undefined,
  limit = 2
): { visible: string[]; remaining: number } {
  const normalized = (paths ?? []).filter(path => path.trim().length > 0)
  return {
    visible: normalized.slice(0, limit),
    remaining: Math.max(0, normalized.length - limit)
  }
}

export interface GitBranchIssueText {
  title: string
  hint?: string
}

/** 稳定 issue code → 用户能看懂的中文说明与处理建议 */
export function resolveGitBranchIssueText(issue: GitBranchIssue): GitBranchIssueText {
  switch (issue.code) {
    case 'invalid-branch-name':
      return {
        title: '分支名不合法',
        hint: '名称不能包含空格、~ ^ : ? * [ 等字符，也不能以 - 或点号开头、以 .lock 结尾。'
      }
    case 'branch-already-exists':
      return { title: '同名分支已存在', hint: '换一个名称，或直接在列表中切换到已有分支。' }
    case 'target-branch-not-found':
      return { title: '目标分支不存在', hint: '该分支可能已被删除，请刷新后重试。' }
    case 'tracked-changes-would-be-overwritten':
      return {
        title: '有未提交的改动会被覆盖',
        hint: '请先提交、暂存这些文件，或撤销改动，再切换分支。'
      }
    case 'untracked-changes-would-be-overwritten':
      return {
        title: '有未跟踪文件会被覆盖',
        hint: '以下未跟踪文件与目标分支冲突，请先移走、重命名或删除。'
      }
    case 'conflicts-present':
      return { title: '存在未解决的合并冲突', hint: '请先解决冲突并完成提交，再切换分支。' }
    case 'operation-in-progress':
      return {
        title: '有进行中的 Git 操作',
        hint: '合并、变基或拣选尚未完成，请先完成或取消后再切换。'
      }
    case 'branch-in-other-worktree':
      return {
        title: '该分支已在另一个工作区检出',
        hint: '请先在对应目录切走该分支，或改切其他分支。'
      }
    case 'not-a-repository':
      return { title: '当前目录不是 Git 仓库', hint: '可以先初始化仓库，或切换到其他工作区。' }
    case 'workspace-busy':
      return { title: '当前工作区有会话正在运行', hint: '等生成或工具执行结束后再切换分支。' }
    case 'mutation-failed':
      return { title: 'Git 未能完成分支操作' }
  }
}
