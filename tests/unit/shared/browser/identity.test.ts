import { describe, expect, it } from 'vitest'
import { createBrowserIdentityLedger } from '../../../../src/shared/browser'

describe('browser 逻辑身份不可复用', () => {
  it('活页达到上限后拒绝再发，关闭后可发新的 browserId', () => {
    const ledger = createBrowserIdentityLedger()
    const first = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    const second = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value.browserId).not.toBe(second.value.browserId)

    const overflow = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    expect(overflow).toEqual({ ok: false, code: 'resource_limit' })

    expect(ledger.retire(first.value.browserId).ok).toBe(true)
    expect(ledger.inspect(first.value.browserId, 'sess_1')).toEqual({
      ok: false,
      code: 'page_closed'
    })

    const third = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.value.browserId).not.toBe(first.value.browserId)
    expect(third.value.generation).toBe(1)
  })

  it('同一 browserId 退役后即使工厂返回旧值也不能再发给新页', () => {
    const ledger = createBrowserIdentityLedger({
      createBrowserId: () => 'brw_reused'
    })
    const issued = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    expect(issued.ok).toBe(true)
    if (!issued.ok) return
    expect(issued.value.browserId).toBe('brw_reused')
    expect(ledger.retire('brw_reused').ok).toBe(true)
    expect(() => ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })).toThrow(
      /browserId/
    )
  })

  it('接管提升 generation 后旧观察失效，且旧 generation 不能再匹配', () => {
    const ledger = createBrowserIdentityLedger()
    const page = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    const observation = ledger.issueObservation(page.value.browserId)
    expect(observation.ok).toBe(true)
    if (!observation.ok) return
    expect(observation.value.generation).toBe(1)

    const bumped = ledger.bumpGeneration(page.value.browserId)
    expect(bumped.ok).toBe(true)
    if (!bumped.ok) return
    expect(bumped.value.generation).toBe(2)
    expect(ledger.matchObservation(observation.value, 'sess_1')).toEqual({
      ok: false,
      code: 'taken_over'
    })
  })

  it('文档换代或新观察会让旧 observationId 失效', () => {
    const ledger = createBrowserIdentityLedger()
    const page = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    expect(page.ok).toBe(true)
    if (!page.ok) return

    const first = ledger.issueObservation(page.value.browserId)
    const second = ledger.issueObservation(page.value.browserId)
    expect(first.ok && second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(first.value.observationId).not.toBe(second.value.observationId)
    expect(ledger.matchObservation(first.value, 'sess_1')).toEqual({
      ok: false,
      code: 'stale_observation'
    })
    expect(ledger.matchObservation(second.value, 'sess_1').ok).toBe(true)

    expect(ledger.bumpDocumentEpoch(page.value.browserId).ok).toBe(true)
    expect(ledger.matchObservation(second.value, 'sess_1')).toEqual({
      ok: false,
      code: 'stale_observation'
    })
  })

  it('其他会话不能占用页面身份；关闭后匹配为 page_closed', () => {
    const ledger = createBrowserIdentityLedger()
    const page = ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    const observation = ledger.issueObservation(page.value.browserId)
    expect(observation.ok).toBe(true)
    if (!observation.ok) return

    expect(ledger.matchObservation(observation.value, 'sess_other')).toEqual({
      ok: false,
      code: 'not_owner'
    })
    expect(ledger.inspect(page.value.browserId, 'sess_other')).toEqual({
      ok: false,
      code: 'not_owner'
    })
    expect(ledger.retire(page.value.browserId).ok).toBe(true)
    expect(ledger.matchObservation(observation.value, 'sess_1')).toEqual({
      ok: false,
      code: 'page_closed'
    })
  })
})

describe('browser 用户作用域页面', () => {
  it('sessionId=null 发放用户页：不记 workspaceKey，AI 会话身份不可见', () => {
    const ledger = createBrowserIdentityLedger()
    const page = ledger.issuePage({ sessionId: null })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.value.sessionId).toBeNull()
    expect(page.value.workspaceKey).toBeNull()

    // 任何 AI 会话都看不到用户页；只有 null 作用域能检查
    expect(ledger.inspect(page.value.browserId, 'sess_1')).toEqual({ ok: false, code: 'not_owner' })
    expect(ledger.inspect(page.value.browserId, null).ok).toBe(true)
  })

  it('用户页与 AI 页分开计数：AI 2 页满后仍可发用户页，用户页第 5 个被拒', () => {
    const ledger = createBrowserIdentityLedger()
    for (let i = 0; i < 2; i++) {
      expect(ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' }).ok).toBe(true)
    }
    expect(ledger.issuePage({ sessionId: 'sess_1', workspaceKey: 'ws_a' })).toEqual({
      ok: false,
      code: 'resource_limit'
    })
    const userIds: string[] = []
    for (let i = 0; i < 4; i++) {
      const issued = ledger.issuePage({ sessionId: null })
      expect(issued.ok).toBe(true)
      if (!issued.ok) return
      userIds.push(issued.value.browserId)
    }
    expect(ledger.issuePage({ sessionId: null })).toEqual({ ok: false, code: 'resource_limit' })
    // 退役一个用户页后又能发
    expect(ledger.retire(userIds[0]!).ok).toBe(true)
    expect(ledger.issuePage({ sessionId: null }).ok).toBe(true)
  })

  it('会话作用域仍要求非空 sessionId 与 workspaceKey', () => {
    const ledger = createBrowserIdentityLedger()
    expect(ledger.issuePage({ sessionId: '', workspaceKey: 'ws_a' })).toEqual({
      ok: false,
      code: 'not_owner'
    })
    expect(ledger.issuePage({ sessionId: 'sess_1', workspaceKey: '' })).toEqual({
      ok: false,
      code: 'not_owner'
    })
    // 用户作用域忽略传入的 workspaceKey
    const page = ledger.issuePage({ sessionId: null, workspaceKey: 'ws_a' })
    expect(page.ok).toBe(true)
    if (!page.ok) return
    expect(page.value.workspaceKey).toBeNull()
  })
})
