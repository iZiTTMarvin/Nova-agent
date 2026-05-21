import { describe, it, expect } from 'vitest'
import { EventBus } from '../../../src/runtime/agent/EventBus'

describe('EventBus', () => {
  it('emit 向所有订阅者发送事件', () => {
    const bus = new EventBus()
    const received: unknown[] = []

    bus.on((event) => received.push(event))
    bus.on((event) => received.push(event))

    bus.emit({ type: 'message_start', messageId: 'm1' })

    expect(received).toHaveLength(2)
    expect(received[0]).toEqual({ type: 'message_start', messageId: 'm1' })
    expect(received[1]).toEqual({ type: 'message_start', messageId: 'm1' })
  })

  it('on 返回的函数可取消订阅', () => {
    const bus = new EventBus()
    const received: unknown[] = []

    const unsub = bus.on((event) => received.push(event))
    bus.emit({ type: 'message_end', messageId: 'm1' })
    expect(received).toHaveLength(1)

    unsub()
    bus.emit({ type: 'message_end', messageId: 'm2' })
    expect(received).toHaveLength(1)
  })

  it('clear 移除所有监听器', () => {
    const bus = new EventBus()
    const received: unknown[] = []

    bus.on((event) => received.push(event))
    bus.on((event) => received.push(event))

    bus.clear()
    bus.emit({ type: 'error', messageId: '', error: 'test' })

    expect(received).toHaveLength(0)
  })

  it('订阅者异常不影响其他订阅者', () => {
    const bus = new EventBus()
    let secondReceived = false

    bus.on(() => { throw new Error('boom') })
    bus.on(() => { secondReceived = true })

    bus.emit({ type: 'message_start', messageId: 'm1' })
    expect(secondReceived).toBe(true)
  })
})
