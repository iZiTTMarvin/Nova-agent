/**
 * readState 按会话隔离单测：不同会话的 readState 互不串污染。
 *
 * 不启动 Electron：直接调用 AgentExecutionStateHost 的纯函数。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  getReadStateForSession,
  clearReadStateForSession,
  deleteReadStateForSession,
  resetReadStateHostForTests,
  isSessionTurnInProgress,
  isAgentTurnInProgress
} from '../../../src/main/agent/state'

// RunCoordinatorHost 在未初始化时会抛错，state 模块已捕获并回退，这里不初始化即可测试纯 readState。

describe('readState 按会话隔离', () => {
  beforeEach(() => {
    resetReadStateHostForTests()
  })
  afterEach(() => {
    resetReadStateHostForTests()
  })

  it('不同会话拿到独立 readState 实例', () => {
    const a = getReadStateForSession('s1')
    const b = getReadStateForSession('s2')
    expect(a).not.toBe(b)

    a.set('/x', { content: 'hello', timestamp: 1 })
    expect(a.has('/x')).toBe(true)
    expect(b.has('/x')).toBe(false)
  })

  it('同会话多次获取复用同一实例', () => {
    const a1 = getReadStateForSession('s1')
    const a2 = getReadStateForSession('s1')
    expect(a1).toBe(a2)
  })

  it('clearReadStateForSession 只清目标会话', () => {
    const a = getReadStateForSession('s1')
    const b = getReadStateForSession('s2')
    a.set('/x', { content: 'a', timestamp: 1 })
    b.set('/y', { content: 'b', timestamp: 1 })

    clearReadStateForSession('s1')
    expect(a.has('/x')).toBe(false)
    expect(b.has('/y')).toBe(true)
  })

  it('deleteReadStateForSession 彻底回收（下次拿到新实例）', () => {
    const a1 = getReadStateForSession('s1')
    deleteReadStateForSession('s1')
    const a2 = getReadStateForSession('s1')
    expect(a1).not.toBe(a2)
  })

  it('isSessionTurnInProgress / isAgentTurnInProgress 在未初始化时不抛错', () => {
    // 未初始化 RunCoordinator 时回退到 activeRunId null
    expect(() => isSessionTurnInProgress('s1')).not.toThrow()
    expect(() => isAgentTurnInProgress()).not.toThrow()
    expect(isSessionTurnInProgress('s1')).toBe(false)
    expect(isAgentTurnInProgress()).toBe(false)
  })
})
