// @vitest-environment jsdom

import React, { createRef } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderDom } from './renderDom'
import type { DiffHunk } from '../../../src/shared/diff/types'

const mocks = vi.hoisted(() => ({
  patchDiff: vi.fn(),
  acquire: vi.fn(),
  release: vi.fn(),
  virtualizer: {}
}))

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
    PatchDiff: (props: Record<string, unknown>) => {
      mocks.patchDiff(props)
      return ReactModule.createElement('div', {
        'data-testid': 'pierre-diff',
        'data-patch': props.patch
      })
    }
  }
})

vi.mock('../../../src/renderer/features/diff/pierreVirtualizer', () => ({
  acquirePierreVirtualizer: (element: HTMLElement) => {
    mocks.acquire(element)
    return {
      virtualizer: mocks.virtualizer,
      release: mocks.release
    }
  }
}))

import {
  HunkView,
  PREVIEW_HUNK_LINE_LIMIT
} from '../../../src/renderer/features/diff/diffLines'

function makeHunk(lineCount: number): DiffHunk {
  const lines = Array.from({ length: lineCount }, (_, index) => (
    index % 2 === 0
      ? `+const value${index} = ${index}`
      : `-const old${index} = ${index}`
  ))

  return {
    oldStart: 1,
    oldLines: Math.floor(lineCount / 2),
    newStart: 1,
    newLines: Math.ceil(lineCount / 2),
    content: lines.join('\n')
  }
}

describe('HunkView Pierre 集成', () => {
  beforeEach(() => {
    mocks.patchDiff.mockClear()
    mocks.acquire.mockClear()
    mocks.release.mockClear()
  })

  it('复用 ReviewTab 外层滚动容器的 Pierre Virtualizer', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const renderer = renderDom(
      <div ref={scrollRef}>
        <HunkView
          hunk={makeHunk(20)}
          filePath="src/a.ts"
          scrollRef={scrollRef}
        />
      </div>
    )

    expect(mocks.acquire).toHaveBeenCalledTimes(1)
    expect(mocks.acquire).toHaveBeenCalledWith(scrollRef.current)
    expect(mocks.patchDiff).toHaveBeenCalledTimes(1)
    expect(mocks.patchDiff.mock.calls[0][0]).toMatchObject({
      disableWorkerPool: false
    })

    renderer.unmount()
    expect(mocks.release).toHaveBeenCalledTimes(1)
  })

  it('展开大 hunk 后仍走同一 Virtualizer，并向 Pierre 交付完整 patch', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const hunk = makeHunk(PREVIEW_HUNK_LINE_LIMIT + 20)
    const renderer = renderDom(
      <div ref={scrollRef}>
        <HunkView
          hunk={hunk}
          filePath="src/large.ts"
          scrollRef={scrollRef}
        />
      </div>
    )

    const initial = mocks.patchDiff.mock.calls.at(-1)?.[0] as { patch: string }
    expect(initial.patch).not.toContain(`value${PREVIEW_HUNK_LINE_LIMIT + 18}`)

    const expand = renderer.container.querySelector<HTMLButtonElement>('.diff-hunk__truncation')
    expect(expand).not.toBeNull()
    act(() => expand?.click())

    const expanded = mocks.patchDiff.mock.calls.at(-1)?.[0] as { patch: string }
    expect(expanded.patch).toContain(`value${PREVIEW_HUNK_LINE_LIMIT + 18}`)
    expect(mocks.acquire).toHaveBeenCalledTimes(1)

    renderer.unmount()
  })

  it('文本模式显式关闭 Worker 和昂贵高亮', () => {
    const renderer = renderDom(
      <HunkView
        hunk={makeHunk(4)}
        filePath="notes.txt"
        syntaxHighlight={false}
      />
    )

    expect(mocks.patchDiff.mock.calls.at(-1)?.[0]).toMatchObject({
      disableWorkerPool: true,
      options: {
        lineDiffType: 'none',
        maxLineDiffLength: 0,
        tokenizeMaxLineLength: 0
      }
    })

    renderer.unmount()
  })
})
