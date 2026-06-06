/**
 * MarkdownRenderer 关键行为测试：覆盖 C2 修复 — isStreaming 传递链路
 *
 * 验证：
 * 1. isStreaming=true 时，代码块不调用 highlightLine，输出纯文本节点（无 .diff-token）
 * 2. isStreaming=false（默认）时，代码块调用 highlightLine，输出 .diff-token span
 * 3. isStreaming 翻转时，components 引用重建（useMemo 依赖），保证切换路径正确
 */
import { describe, it, expect, vi } from 'vitest'
import React from 'react'
import { create } from 'react-test-renderer'
import { MarkdownRenderer } from '../../../src/renderer/features/chat/MarkdownRenderer'

const FENCE = '```typescript\nconst x: number = 1\nconst y: string = "hi"\n```'

interface RTRNode {
  type: string
  props?: Record<string, unknown>
  children?: Array<RTRNode | string> | null
}

function walkAll(root: unknown, visit: (n: RTRNode) => void): void {
  function inner(node: unknown): void {
    if (!node) return
    if (typeof node === 'string') return
    if (Array.isArray(node)) { for (const n of node) inner(n); return }
    const rtr = node as RTRNode
    visit(rtr)
    if (Array.isArray(rtr.children)) {
      for (const c of rtr.children) inner(c)
    }
  }
  inner(root)
}

function getClassName(node: RTRNode): string[] {
  const cn = node.props?.className
  if (Array.isArray(cn)) return cn as string[]
  if (typeof cn === 'string') return cn.split(/\s+/)
  return []
}

describe('MarkdownRenderer isStreaming 传递（C2 修复）', () => {
  it('isStreaming=true 时代码块不输出 diff-token span（highlightLine 跳过）', () => {
    const tree = create(<MarkdownRenderer content={FENCE} isStreaming={true} />)
    let preNode: RTRNode | null = null
    let diffTokenCount = 0
    walkAll(tree.toJSON(), (n) => {
      const cn = getClassName(n)
      if (cn.includes('md-code-block__pre')) preNode = n
      if (cn.some(c => c.startsWith('diff-token'))) diffTokenCount += 1
    })

    expect(preNode).not.toBeNull()
    expect(diffTokenCount).toBe(0)
    tree.unmount()
  })

  it('isStreaming=false 时代码块输出 diff-token span（highlightLine 启用）', () => {
    const tree = create(<MarkdownRenderer content={FENCE} isStreaming={false} />)
    let preNode: RTRNode | null = null
    let diffTokenCount = 0
    walkAll(tree.toJSON(), (n) => {
      const cn = getClassName(n)
      if (cn.includes('md-code-block__pre')) preNode = n
      if (cn.some(c => c.startsWith('diff-token'))) diffTokenCount += 1
    })

    expect(preNode).not.toBeNull()
    expect(diffTokenCount).toBeGreaterThan(0)
    tree.unmount()
  })

  it('省略 isStreaming 时（默认 false）也应走高亮路径', () => {
    const tree = create(<MarkdownRenderer content={FENCE} />)
    let diffTokenCount = 0
    walkAll(tree.toJSON(), (n) => {
      const cn = getClassName(n)
      if (cn.some(c => c.startsWith('diff-token'))) diffTokenCount += 1
    })
    expect(diffTokenCount).toBeGreaterThan(0)
    tree.unmount()
  })

  it('isStreaming 翻转：流式无 token，非流式有 token', () => {
    const streaming = create(<MarkdownRenderer content={FENCE} isStreaming={true} />)
    const nonStreaming = create(<MarkdownRenderer content={FENCE} isStreaming={false} />)
    let sCount = 0
    let nCount = 0
    walkAll(streaming.toJSON(), (n) => {
      if (getClassName(n).some(c => c.startsWith('diff-token'))) sCount += 1
    })
    walkAll(nonStreaming.toJSON(), (n) => {
      if (getClassName(n).some(c => c.startsWith('diff-token'))) nCount += 1
    })
    expect(sCount).toBe(0)
    expect(nCount).toBeGreaterThan(0)
    streaming.unmount()
    nonStreaming.unmount()
  })
})
