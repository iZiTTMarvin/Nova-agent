import { describe, it, expect } from 'vitest'
import {
  extractUserIntent,
  buildSearchQueryFromIntent,
  extractMemorySnippet,
  buildL2TailBlock,
  buildL2ContextMessage,
  createMemoryContextHook,
  L2_BLOCK_TITLE
} from '../../../../src/runtime/memory/MemoryTailInjector'
import type { MemorySearchHit } from '../../../../src/runtime/memory/types'

describe('extractUserIntent', () => {
  it('拼接会话标题、最近 user 消息与本轮输入', () => {
    const q = extractUserIntent({
      sessionTitle: '修复登录 bug',
      recentUserMessages: ['先看 auth 模块', '再查 token 刷新'],
      currentUserText: '用中文注释'
    })
    expect(q).toContain('修复登录 bug')
    expect(q).toContain('先看 auth 模块')
    expect(q).toContain('用中文注释')
  })

  it('最多叠加最近 2 条 user 消息', () => {
    const q = extractUserIntent({
      recentUserMessages: ['m1', 'm2', 'm3'],
      currentUserText: 'current'
    })
    expect(q).not.toContain('m1')
    expect(q).toContain('m2')
    expect(q).toContain('m3')
    expect(q).toContain('current')
  })
})

describe('buildSearchQueryFromIntent', () => {
  it('优先取末行 CJK 子串作 FTS query，避免英文标题稀释 trigram', () => {
    const intent = extractUserIntent({
      sessionTitle: 'Nova Project',
      recentUserMessages: ['上次说过注释语言的事'],
      currentUserText: '继续用中文写注释'
    })
    expect(buildSearchQueryFromIntent(intent)).toBe('继续用中文写注释')
  })
})

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
})

describe('buildL2TailBlock', () => {
  it('无命中返回空串', () => {
    expect(buildL2TailBlock([], 'query')).toBe('')
  })

  it('格式化命中为 snippet 块', () => {
    const longBody = [
      '前言 ' + 'x'.repeat(300),
      '用户要求注释一律使用中文。',
      '后记 ' + 'y'.repeat(300)
    ].join('\n')
    const longHits: MemorySearchHit[] = [
      { scopeId: 'abc', relPath: 'MEMORY.md', body: longBody, score: 1.5 }
    ]
    const block = buildL2TailBlock(longHits, '使用中文')
    expect(block).toContain(L2_BLOCK_TITLE)
    expect(block).toContain('[MEMORY.md]')
    expect(block).toContain('使用中文')
    expect(block.length).toBeLessThan(longBody.length)
  })
})

describe('createMemoryContextHook', () => {
  it('基于原始 payload 尾部追加 L2（last-writer-wins 契约）', async () => {
    const l2 = buildL2ContextMessage('=== Relevant Memory ===\n片段')!
    const hook = createMemoryContextHook(l2)
    const payload = {
      event: 'context' as const,
      messageId: 'm1',
      messages: [
        { role: 'system' as const, content: 'sys' },
        { role: 'user' as const, content: 'hello' }
      ]
    }
    const result = hook(payload)
    expect(result?.messages).toHaveLength(3)
    expect(result?.messages?.[2]).toEqual(l2)
    expect(l2.skipCacheMarker).toBe(true)
    // 原始 payload 未被变异
    expect(payload.messages).toHaveLength(2)
  })
})
