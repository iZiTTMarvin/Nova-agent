// @vitest-environment jsdom

import React, { createRef } from 'react'
import { describe, expect, it } from 'vitest'
import { HunkView, VIRTUALIZE_HUNK_LINE_THRESHOLD } from '../../../src/renderer/features/diff/diffLines'
import { act, renderDom } from './renderDom'
import type { DiffHunk } from '../../../src/shared/diff/types'

function makeHunk(lineCount: number): DiffHunk {
  const lines: string[] = []
  for (let i = 0; i < lineCount; i++) {
    if (i % 3 === 0) lines.push(`+const value${i} = call(${i});`)
    else if (i % 3 === 1) lines.push(`-const old${i} = legacy(${i});`)
    else lines.push(` context line ${i}`)
  }
  return {
    oldStart: 1,
    oldLines: lineCount,
    newStart: 1,
    newLines: lineCount,
    content: lines.join('\n')
  }
}

describe('HunkView 虚拟化', () => {
  it('小 hunk（≤阈值）全量渲染', () => {
    const hunk = makeHunk(10)
    const renderer = renderDom(<HunkView hunk={hunk} filePath="a.ts" />)
    const rows = renderer.container.querySelectorAll('.diff-line')
    expect(rows.length).toBe(10)
    renderer.unmount()
  })

  it('大 hunk（>阈值）走虚拟化：挂载行数有界，不随总行数线性增长', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const big = makeHunk(1000)
    const lineCount = big.content.split('\n').length
    const renderer = renderDom(
      <div ref={scrollRef} style={{ height: 400, overflow: 'auto' }}>
        <HunkView hunk={big} filePath="a.ts" scrollRef={scrollRef} />
      </div>
    )
    const rows = renderer.container.querySelectorAll('.diff-line')
    // 虚拟化：只渲染可见窗口 + overscan，远小于总行数
    expect(rows.length).toBeLessThan(200)
    expect(rows.length).toBeGreaterThan(0)
    // 虚拟容器高度 = 全部行高（虚拟化路径不再截断，撑起完整滚动条）
    const virtual = renderer.container.querySelector<HTMLElement>('.diff-hunk__virtual')
    expect(virtual?.style.height).toBe(`${lineCount * 22}px`)
    renderer.unmount()
  })

  it('wrap 模式禁用虚拟化（行高不固定会错位）', () => {
    const scrollRef = createRef<HTMLDivElement>()
    const big = makeHunk(200)
    const renderer = renderDom(
      <div ref={scrollRef} style={{ height: 400, overflow: 'auto' }}>
        <HunkView hunk={big} filePath="a.ts" scrollRef={scrollRef} wrap />
      </div>
    )
    const rows = renderer.container.querySelectorAll('.diff-line')
    expect(rows.length).toBe(200)
    expect(renderer.container.querySelector('.diff-hunk__virtual')).toBeNull()
    renderer.unmount()
  })

  it('阈值常量已导出且合理', () => {
    expect(VIRTUALIZE_HUNK_LINE_THRESHOLD).toBeGreaterThan(0)
  })
})
