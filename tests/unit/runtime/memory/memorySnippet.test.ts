/**
 * 文档记忆片段提取测试：prefetch 注入块与 memory_search 共用的片段口径。
 */
import { describe, it, expect } from 'vitest'
import { extractMemorySnippet } from '../../../../src/runtime/memory/memorySnippet'

describe('extractMemorySnippet', () => {
  it('短正文不截断', () => {
    const body = '用户要求注释一律使用中文。'
    expect(extractMemorySnippet(body, '使用中文')).toBe(body)
  })

  it('长正文围绕 query 子串截取片段，非整篇', () => {
    const prefix = 'a'.repeat(200)
    const hit = '用户要求注释一律使用中文。'
    const suffix = 'b'.repeat(200)
    const body = `${prefix}\n${hit}\n${suffix}`
    const snippet = extractMemorySnippet(body, '使用中文', 80)
    expect(snippet.length).toBeLessThanOrEqual(80)
    expect(snippet).toContain('使用中文')
    expect(snippet.length).toBeLessThan(body.length)
  })

  it('query 无可定位子串时按行/标题边界截断', () => {
    const body = ['## A', 'a'.repeat(100), '## B', 'b'.repeat(100)].join('\n')
    const snippet = extractMemorySnippet(body, '', 60)
    expect(snippet.length).toBeLessThanOrEqual(60)
    expect(snippet).toContain('## A')
    expect(snippet).not.toContain('## B')
  })
})
