import { describe, expect, it } from 'vitest'
import {
  parseBrowserAction,
  parseBrowserActCommand,
  parseBrowserNavigateAction,
  parseBrowserNavigateIpcParams,
  parseBrowserOpenIpcParams,
  parseObservationIdentity
} from '../../../../src/shared/browser'

describe('browser action 判别联合', () => {
  it('分别接受六种互斥动作', () => {
    expect(parseBrowserAction({ kind: 'click', ref: 'e1' })).toEqual({
      ok: true,
      value: { kind: 'click', ref: 'e1' }
    })
    expect(parseBrowserAction({ kind: 'fill', ref: 'e1', text: '你好' })).toEqual({
      ok: true,
      value: { kind: 'fill', ref: 'e1', text: '你好' }
    })
    expect(parseBrowserAction({ kind: 'select', ref: 'e1', values: ['a', 'b'] })).toEqual({
      ok: true,
      value: { kind: 'select', ref: 'e1', values: ['a', 'b'] }
    })
    expect(parseBrowserAction({ kind: 'press', ref: 'e1', key: 'Enter' })).toEqual({
      ok: true,
      value: { kind: 'press', ref: 'e1', key: 'Enter' }
    })
    expect(parseBrowserAction({ kind: 'scroll', direction: 'down', amount: 'page' })).toEqual({
      ok: true,
      value: { kind: 'scroll', direction: 'down', amount: 'page' }
    })
    expect(parseBrowserAction({
      kind: 'viewport',
      width: 1280,
      height: 720,
      device: 'desktop'
    })).toEqual({
      ok: true,
      value: { kind: 'viewport', width: 1280, height: 720, device: 'desktop' }
    })
  })

  it('拒绝未知 action 与互斥字段堆叠', () => {
    const unknown = parseBrowserAction({ kind: 'evaluate', expression: '1+1' })
    expect(unknown.ok).toBe(false)
    if (!unknown.ok) expect(unknown.detail).toBe('未知的页面动作')

    expect(parseBrowserAction({ kind: 'click', ref: 'e1', text: 'nope' }).ok).toBe(false)
    expect(parseBrowserAction({ kind: 'fill', ref: 'e1' }).ok).toBe(false)
    expect(parseBrowserAction({ kind: 'scroll', ref: 'e1', direction: 'down', amount: 'page' }).ok).toBe(false)
    expect(parseBrowserAction({
      kind: 'click',
      ref: 'e1',
      text: '',
      values: [],
      key: 'Enter'
    }).ok).toBe(false)
  })

  it('动作必须带完整观察身份，缺 observationId 即拒绝', () => {
    const missing = parseBrowserActCommand({
      action: { kind: 'click', ref: 'e1' }
    })
    expect(missing.ok).toBe(false)

    const parsed = parseBrowserActCommand({
      observation: {
        browserId: 'brw_1',
        generation: 1,
        documentEpoch: 1,
        observationId: 'obs_1'
      },
      action: { kind: 'click', ref: 'e1' }
    })
    expect(parsed.ok).toBe(true)
  })
})

describe('browser 导航与打开入参', () => {
  it('拒绝未知导航动作、危险 scheme 与嵌入用户信息的 URL', () => {
    expect(parseBrowserNavigateAction({ kind: 'evaluate' }).ok).toBe(false)
    expect(parseBrowserOpenIpcParams({
      sessionId: 'sess_1',
      url: 'javascript:alert(1)'
    }).ok).toBe(false)
    expect(parseBrowserOpenIpcParams({
      sessionId: 'sess_1',
      url: 'file:///C:/secret.html'
    }).ok).toBe(false)
    expect(parseBrowserOpenIpcParams({
      sessionId: 'sess_1',
      url: 'https://user:pass@example.com/'
    }).ok).toBe(false)
    expect(parseBrowserNavigateIpcParams({
      sessionId: 'sess_1',
      browserId: 'brw_1',
      action: { kind: 'back', url: 'https://example.com' }
    }).ok).toBe(false)
  })

  it('接受 http(s) 打开与无额外字段的前进后退', () => {
    expect(parseBrowserOpenIpcParams({
      sessionId: 'sess_1',
      url: 'https://example.com/path'
    })).toEqual({
      ok: true,
      value: { sessionId: 'sess_1', url: 'https://example.com/path' }
    })
    expect(parseBrowserNavigateAction({ kind: 'back' })).toEqual({
      ok: true,
      value: { kind: 'back' }
    })
  })

  it('观察身份不得夹带多余字段', () => {
    expect(parseObservationIdentity({
      browserId: 'brw_1',
      generation: 1,
      documentEpoch: 1,
      observationId: 'obs_1',
      webContentsId: 9
    }).ok).toBe(false)
    expect(parseObservationIdentity({
      browserId: 'brw_1',
      generation: 1.5,
      documentEpoch: 1,
      observationId: 'obs_1'
    }).ok).toBe(false)
  })
})
