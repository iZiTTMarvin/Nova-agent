/**
 * normalizeTodos 单元测试（shared 层，runtime 与 renderer 共用）
 */
import { describe, expect, it } from 'vitest'
import { normalizeTodos } from '../../../../src/shared/todo/normalize'

describe('normalizeTodos', () => {
  it('正常字段透传', () => {
    const result = normalizeTodos([
      { content: 'A', status: 'in_progress', priority: 'high' },
      { content: 'B', status: 'completed', priority: 'low' }
    ])
    expect(result).toEqual([
      { content: 'A', status: 'in_progress', priority: 'high' },
      { content: 'B', status: 'completed', priority: 'low' }
    ])
  })

  it('缺 status → pending', () => {
    const result = normalizeTodos([{ content: 'A', priority: 'high' }])
    expect(result[0].status).toBe('pending')
  })

  it('缺 priority → medium', () => {
    const result = normalizeTodos([{ content: 'A', status: 'pending' }])
    expect(result[0].priority).toBe('medium')
  })

  it('空 content → 丢弃', () => {
    const result = normalizeTodos([
      { content: '', status: 'pending', priority: 'medium' },
      { content: '   ', status: 'pending', priority: 'medium' },
      { content: 'Real', status: 'pending', priority: 'medium' }
    ])
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('Real')
  })

  it('非法 status → 降级 pending', () => {
    const result = normalizeTodos([{ content: 'A', status: 'weird', priority: 'high' }])
    expect(result[0].status).toBe('pending')
  })

  it('非法 priority → 降级 medium', () => {
    const result = normalizeTodos([{ content: 'A', status: 'pending', priority: 'urgent' }])
    expect(result[0].priority).toBe('medium')
  })

  it('非数组输入 → 空数组', () => {
    expect(normalizeTodos(null)).toEqual([])
    expect(normalizeTodos({})).toEqual([])
    expect(normalizeTodos('hello')).toEqual([])
  })

  it('非对象条目直接跳过', () => {
    const result = normalizeTodos([null, 'string', 42, { content: 'OK', status: 'pending', priority: 'high' }])
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('OK')
  })
})
