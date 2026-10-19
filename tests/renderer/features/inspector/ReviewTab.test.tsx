// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@pierre/diffs', () => ({
  DEFAULT_VIRTUAL_FILE_METRICS: {
    lineHeight: 20,
    hunkSeparatorHeight: 20,
    spacing: 0
  }
}))

vi.mock('@pierre/diffs/react', async () => {
  const ReactModule = await import('react')
  return {
    VirtualizerContext: ReactModule.createContext(undefined),
    WorkerPoolContext: ReactModule.createContext(undefined),
    PatchDiff: () => ReactModule.createElement('div', { 'data-testid': 'pierre-diff' })
  }
})

vi.mock('../../../../src/renderer/features/diff/pierreVirtualizer', () => ({
  acquirePierreVirtualizer: () => ({
    virtualizer: {},
    release: () => undefined
  })
}))

import { ReviewTab } from '../../../../src/renderer/features/inspector/ReviewTab'
import { useFileTreeStore } from '../../../../src/renderer/features/inspector/useFileTreeStore'
import { resetLayoutStoreForTests, useLayoutStore } from '../../../../src/renderer/stores/useLayoutStore'
import { resetChatStoreForTests, useChatStore } from '../../../../src/renderer/stores/useChatStore'
import { act, renderDom } from '../../../unit/renderer/renderDom'
import type { DiffEntry } from '../../../../src/shared/diff/types'

function makeDiff(overrides: Partial<DiffEntry> = {}): DiffEntry {
  return {
    filePath: 'src/app.ts',
    status: 'modified',
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        content: ' keep\n-old\n+new1\n+new2'
      }
    ],
    ...overrides
  }
}

