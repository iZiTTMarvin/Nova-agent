// @vitest-environment jsdom

/**
 * Composer 上下文条：分支 chip 的展示/错误中文说明，工作区菜单的分流动作。
 * Popover 用受控替身（与 ReasoningEffortControl.test 同思路）以直接断言菜单内容。
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerContextBar } from '../../../../src/renderer/features/composer-context/ComposerContextBar'
import { resetWorkspaceStoreForTests, useWorkspaceStore } from '../../../../src/renderer/stores/useWorkspaceStore'
import type { GitStatusSummary } from '../../../../src/shared/git/types'
import type { Session } from '../../../../src/shared/session/types'
import type { WorkspaceState } from '../../../../src/shared/workspace/types'
import { act, renderDom, waitFor } from '../../../unit/renderer/renderDom'

vi.mock('@astryxdesign/core/Popover', () => ({
  Popover: ({
    children,
    content,
    isOpen,
    onOpenChange,
    label
  }: {
    children: React.ReactNode
    content: React.ReactNode
    isOpen?: boolean
    onOpenChange?: (open: boolean) => void
    label?: string
  }) => (
    <div>
      <div onClick={() => onOpenChange?.(!isOpen)}>{children}</div>
      {isOpen ? (
        <div role="dialog" aria-label={label}>
          {content}
        </div>
      ) : null}
    </div>
  )
}))

const invoke = vi.fn()
const on = vi.fn(() => () => {})

const REPO_SUMMARY: GitStatusSummary = {
  isGitAvailable: true,
  isRepository: true,
  branchName: 'dev',
  headRefType: 'branch',
  dirtyFileCount: 46
}

function sessionOf(id: string, workspaceRoot: string, updatedAt: number): Session {
  return {
    id,
    workspaceRoot,
    mode: 'default',
    permissionMode: 'auto',
    createdAt: updatedAt,
    updatedAt,
    messageCount: 1,
    kind: 'primary'
  }
}

function workspaceStateOf(patch: Partial<WorkspaceState>): WorkspaceState {
  return {
    currentSessionId: null,
    currentProjectPath: null,
    defaultWorkspacePath: '/ws/default',
    currentMode: 'default',
    reasoningEffortOverride: null,
    activeModelRef: null,
    availableSessions: [],
    messagesRevision: 0,
    tier1BranchContext: null,
    tier1StaleDiffMessageIds: [],
    ...patch
  }
}

function clickTrigger(container: HTMLElement, testId: string): void {
  const trigger = container.querySelector<HTMLElement>(`[data-testid="${testId}"]`)
  expect(trigger).not.toBeNull()
  act(() => {
    trigger!.click()
  })
}

describe('ComposerContextBar', () => {
  beforeEach(() => {
    resetWorkspaceStoreForTests()
    invoke.mockReset()
    on.mockClear()
    Object.assign(window, { api: { invoke, on } })
  })

  it('非 Git 仓库只显示工作区 chip，不渲染分支 chip', async () => {
    useWorkspaceStore.setState({ currentProjectPath: '/ws/plain' })
    let resolveStatus!: (value: GitStatusSummary) => void
    invoke.mockImplementation((channel: string) => {
      if (channel === 'git:get-status') {
        return new Promise<GitStatusSummary>(resolve => {
          resolveStatus = resolve
        })
      }
      return Promise.resolve(undefined)
    })

    const view = renderDom(<ComposerContextBar />)
    try {
      expect(view.container.querySelector('[data-testid="composer-workspace-trigger"]')?.textContent).toContain('plain')
      await act(async () => {
        resolveStatus({
          isGitAvailable: true,
          isRepository: false,
          branchName: null,
          headRefType: 'branch',
          dirtyFileCount: 0
        })
      })
      expect(view.container.querySelector('[data-testid="composer-git-branch-trigger"]')).toBeNull()
    } finally {
      view.unmount()
    }
  })

  it('仓库显示当前分支；展开后加载列表并展示当前分支的未提交文件数', async () => {
    useWorkspaceStore.setState({ currentProjectPath: '/ws/repo' })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:get-status') return REPO_SUMMARY
      if (channel === 'git:list-branches') {
        return { summary: REPO_SUMMARY, branches: ['dev', 'feature/x', 'main'] }
      }
      return undefined
    })

    const view = renderDom(<ComposerContextBar />)
    try {
      await waitFor(() => view.container.querySelector('[data-testid="composer-git-branch-trigger"]') !== null)
      expect(view.container.querySelector('[data-testid="composer-git-branch-trigger"]')?.textContent).toContain('dev')

      clickTrigger(view.container, 'composer-git-branch-trigger')
      await waitFor(() => (view.container.textContent ?? '').includes('feature/x'))

      const menu = view.container.querySelector('[data-testid="composer-git-branch-menu"]')
      expect(menu?.textContent).toContain('未提交的更改：46 个文件')
      const currentItem = menu?.querySelector('[data-branch-current="true"]')
      expect(currentItem?.textContent).toContain('dev')
      expect(invoke).toHaveBeenCalledWith('git:list-branches', { workspaceRoot: '/ws/repo' })
    } finally {
      view.unmount()
    }
  })

  it('切换分支失败时展示中文原因、受影响文件与剩余计数', async () => {
    useWorkspaceStore.setState({ currentProjectPath: '/ws/repo' })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:get-status') return REPO_SUMMARY
      if (channel === 'git:list-branches') {
        return { summary: REPO_SUMMARY, branches: ['dev', 'main'] }
      }
      if (channel === 'git:switch-branch') {
        return {
          ok: false,
          issue: {
            code: 'tracked-changes-would-be-overwritten',
            paths: ['src/a.ts', 'README.md', 'src/c.ts'],
            detail: 'error: Your local changes to the following files would be overwritten by checkout:'
          }
        }
      }
      return undefined
    })

    const view = renderDom(<ComposerContextBar />)
    try {
      await waitFor(() => view.container.querySelector('[data-testid="composer-git-branch-trigger"]') !== null)
      clickTrigger(view.container, 'composer-git-branch-trigger')
      await waitFor(() => (view.container.textContent ?? '').includes('main'))

      const target = [...view.container.querySelectorAll<HTMLButtonElement>('button')].find(
        button => button.textContent?.trim() === 'main'
      )
      expect(target).toBeDefined()
      await act(async () => {
        target!.click()
      })

      await waitFor(() => (view.container.textContent ?? '').includes('有未提交的改动会被覆盖'))
      expect(invoke).toHaveBeenCalledWith('git:switch-branch', {
        workspaceRoot: '/ws/repo',
        branchName: 'main'
      })
      expect(view.container.textContent).toContain('src/a.ts')
      expect(view.container.textContent).toContain('等 1 个文件')
      expect(view.container.textContent).toContain('查看 Git 原始信息')
    } finally {
      view.unmount()
    }
  })

  it('工作区菜单列出其他项目并排除默认工作区；点击项目按路径建会话', async () => {
    useWorkspaceStore.setState({
      currentProjectPath: '/ws/nova',
      defaultWorkspacePath: '/ws/default',
      availableSessions: [
        sessionOf('s1', '/ws/nova', 100),
        sessionOf('s2', '/ws/zcode', 200),
        sessionOf('s3', '/ws/default', 300)
      ]
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:get-status') {
        return { isGitAvailable: true, isRepository: false, branchName: null, headRefType: 'branch', dirtyFileCount: 0 }
      }
      if (channel === 'workspace:select-project') {
        return workspaceStateOf({ currentProjectPath: '/ws/zcode' })
      }
      return undefined
    })

    const view = renderDom(<ComposerContextBar />)
    try {
      clickTrigger(view.container, 'composer-workspace-trigger')
      const menu = view.container.querySelector('[data-testid="composer-workspace-menu"]')
      expect(menu?.textContent).toContain('zcode')
      expect(menu?.textContent).toContain('使用 Nova 工作区')
      // 默认工作区被排除在项目列表之外（底部入口的路径提示不算列表项）
      const listbox = menu?.querySelector('[role="listbox"]')
      expect(listbox?.textContent).toContain('zcode')
      expect(listbox?.textContent).not.toContain('default')

      const target = [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(
        button => button.textContent?.trim() === 'zcode'
      )
      expect(target).toBeDefined()
      await act(async () => {
        target!.click()
      })
      expect(invoke).toHaveBeenCalledWith('workspace:select-project', { path: '/ws/zcode' })
    } finally {
      view.unmount()
    }
  })

  it('工作区菜单可切换到 Nova 默认工作区', async () => {
    useWorkspaceStore.setState({
      currentProjectPath: '/ws/nova',
      defaultWorkspacePath: '/ws/default'
    })
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'git:get-status') {
        return { isGitAvailable: true, isRepository: false, branchName: null, headRefType: 'branch', dirtyFileCount: 0 }
      }
      if (channel === 'workspace:select-default') {
        return workspaceStateOf({ currentProjectPath: '/ws/default' })
      }
      return undefined
    })

    const view = renderDom(<ComposerContextBar />)
    try {
      clickTrigger(view.container, 'composer-workspace-trigger')
      const menu = view.container.querySelector('[data-testid="composer-workspace-menu"]')
      const target = [...(menu?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find(button =>
        button.textContent?.trim().startsWith('使用 Nova 工作区')
      )
      expect(target).toBeDefined()
      await act(async () => {
        target!.click()
      })
      expect(invoke).toHaveBeenCalledWith('workspace:select-default')
    } finally {
      view.unmount()
    }
  })
})
