import { describe, expect, it } from 'vitest'
import {
  parseBrowserAction,
  parseBrowserActCommand,
  parseBrowserActToolArgs,
  parseBrowserAttachIpcParams,
  parseBrowserCaptureToolArgs,
  parseBrowserCloseToolArgs,
  parseBrowserNavigateAction,
  parseBrowserNavigateIpcParams,
  parseBrowserObserveToolArgs,
  parseBrowserOpenIpcParams,
  parseBrowserOpenToolArgs,
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

  it('挂载上报只接受正整数 webContentsId', () => {
    expect(parseBrowserAttachIpcParams({
      sessionId: 'sess_1',
      browserId: 'brw_1',
      webContentsId: 2
    })).toEqual({
      ok: true,
      value: { sessionId: 'sess_1', browserId: 'brw_1', webContentsId: 2 }
    })
    expect(parseBrowserAttachIpcParams({
      sessionId: 'sess_1',
      browserId: 'brw_1',
      webContentsId: 0
    }).ok).toBe(false)
    expect(parseBrowserAttachIpcParams({
      sessionId: 'sess_1',
      browserId: 'brw_1',
      webContentsId: 2,
      partition: 'nova-browser'
    }).ok).toBe(false)
  })
})

describe('browser 工具入参（来自模型）', () => {
  const observation = {
    browserId: 'brw_1',
    generation: 1,
    documentEpoch: 1,
    observationId: 'obs_1'
  }

  it('open 不带 browserId 新建页面，带 browserId 在该页跳转', () => {
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'https://example.com' })).toEqual({
      ok: true,
      value: { action: 'open', url: 'https://example.com' }
    })
    expect(parseBrowserOpenToolArgs({
      action: 'open',
      url: 'https://example.com/next',
      browserId: 'brw_1'
    })).toEqual({
      ok: true,
      value: { action: 'navigate', browserId: 'brw_1', url: 'https://example.com/next' }
    })
    expect(parseBrowserOpenToolArgs({ action: 'navigate', url: 'https://a.test', browserId: 'brw_1' })).toEqual({
      ok: true,
      value: { action: 'navigate', browserId: 'brw_1', url: 'https://a.test' }
    })
    // 模型把无关字段填成 null / 空串时按未提供处理
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'https://example.com', browserId: '' })).toEqual({
      ok: true,
      value: { action: 'open', url: 'https://example.com' }
    })
    expect(parseBrowserOpenToolArgs({ action: 'back', browserId: 'brw_1', url: null })).toEqual({
      ok: true,
      value: { action: 'back', browserId: 'brw_1' }
    })
  })

  it('省略协议头时补全，但危险 scheme 与账号密码仍被拒绝', () => {
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'example.com/a' })).toEqual({
      ok: true,
      value: { action: 'open', url: 'https://example.com/a' }
    })
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'localhost:5173' })).toEqual({
      ok: true,
      value: { action: 'open', url: 'http://localhost:5173' }
    })
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'javascript:alert(1)' }).ok).toBe(false)
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'file:///C:/secret.html' }).ok).toBe(false)
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'user:pass@example.com' }).ok).toBe(false)
    expect(parseBrowserOpenToolArgs({ action: 'open', url: 'https://user:pass@example.com' }).ok).toBe(false)
  })

  it('缺字段时报错里给出正确写法', () => {
    const back = parseBrowserOpenToolArgs({ action: 'back' })
    expect(back.ok).toBe(false)
    if (!back.ok) expect(back.detail).toContain('{"action":"back","browserId":"<browserId>"}')
    const noUrl = parseBrowserOpenToolArgs({ action: 'open' })
    expect(noUrl.ok).toBe(false)
    if (!noUrl.ok) expect(noUrl.detail).toContain('"url"')
    expect(parseBrowserOpenToolArgs({ action: 'click', browserId: 'brw_1' }).ok).toBe(false)
  })

  it('observe 的 list 忽略多填的 browserId；snapshot 可省略 browserId', () => {
    expect(parseBrowserObserveToolArgs({ action: 'list', browserId: 'brw_1' })).toEqual({
      ok: true,
      value: { action: 'list' }
    })
    expect(parseBrowserObserveToolArgs({ action: 'snapshot', browserId: 'brw_1' })).toEqual({
      ok: true,
      value: { action: 'snapshot', browserId: 'brw_1' }
    })
    expect(parseBrowserObserveToolArgs({ action: 'snapshot' })).toEqual({
      ok: true,
      value: { action: 'snapshot', browserId: null }
    })
    expect(parseBrowserObserveToolArgs({ action: 'evaluate' }).ok).toBe(false)
  })

  it('focus 仅接受精确 role/name 且只用于 snapshot', () => {
    expect(parseBrowserObserveToolArgs({ action: 'snapshot', focus: { role: 'region', name: ' Production Status ' } })).toEqual({
      ok: true,
      value: { action: 'snapshot', browserId: null, focus: { role: 'region', name: 'Production Status' } }
    })
    expect(parseBrowserObserveToolArgs({ action: 'snapshot', focus: { role: 'region', name: '' } }).ok).toBe(false)
    expect(parseBrowserObserveToolArgs({ action: 'snapshot', focus: { role: 'region', name: 'x', selector: 'css=*' } }).ok).toBe(false)
    expect(parseBrowserObserveToolArgs({ action: 'list', focus: { role: 'region', name: 'x' } }).ok).toBe(false)
  })

  it('act 只取当前 kind 需要的字段，其余字段与 null 不影响', () => {
    expect(parseBrowserActToolArgs({
      observation,
      action: { kind: 'click', ref: 'e1', text: '', values: [], key: null, url: 'x' }
    })).toEqual({ ok: true, value: { observation, action: { kind: 'click', ref: 'e1' } } })
    // fill 允许空串，用于清空输入框
    expect(parseBrowserActToolArgs({ observation, action: { kind: 'fill', ref: 'e1', text: '' } })).toEqual({
      ok: true,
      value: { observation, action: { kind: 'fill', ref: 'e1', text: '' } }
    })
    expect(parseBrowserActToolArgs({ observation, action: { kind: 'select', ref: 'e1', values: 'a' } })).toEqual({
      ok: true,
      value: { observation, action: { kind: 'select', ref: 'e1', values: ['a'] } }
    })
    expect(parseBrowserActToolArgs({ observation, action: { kind: 'scroll', direction: 'down' } })).toEqual({
      ok: true,
      value: { observation, action: { kind: 'scroll', direction: 'down', amount: 'page' } }
    })
  })

  it('act 接受平铺在顶层或数字写成字符串的观察身份', () => {
    expect(parseBrowserActToolArgs({
      ...observation,
      action: { kind: 'click', ref: 'e1' }
    })).toEqual({ ok: true, value: { observation, action: { kind: 'click', ref: 'e1' } } })
    expect(parseBrowserActToolArgs({
      observation: { ...observation, generation: '1', documentEpoch: '1' },
      action: { kind: 'click', ref: 'e1' }
    })).toEqual({ ok: true, value: { observation, action: { kind: 'click', ref: 'e1' } } })
  })

  it('act 缺观察身份或动作字段时拒绝并给出示例', () => {
    const noObservation = parseBrowserActToolArgs({ action: { kind: 'click', ref: 'e1' } })
    expect(noObservation.ok).toBe(false)
    if (!noObservation.ok) expect(noObservation.detail).toContain('observationId')
    const noText = parseBrowserActToolArgs({ observation, action: { kind: 'fill', ref: 'e1' } })
    expect(noText.ok).toBe(false)
    if (!noText.ok) expect(noText.detail).toContain('{"kind":"fill","ref":"e3","text":"内容"}')
    expect(parseBrowserActToolArgs({ observation, action: { kind: 'evaluate', ref: 'e1' } }).ok).toBe(false)
    expect(parseBrowserActToolArgs({
      observation: { ...observation, generation: 0 },
      action: { kind: 'click', ref: 'e1' }
    }).ok).toBe(false)
  })

  it('close / capture 只看必需字段', () => {
    expect(parseBrowserCloseToolArgs({ browserId: 'brw_1', force: true })).toEqual({
      ok: true,
      value: { browserId: 'brw_1' }
    })
    expect(parseBrowserCloseToolArgs({}).ok).toBe(false)
    expect(parseBrowserCaptureToolArgs({ observation }).ok).toBe(true)
    expect(parseBrowserCaptureToolArgs({ observationId: 'obs_1' }).ok).toBe(false)
  })
})
