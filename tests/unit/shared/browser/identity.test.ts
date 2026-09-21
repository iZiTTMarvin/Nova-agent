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
