import { describe, expect, it } from 'vitest'
import { sliceMessagesPage } from '../../../../src/runtime/sessions/SessionStore'
import type { SessionMessage } from '../../../../src/runtime/sessions/types'

function makeMsg(id: string): SessionMessage {
  return { id, role: 'user', content: id, timestamp: 1 }
}

describe('sliceMessagesPage', () => {
  const all = Array.from({ length: 25 }, (_, i) => makeMsg(`m${i}`))

  it('limit<=0 返回空', () => {
    expect(sliceMessagesPage(all, { limit: 0 })).toEqual({ messages: [], hasMore: false })
  })

  it('无 beforeId 取尾部', () => {
    const page = sliceMessagesPage(all, { limit: 10 })
    expect(page.messages.map(m => m.id)).toEqual(
      ['m15', 'm16', 'm17', 'm18', 'm19', 'm20', 'm21', 'm22', 'm23', 'm24']
    )
    expect(page.hasMore).toBe(true)
  })

  it('beforeId 在第一页边界', () => {
    const page = sliceMessagesPage(all, { beforeId: 'm10', limit: 10 })
    expect(page.messages[0].id).toBe('m0')
    expect(page.messages[9].id).toBe('m9')
    expect(page.hasMore).toBe(false)
  })

  it('损坏游标 beforeId 不存在', () => {
    expect(sliceMessagesPage(all, { beforeId: 'nope', limit: 5 })).toEqual({
      messages: [],
      hasMore: false
    })
  })
})
