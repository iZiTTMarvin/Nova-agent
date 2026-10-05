/**
 * Composer 分支 chip 的纯展示逻辑：标签兜底、搜索、issue 中文映射与路径摘要。
 */
import { describe, expect, it } from 'vitest'
import {
  matchesBranchSearch,
  resolveDirtyLabel,
  resolveGitBranchIssueText,
  resolveGitBranchTriggerLabel,
  summarizeIssuePaths
} from '../../../../src/renderer/features/composer-context/gitBranchDisplay'
import type { GitStatusSummary } from '../../../../src/shared/git/types'

function summaryOf(patch: Partial<GitStatusSummary>): GitStatusSummary {
  return {
    isGitAvailable: true,
    isRepository: true,
    branchName: 'dev',
    headRefType: 'branch',
    dirtyFileCount: 0,
    ...patch
  }
}

describe('resolveGitBranchTriggerLabel', () => {
  it('普通分支显示分支名；游离 HEAD 与空分支使用兜底文案', () => {
    expect(resolveGitBranchTriggerLabel(summaryOf({ branchName: 'dev' }))).toBe('dev')
    expect(
      resolveGitBranchTriggerLabel(summaryOf({ headRefType: 'detached', branchName: null }))
    ).toBe('游离 HEAD')
    expect(resolveGitBranchTriggerLabel(summaryOf({ branchName: null }))).toBe('分支')
    expect(resolveGitBranchTriggerLabel(summaryOf({ branchName: '   ' }))).toBe('分支')
  })
})

describe('resolveDirtyLabel', () => {
  it('有未提交时给出数量文案；0 时不给行', () => {
    expect(resolveDirtyLabel(46)).toBe('未提交的更改：46 个文件')
    expect(resolveDirtyLabel(0)).toBeNull()
  })
})

describe('matchesBranchSearch', () => {
  it('大小写不敏感的子串匹配；空查询全部命中', () => {
    expect(matchesBranchSearch('feature/Login', 'login')).toBe(true)
    expect(matchesBranchSearch('feature/Login', '  FEAT  ')).toBe(true)
    expect(matchesBranchSearch('feature/Login', 'main')).toBe(false)
    expect(matchesBranchSearch('feature/Login', '')).toBe(true)
  })
})

describe('summarizeIssuePaths', () => {
  it('前 2 条可见 + 剩余计数，过滤空白', () => {
    expect(summarizeIssuePaths(['a.ts', 'b.ts', 'c.ts', ' '])).toEqual({
      visible: ['a.ts', 'b.ts'],
      remaining: 1
    })
    expect(summarizeIssuePaths(undefined)).toEqual({ visible: [], remaining: 0 })
  })
})

describe('resolveGitBranchIssueText', () => {
  it('每个稳定 code 都有中文说明；冲突类带处理建议', () => {
    expect(resolveGitBranchIssueText({ code: 'branch-already-exists' }).title).toBe('同名分支已存在')
    const overwrite = resolveGitBranchIssueText({
      code: 'tracked-changes-would-be-overwritten',
      paths: ['a.ts']
    })
    expect(overwrite.title).toBe('有未提交的改动会被覆盖')
    expect(overwrite.hint).toContain('提交')
    expect(resolveGitBranchIssueText({ code: 'workspace-busy' }).title).toContain('正在运行')
    expect(resolveGitBranchIssueText({ code: 'mutation-failed' }).title).toContain('未能完成')
  })

  it('非法分支名给出字符限制说明', () => {
    const text = resolveGitBranchIssueText({ code: 'invalid-branch-name' })
    expect(text.title).toBe('分支名不合法')
    expect(text.hint).toContain('空格')
  })
})
