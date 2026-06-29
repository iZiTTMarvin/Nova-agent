/**
 * todoSnapshot 单元测试
 */
import { describe, expect, it } from 'vitest'
import {
  parseTodoSnapshot,
  countTodoProgress,
  splitTodoContentSegments
} from '../../../src/renderer/features/chat/todoSnapshot'

describe('parseTodoSnapshot', () => {
  it('从 args.todos 解析并 normalize', () => {
    const todos = parseTodoSnapshot({
      todos: [
        { content: '任务 A', status: 'completed', priority: 'high' },
        { content: '任务 B', status: 'in_progress', priority: 'medium' }
      ]
    })
    expect(todos).toHaveLength(2)
    expect(todos[0].status).toBe('completed')
  })

  it('空/脏数据返回空数组', () => {
    expect(parseTodoSnapshot({})).toEqual([])
    expect(parseTodoSnapshot({ todos: null })).toEqual([])
  })
})

describe('countTodoProgress', () => {
  it('completed 不含 cancelled', () => {
    const { completed, total } = countTodoProgress([
      { content: 'A', status: 'completed', priority: 'medium' },
      { content: 'B', status: 'cancelled', priority: 'medium' },
      { content: 'C', status: 'pending', priority: 'medium' }
    ])
    expect(completed).toBe(1)
    expect(total).toBe(3)
  })
})

describe('splitTodoContentSegments', () => {
  it('反引号内容高亮为 code', () => {
    const segs = splitTodoContentSegments('检查 `webSearchTool.ts` 注释')
    expect(segs).toContainEqual({ type: 'code', value: 'webSearchTool.ts' })
  })

  it('文件路径自动高亮', () => {
    const segs = splitTodoContentSegments('读取 src/foo.ts 文件')
    expect(segs.some(s => s.type === 'code' && s.value === 'foo.ts')).toBe(true)
  })
})
