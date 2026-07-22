/**
 * steering queue 单测：同会话连发消息按 FIFO 排队。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  enqueueSteeringMessage,
  dequeueSteeringMessage,
  hasSteeringMessage,
  clearSteeringQueue,
  resetSteeringQueueForTests
} from '../../../src/main/agent/turn/SteeringQueue'

describe('SteeringQueue', () => {
  beforeEach(() => {
    resetSteeringQueueForTests()
  })
  afterEach(() => {
    resetSteeringQueueForTests()
  })

  it('空队列 dequeue 返回 undefined', () => {
    expect(dequeueSteeringMessage('s1')).toBeUndefined()
    expect(hasSteeringMessage('s1')).toBe(false)
  })

  it('enqueue / dequeue 保持 FIFO 顺序', () => {
    enqueueSteeringMessage('s1', { sessionId: 's1', content: 'first' })
    enqueueSteeringMessage('s1', { sessionId: 's1', content: 'second' })
    expect(hasSteeringMessage('s1')).toBe(true)

    expect(dequeueSteeringMessage('s1')?.content).toBe('first')
    expect(dequeueSteeringMessage('s1')?.content).toBe('second')
    expect(dequeueSteeringMessage('s1')).toBeUndefined()
    expect(hasSteeringMessage('s1')).toBe(false)
  })

  it('不同会话队列互不影响', () => {
    enqueueSteeringMessage('s1', { sessionId: 's1', content: 'a' })
    enqueueSteeringMessage('s2', { sessionId: 's2', content: 'b' })

    expect(dequeueSteeringMessage('s1')?.content).toBe('a')
    expect(hasSteeringMessage('s1')).toBe(false)
    expect(hasSteeringMessage('s2')).toBe(true)
    expect(dequeueSteeringMessage('s2')?.content).toBe('b')
  })

  it('clearSteeringQueue 清空指定会话', () => {
    enqueueSteeringMessage('s1', { sessionId: 's1', content: 'a' })
    enqueueSteeringMessage('s2', { sessionId: 's2', content: 'b' })
    clearSteeringQueue('s1')
    expect(hasSteeringMessage('s1')).toBe(false)
    expect(hasSteeringMessage('s2')).toBe(true)
  })

  it('enqueue 锁定归属会话', () => {
    enqueueSteeringMessage('s1', { sessionId: 'wrong', content: 'a' })
    const head = dequeueSteeringMessage('s1')
    expect(head?.sessionId).toBe('s1')
  })
})
