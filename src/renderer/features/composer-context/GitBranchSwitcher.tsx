/**
 * GitBranchSwitcher — Composer 分支 chip：当前分支 + 搜索/切换/创建菜单。
 * 视觉与交互对齐 ZCode GitBranchSwitcher；数据来自 git:* IPC，错误以中文说明展示。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Popover } from '@astryxdesign/core/Popover'
import { useWorkspaceStore } from '../../stores/useWorkspaceStore'
import {
  CheckIcon,
  ChevronDownIcon,
  GitForkIcon,
  PlusIcon,
  SearchIcon,
  SpinnerIcon
} from '../../components/Icons'
import {
  matchesBranchSearch,
  resolveDirtyLabel,
  resolveGitBranchIssueText,
  resolveGitBranchTriggerLabel,
  summarizeIssuePaths
} from './gitBranchDisplay'
import { useGitStatus } from './useGitStatus'
import { useGitBranchSwitcher } from './useGitBranchSwitcher'
import { GitBranchCreateDialog } from './GitBranchCreateDialog'
import './composerContext.css'

export const GitBranchSwitcher: React.FC = () => {
  const workspaceRoot = useWorkspaceStore(state => state.currentProjectPath)
  const { summary, refresh } = useGitStatus(workspaceRoot)
  const switcher = useGitBranchSwitcher({
    workspaceRoot,
    currentBranchName: summary?.branchName ?? null,
    onChanged: refresh
  })

  const [searchQuery, setSearchQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listRef = useRef<HTMLDivElement | null>(null)

  // 展开时重置搜索并让当前分支进入视野（照 ZCode 行为）
  useEffect(() => {
    if (!switcher.open) return
    setSearchQuery('')
    setActiveIndex(0)
  }, [switcher.open])

  useEffect(() => {
    if (!switcher.open) return
    const frame = window.requestAnimationFrame(() => {
      const current = listRef.current?.querySelector<HTMLElement>('[data-branch-current="true"]')
      current?.scrollIntoView({ block: 'nearest' })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [switcher.branchesResult, switcher.open])

  const displayedSummary = switcher.branchesResult?.summary ?? summary
  const triggerLabel = displayedSummary ? resolveGitBranchTriggerLabel(displayedSummary) : '分支'
  const branches = switcher.branchesResult?.branches ?? []
  const filteredBranches = useMemo(
    () => branches.filter(branch => matchesBranchSearch(branch, searchQuery)),
    [branches, searchQuery]
  )
  const clampedIndex = Math.min(activeIndex, Math.max(0, filteredBranches.length - 1))
  const dirtyLabel = resolveDirtyLabel(displayedSummary?.dirtyFileCount ?? 0)
  const switchIssueText = switcher.switchIssue ? resolveGitBranchIssueText(switcher.switchIssue) : null
  const issuePaths = summarizeIssuePaths(switcher.switchIssue?.paths)
  const createIssueText = switcher.createIssue ? resolveGitBranchIssueText(switcher.createIssue) : null

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex(Math.min(clampedIndex + 1, Math.max(0, filteredBranches.length - 1)))
      return
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex(Math.max(clampedIndex - 1, 0))
      return
    }
    // Enter 只接管搜索框内的确认；列表按钮自身的回车由 click 处理，避免双触发
    if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
      const branch = filteredBranches[clampedIndex]
      if (branch && !switcher.mutationPending) {
        event.preventDefault()
        void switcher.switchBranch(branch)
      }
    }
  }

  if (!summary?.isRepository) return null

  return (
    <>
      <Popover
        label="切换 Git 分支"
        placement="above"
        width={320}
        isOpen={switcher.open}
        onOpenChange={switcher.setOpen}
        content={
          <div
            className="composer-context-menu"
            data-testid="composer-git-branch-menu"
            onKeyDown={handleKeyDown}
          >
            <div className="composer-context-menu__search">
              <SearchIcon size={14} />
              <input
                value={searchQuery}
                onChange={event => {
                  setSearchQuery(event.target.value)
                  setActiveIndex(0)
                }}
                placeholder="搜索分支"
                aria-label="搜索分支"
              />
            </div>

            <div className="composer-context-menu__section">分支</div>

            <div className="composer-context-menu__list" ref={listRef} role="listbox" aria-label="本地分支">
              {filteredBranches.length === 0 ? (
                <div className="composer-context-menu__empty">
                  {switcher.loadingBranches ? '加载中…' : '没有匹配的分支'}
                </div>
              ) : null}
              {filteredBranches.map((branch, index) => {
                const isCurrent = displayedSummary
                  ? displayedSummary.headRefType === 'branch' && displayedSummary.branchName === branch
                  : false
                return (
                  <button
                    key={branch}
                    type="button"
                    role="option"
                    aria-selected={isCurrent}
                    data-branch-current={isCurrent ? 'true' : undefined}
                    data-active={index === clampedIndex ? 'true' : undefined}
                    className="composer-context-menu__item"
                    disabled={switcher.mutationPending}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => void switcher.switchBranch(branch)}
                  >
                    <GitForkIcon size={14} className="composer-context-menu__item-icon" />
                    <span className="composer-context-menu__item-body">
                      <span className="composer-context-menu__item-title">{branch}</span>
                      {isCurrent && dirtyLabel ? (
                        <span className="composer-context-menu__item-sub">{dirtyLabel}</span>
                      ) : null}
                    </span>
                    {isCurrent ? <CheckIcon size={14} className="composer-context-menu__item-check" /> : null}
                  </button>
                )
              })}
            </div>

            {switchIssueText ? (
              <div className="composer-context-menu__error" role="alert">
                <div className="composer-context-menu__error-title">{switchIssueText.title}</div>
                {switchIssueText.hint ? (
                  <div className="composer-context-menu__error-hint">{switchIssueText.hint}</div>
                ) : null}
                {issuePaths.visible.length > 0 ? (
                  <ul className="composer-context-menu__error-paths">
                    {issuePaths.visible.map(path => (
                      <li key={path}>{path}</li>
                    ))}
                    {issuePaths.remaining > 0 ? <li>等 {issuePaths.remaining} 个文件</li> : null}
                  </ul>
                ) : null}
                {switcher.switchIssue?.detail ? (
                  <details className="composer-context-menu__error-detail">
                    <summary>查看 Git 原始信息</summary>
                    <pre>{switcher.switchIssue.detail}</pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className="composer-context-menu__footer">
              <button
                type="button"
                className="composer-context-menu__action"
                disabled={switcher.mutationPending}
                onClick={() => {
                  switcher.setOpen(false)
                  switcher.openCreateDialog()
                }}
              >
                <PlusIcon size={14} className="composer-context-menu__action-icon" />
                创建并检出新分支…
              </button>
            </div>
          </div>
        }
      >
        <button
          type="button"
          className="composer-context-chip"
          data-testid="composer-git-branch-trigger"
          aria-label={`Git 分支：${triggerLabel}`}
          title={`Git 分支：${triggerLabel}`}
        >
          <GitForkIcon size={15} className="composer-context-chip__icon" />
          <span className="composer-context-chip__label">{triggerLabel}</span>
          {switcher.loadingBranches || switcher.mutationPending ? (
            <SpinnerIcon size={13} className="composer-context-chip__spinner" />
          ) : (
            <ChevronDownIcon size={13} className="composer-context-chip__chevron" />
          )}
        </button>
      </Popover>

      <GitBranchCreateDialog
        isOpen={switcher.createDialogOpen}
        branchName={switcher.createBranchName}
        isPending={switcher.mutationPending}
        errorText={
          createIssueText
            ? `${createIssueText.title}${createIssueText.hint ? `：${createIssueText.hint}` : ''}`
            : null
        }
        onBranchNameChange={switcher.setCreateBranchName}
        onCancel={switcher.closeCreateDialog}
        onSubmit={() => void switcher.createBranchAndSwitch()}
      />
    </>
  )
}
