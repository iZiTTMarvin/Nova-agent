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

  it('无 diff 时展示空态', () => {
    const renderer = renderDom(<ReviewTab />)
    expect(renderer.container.textContent ?? '').toContain('暂无可审查的文件变更')
    renderer.unmount()
  })

  it('给定 messageDiffs 与 reviewTarget 时渲染文件名与增删统计', () => {
    useChatStore.setState({
      currentSessionId: 'sess_1',
      messageDiffs: {
        msg_1: {
          diffs: [makeDiff()],
          reviews: {}
        }
      }
    })
    useLayoutStore.getState().openReview({ messageId: 'msg_1', filePath: 'src/app.ts' })

    const renderer = renderDom(<ReviewTab />)
    const text = renderer.container.textContent ?? ''
    expect(text).toContain('app.ts')
    expect(text).toContain('+2')
    expect(text).toContain('-1')
    expect(text).toContain('修改')
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
