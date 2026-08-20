// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CodeIndexStatusDto } from '../../../src/shared/code-index'
import { CodeIndexStatusChip } from '../../../src/renderer/features/chat/CodeIndexStatusChip'
import { CodeIndexSettingsPanel } from '../../../src/renderer/features/settings/CodeIndexSettingsPanel'
import {
  resetCodeIndexStoreForTests,
  useCodeIndexStore
} from '../../../src/renderer/stores/useCodeIndexStore'
import {
  resetSettingsStoreForTests,
  useSettingsStore
} from '../../../src/renderer/stores/useSettingsStore'
import { act, renderDom } from './renderDom'

const invoke = vi.fn()

describe('代码索引 UI 投影', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetCodeIndexStoreForTests()
    resetSettingsStoreForTests()
    sessionStorage.clear()
    Object.assign(window, {
      api: {
        invoke,
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    })
  })

  it('设置面板明确展示新会话边界、自然状态、错误类别与折叠覆盖率', async () => {
    const current = snapshot('C:\\repo', 4, 'degraded')
    useSettingsStore.setState({ currentProject: 'C:\\repo' })
    useCodeIndexStore.setState({
      currentWorkspaceRoot: 'C:\\repo',
      snapshotsByWorkspaceRoot: { 'C:\\repo': current },
    })
    invoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') {
        return Promise.resolve({ codeIndexEnabled: true })
      }
      if (channel === 'codeindex:get-status') return Promise.resolve(current)
      return Promise.resolve(undefined)
    })

    const renderer = renderDom(<CodeIndexSettingsPanel />)
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('对新建会话生效，不影响正在进行的会话。')
    expect(text).toContain('索引只保存结构信息，不复制源码')
    expect(text).toContain('部分可用，需要检查')
    expect(text).toContain('文件监听异常')
    const details = renderer.container.querySelector('details')
    expect(details?.open).toBe(false)
    renderer.unmount()
  })

  it('健康和增量更新保持静默，首次构建显示进度，异常可进入设置', () => {
    useCodeIndexStore.setState({
      currentWorkspaceRoot: 'C:\\repo',
      snapshotsByWorkspaceRoot: { 'C:\\repo': snapshot('C:\\repo', 1, 'ready') }
    })
    const renderer = renderDom(<CodeIndexStatusChip />)
    expect(renderer.container.textContent).toBe('')

    act(() => {
      useCodeIndexStore.setState({
        snapshotsByWorkspaceRoot: { 'C:\\repo': snapshot('C:\\repo', 2, 'updating') }
      })
    })
    expect(renderer.container.textContent).toBe('')

    act(() => {
      useCodeIndexStore.setState({
        snapshotsByWorkspaceRoot: { 'C:\\repo': snapshot('C:\\repo', 3, 'building') }
      })
    })
    expect(renderer.container.textContent).toContain('建立代码索引 2/10')

    act(() => {
      useCodeIndexStore.setState({
        snapshotsByWorkspaceRoot: { 'C:\\repo': snapshot('C:\\repo', 4, 'degraded') }
      })
    })
    const button = renderer.container.querySelector('button')
    expect(button?.textContent).toContain('代码索引不可用')
    act(() => button?.click())
    expect(useSettingsStore.getState().isConfigModalOpen).toBe(true)
    expect(sessionStorage.getItem('nova-settings-nav')).toBe('codeindex')
    renderer.unmount()
  })

  it('首次构建尚未拿到总量时不显示 0/0', () => {
    useCodeIndexStore.setState({
      currentWorkspaceRoot: 'C:\\repo',
      snapshotsByWorkspaceRoot: {
        'C:\\repo': {
          ...snapshot('C:\\repo', 1, 'building'),
          progress: { completed: 0, total: 0 }
        }
      }
    })

    const renderer = renderDom(<CodeIndexStatusChip />)
    expect(renderer.container.textContent).toContain('建立代码索引')
    expect(renderer.container.textContent).not.toContain('0/0')
    renderer.unmount()
  })
})

function snapshot(
  workspaceRoot: string,
  sequence: number,
  status: CodeIndexStatusDto['status']
): CodeIndexStatusDto {
  return {
    workspaceRoot,
    sequence,
    enabled: true,
    status,
    activeGeneration: status === 'building' ? null : 1,
    revision: status === 'building' ? 0 : 2,
    coverage: {
      eligibleFiles: 10,
      indexedFiles: status === 'building' ? 2 : 10,
      parseFailures: 1,
      unsupportedFiles: 2,
      oversizedFiles: 1,
      unresolvedRelations: 3
    },
    progress: status === 'building' ? { completed: 2, total: 10 } : null,
    lastCompletedAt: status === 'building' ? null : Date.now(),
    failure: status === 'degraded'
      ? { code: 'watcher_failed', message: 'watch failed' }
      : null,
    workerState: status === 'building' ? 'running' : 'idle',
    databaseBytes: 1024
  }
}