describe('ReviewTab', () => {
  beforeEach(() => {
    const map = new Map<string, string>()
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        get length() { return map.size },
        clear: () => map.clear(),
        getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
        key: (i: number) => Array.from(map.keys())[i] ?? null,
        removeItem: (k: string) => { map.delete(k) },
        setItem: (k: string, v: string) => { map.set(k, String(v)) }
      },
      configurable: true,
      writable: true
    })
    resetLayoutStoreForTests()
    resetChatStoreForTests()
  })

  it('无 diff 时显示明确的空状态', () => {
    const renderer = renderDom(<ReviewTab />)
    expect(renderer.container.textContent ?? '').toContain('当前会话暂无可审阅的文件改动')
    renderer.unmount()
  })

  it('给定 messageDiffs 与 reviewTarget 时默认折叠文件行，点击文件行或全部展开可切换 Diff 详情', async () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messageDiffs: {
        msg_1: {
          diffs: [
            makeDiff({ filePath: 'src/app.ts' }),
            makeDiff({ filePath: 'src/utils.ts' })
          ],
          reviews: {}
        }
      }
    })
    useLayoutStore.getState().openReview({ messageId: 'msg_1', filePath: 'src/app.ts' })

    const renderer = renderDom(<ReviewTab />)
    const text = renderer.container.textContent ?? ''
    expect(text).toContain('app.ts')
    expect(text).toContain('utils.ts')
    expect(text).toContain('+2')
    expect(text).toContain('-1')
    expect(text).toContain('修改')

    // 默认不直接展开大块 Diff，保持紧凑文件行
    expect(renderer.container.querySelectorAll('[data-testid="pierre-diff"]')).toHaveLength(0)

    // 点击第一行展开该文件 Diff（首次展开会触发 lazy HunkView 加载）
    const firstTrigger = renderer.container.querySelector<HTMLButtonElement>(
      '.inspector-review__file-trigger'
    )
    expect(firstTrigger).toBeTruthy()
    await act(async () => {
      firstTrigger?.click()
      await import('../../../../src/renderer/features/diff/diffLines')
      await import('../../../../src/renderer/features/diff/DiffPoolContextBridge')
    })
    expect(renderer.container.querySelectorAll('[data-testid="pierre-diff"]')).toHaveLength(1)

    // 点击“全部展开”展开所有文件 Diff，再点“全部收起”折叠全部
    const expandAllBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('全部展开')
    )
    expect(expandAllBtn).toBeTruthy()
    await act(async () => {
      expandAllBtn?.click()
    })
    expect(renderer.container.querySelectorAll('[data-testid="pierre-diff"]')).toHaveLength(2)

    const collapseAllBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('全部收起')
    )
    expect(collapseAllBtn).toBeTruthy()
    await act(async () => {
      collapseAllBtn?.click()
    })
    expect(renderer.container.querySelectorAll('[data-testid="pierre-diff"]')).toHaveLength(0)

    // 点击文件行右侧“打开”按钮可跳转到文件面板并选中对应文件
    const openFileBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').trim() === '打开'
    )
    expect(openFileBtn).toBeTruthy()
    act(() => {
      openFileBtn?.click()
    })
    expect(useLayoutStore.getState().inspectorTab).toBe('files')
    expect(useFileTreeStore.getState().selectedFile).toBe('src/app.ts')

    renderer.unmount()
  })

  it('reviewTarget 指向非当前会话的旧消息时自动回退到当前会话最新可审阅轮次', () => {
    useChatStore.setState({
      currentSessionId: 'sess_2',
      messages: [
        {
          id: 'msg_current',
          role: 'assistant',
          content: 'done',
          timestamp: 100
        }
      ],
      messageDiffs: {
        msg_current: {
          diffs: [makeDiff({ filePath: 'src/current.ts' })],
          reviews: {}
        }
      }
    })
    useLayoutStore.getState().openReview({ messageId: 'msg_stale_other_session', filePath: 'src/old.ts' })

    const renderer = renderDom(<ReviewTab />)
    expect(renderer.container.textContent ?? '').toContain('current.ts')
    renderer.unmount()
  })

  it('点击保留调用 acceptFile', async () => {
    const acceptFile = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messageDiffs: {
        msg_1: {
          diffs: [makeDiff()],
          reviews: {}
        }
      },
      acceptFile
    })
    useLayoutStore.getState().openReview({ messageId: 'msg_1', filePath: 'src/app.ts' })

    const renderer = renderDom(<ReviewTab />)
    const keepBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('保留')
    )
    expect(keepBtn).toBeTruthy()
    await act(async () => {
      keepBtn?.click()
    })
    expect(acceptFile).toHaveBeenCalledWith('sess_1', 'msg_1', 'src/app.ts')
    renderer.unmount()
  })

  it('消息在 tier1StaleDiffMessageIds 中时评审操作禁用并显示未同步提示', async () => {
    const acceptFile = vi.fn().mockResolvedValue(undefined)
    const rejectFile = vi.fn().mockResolvedValue(undefined)
    useChatStore.setState({
      currentSessionId: 'sess_1',
      // 横幅可被用户关闭，灰显标记才是安全禁用的权威来源：只种标记、不种横幅
      tier1BranchContext: null,
      tier1StaleDiffMessageIds: ['msg_1'],
      messageDiffs: {
        msg_1: {
          diffs: [makeDiff()],
          reviews: {}
        }
      },
      acceptFile,
      rejectFile
    })
    useLayoutStore.getState().openReview({ messageId: 'msg_1', filePath: 'src/app.ts' })

    const renderer = renderDom(<ReviewTab />)
    const keepBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('保留')
    ) as HTMLButtonElement | undefined
    const revertBtn = Array.from(renderer.container.querySelectorAll('button')).find(
      el => (el.textContent ?? '').includes('回退')
    ) as HTMLButtonElement | undefined
    expect(keepBtn?.disabled).toBe(true)
    expect(revertBtn?.disabled).toBe(true)
    expect(renderer.container.textContent ?? '').toContain('工作区未同步，仅作历史参考')

    // 即使绕过禁用直接触发，裁决动作也在组件层被 tier1Stale 守卫拦截，不落 IPC
    await act(async () => {
      keepBtn?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(acceptFile).not.toHaveBeenCalled()
    expect(rejectFile).not.toHaveBeenCalled()
    renderer.unmount()
  })
})
