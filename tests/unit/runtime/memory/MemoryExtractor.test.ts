/**
 * MemoryExtractor 单测（mock deps.chat）
 */
import { describe, it, expect, vi } from 'vitest'
import { MemoryExtractor, parseExtractedJson } from '../../../../src/runtime/memory/MemoryExtractor'

const VALID_JSON = JSON.stringify([
  {
    userNeed: '部署流程太慢',
    approach: '改用 wasm 打包',
    outcome: '构建成功完成',
    whatFailed: 'better-sqlite3 wasm 失败',
    whatWorked: '回退原生模块',
    tags: ['sqlite', 'build']
  }
])

describe('MemoryExtractor', () => {
  it('正常解析返回结构化数组', async () => {
    const extractor = new MemoryExtractor({
      chat: vi.fn().mockResolvedValue(VALID_JSON)
    })
    const result = await extractor.extract({
      recentMessages: [{ role: 'user', content: '帮我优化构建' }],
      observations: []
    })
    expect(result).toHaveLength(1)
    expect(result?.[0].userNeed).toBe('部署流程太慢')
    expect(result?.[0].tags).toEqual(['sqlite', 'build'])
  })

  it('JSON 解析失败返回 null', async () => {
    const extractor = new MemoryExtractor({
      chat: vi.fn().mockResolvedValue('not json')
    })
    const result = await extractor.extract({
      recentMessages: [{ role: 'user', content: 'test' }],
      observations: []
    })
    expect(result).toBeNull()
  })

  it('网络异常返回 null（fail-soft）', async () => {
    const extractor = new MemoryExtractor({
      chat: vi.fn().mockRejectedValue(new Error('network'))
    })
    const result = await extractor.extract({
      recentMessages: [{ role: 'user', content: 'test' }],
      observations: []
    })
    expect(result).toBeNull()
  })

  it('空输入返回 null', async () => {
    const chat = vi.fn()
    const extractor = new MemoryExtractor({ chat })
    const result = await extractor.extract({ recentMessages: [], observations: [] })
    expect(result).toBeNull()
    expect(chat).not.toHaveBeenCalled()
  })

  it('字段缺失的条目被丢弃', () => {
    const parsed = parseExtractedJson(
      JSON.stringify([
        { userNeed: 'a', approach: 'b', outcome: 'c', whatFailed: '', whatWorked: '', tags: [] },
        { userNeed: '', approach: 'b', outcome: 'c' }
      ])
    )
    expect(parsed).toHaveLength(1)
  })
})
