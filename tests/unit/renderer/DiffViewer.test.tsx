// @vitest-environment jsdom

import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { DiffViewer } from '../../../src/renderer/features/diff/DiffViewer'
import type { DiffEntry, SkippedFileInfo } from '../../../src/shared/diff/types'
import { act, renderDom } from './renderDom'

/** 构造一个最小 DiffEntry */
function makeDiff(overrides: Partial<DiffEntry> = {}): DiffEntry {
  return {
    filePath: 'src/a.ts',
    hunks: [],
    status: 'modified',
    ...overrides
  }
}

describe('DiffViewer', () => {
  it('渲染 skippedFiles 提示列表', () => {
    const skippedFiles: SkippedFileInfo[] = [
      { path: 'assets/big.bin', reason: 'oversized', bytes: 6 * 1024 * 1024 },
      { path: 'node_modules/foo/index.js', reason: 'excluded', bytes: 0 }
    ]

    const renderer = renderDom(
      <DiffViewer
        diffs={[makeDiff()]}
        reviews={{}}
        skippedFiles={skippedFiles}
        sessionId="sess_1"
        messageId="msg_1"
      />
    )

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('未生成快照')
    expect(text).toContain('assets/big.bin')
    expect(text).toContain('node_modules/foo/index.js')
    expect(text).toContain('过大')
    expect(text).toContain('排除规则')
    renderer.unmount()
  })

  it('无 diff 但有 skippedFiles 时仍渲染提示', () => {
    const skippedFiles: SkippedFileInfo[] = [
      { path: 'huge.zip', reason: 'oversized', bytes: 1024 * 1024 * 1024 }
    ]

    const renderer = renderDom(
      <DiffViewer
        diffs={[]}
        reviews={{}}
        skippedFiles={skippedFiles}
        sessionId="sess_1"
        messageId="msg_1"
      />
    )

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('huge.zip')
    renderer.unmount()
  })

  it('合并卡片头部：已编辑文件数 + 总增删统计 + 每文件统计', () => {
    const diffs = [
      makeDiff({
        filePath: 'src/a.ts',
        hunks: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, content: '+new1\n+new2\n ctx\n-old1' }]
      }),
      makeDiff({
        filePath: 'src/b.ts',
        hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, content: '+only' }]
      })
    ]

    const renderer = renderDom(
      <DiffViewer diffs={diffs} reviews={{}} sessionId="sess_1" messageId="msg_1" />
    )

    expect(renderer.container.textContent ?? '').toContain('已编辑 2 个文件')
    // 总计 +3 -1（只按 +/- 前缀行计数，不含上下文行）
    const statText = (cls: string) => renderer.container.querySelector(`.${cls.split(' ').join('.')}`)?.textContent ?? ''
    expect(statText('diff-viewer__stat diff-viewer__stat--added')).toBe('+3')
    expect(statText('diff-viewer__stat diff-viewer__stat--removed')).toBe('-1')
    // 每文件行各自的增删统计
    const perFile = Array.from(renderer.container.querySelectorAll('.diff-file__changes-add'))
      .map(node => node.textContent ?? '')
    expect(perFile).toEqual(['+2', '+1'])
    renderer.unmount()
  })

  it('超过 3 个文件时默认折叠并显示「再显示 N 个文件」', () => {
    const diffs = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map(filePath => makeDiff({ filePath }))

    const renderer = renderDom(
      <DiffViewer diffs={diffs} reviews={{}} sessionId="sess_1" messageId="msg_1" />
    )

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('已编辑 5 个文件')
    expect(text).toContain('c.ts')
    expect(text).not.toContain('d.ts')

    const showMore = renderer.container.querySelector('.diff-viewer__show-more')
    const label = showMore?.textContent ?? ''
    expect(label).toBe('再显示 2 个文件')
    renderer.unmount()
  })

  it('待审阅时头部提供撤销/接受批量操作', () => {
    const onAcceptAll = vi.fn().mockResolvedValue(undefined)
    const onRejectAll = vi.fn().mockResolvedValue({ restored: [], failed: [] })

    const renderer = renderDom(
      <DiffViewer
        diffs={[makeDiff()]}
        reviews={{}}
        sessionId="sess_1"
        messageId="msg_1"
        onAcceptAll={onAcceptAll}
        onRejectAll={onRejectAll}
      />
    )

    const text = renderer.container.textContent ?? ''
    expect(text).toContain('撤销')
    expect(text).toContain('接受')

    const acceptBtn = renderer.container.querySelector<HTMLButtonElement>('.diff-header-btn--primary')
    expect(acceptBtn).not.toBeNull()
    act(() => {
      acceptBtn?.click()
    })
    expect(onAcceptAll).toHaveBeenCalledWith(['src/a.ts'])
    renderer.unmount()
  })

  it('点击文件行打开 Inspector 审查，不内联展开 hunk', async () => {
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

    const { useLayoutStore, resetLayoutStoreForTests } = await import(
      '../../../src/renderer/stores/useLayoutStore'
    )
    resetLayoutStoreForTests()

    const diffs = [
      makeDiff({
        filePath: 'src/a.ts',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: '+line' }]
      })
    ]

    const renderer = renderDom(
      <DiffViewer diffs={diffs} reviews={{}} sessionId="sess_1" messageId="msg_open" />
    )

    expect(renderer.container.querySelector('.diff-file__body')).toBeNull()
    expect(renderer.container.querySelector('.diff-hunk')).toBeNull()

    const header = renderer.container.querySelector('.diff-file__header')
    expect(header).not.toBeNull()
    act(() => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    const layout = useLayoutStore.getState()
    expect(layout.inspectorOpen).toBe(true)
    expect(layout.inspectorTab).toBe('review')
    expect(layout.reviewTarget).toEqual({ messageId: 'msg_open', filePath: 'src/a.ts' })
    renderer.unmount()
  })

  it('无 messageId 时文件头不绑定 Inspector 点击（会话级聚合视图）', async () => {
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

    const { useLayoutStore, resetLayoutStoreForTests } = await import(
      '../../../src/renderer/stores/useLayoutStore'
    )
    resetLayoutStoreForTests()

    const diffs = [
      makeDiff({
        filePath: 'src/a.ts',
        hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: '+line' }]
      })
    ]

    const renderer = renderDom(
      <DiffViewer diffs={diffs} reviews={{}} sessionId="sess_1" />
    )

    const header = renderer.container.querySelector('.diff-file__header')
    expect(header).not.toBeNull()
    expect(header?.getAttribute('role')).toBeNull()
    expect(header?.className).toContain('diff-file__header--static')
    act(() => {
      header?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(useLayoutStore.getState().reviewTarget).toBeNull()
    expect(useLayoutStore.getState().inspectorOpen).toBe(false)
    renderer.unmount()
  })
})
