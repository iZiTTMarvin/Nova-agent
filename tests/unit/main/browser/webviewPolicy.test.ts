import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  hardenWebviewAttachment,
  isAllowedGuestSrc,
  routeGuestPopup
} from '../../../../src/main/browser/webviewPolicy'

function prefs(): {
  sandbox?: boolean
  contextIsolation?: boolean
  nodeIntegration?: boolean
  nodeIntegrationInSubFrames?: boolean
  webSecurity?: boolean
  allowRunningInsecureContent?: boolean
  webviewTag?: boolean
  preload?: string
} {
  return {
    sandbox: false,
    contextIsolation: false,
    nodeIntegration: true,
    webSecurity: false,
    allowRunningInsecureContent: true,
    webviewTag: true,
    preload: 'file:///nova-preload.js'
  }
}

describe('webview 挂载硬化', () => {
  it('强制打开沙箱与隔离，并去掉 preload / nodeIntegration', () => {
    const webPreferences = prefs()
    const params = {
      src: 'https://example.com',
      preload: 'file:///evil.js',
      nodeintegration: 'true',
      disablewebsecurity: 'true'
    }
    let prevented = false
    const result = hardenWebviewAttachment(
      { preventDefault: () => { prevented = true } },
      webPreferences,
      params
    )
    expect(result).toBe('allowed')
    expect(prevented).toBe(false)
    expect(webPreferences).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false
    })
    expect(webPreferences.preload).toBeUndefined()
    expect(params.preload).toBeUndefined()
    expect(params.nodeintegration).toBeUndefined()
    expect(params.disablewebsecurity).toBeUndefined()
    expect(params.allowpopups).toBe('true')
  })

  it('非 http(s) 源被拒绝', () => {
    const webPreferences = prefs()
    const params = { src: 'file:///tmp/index.html' }
    let prevented = false
    expect(
      hardenWebviewAttachment(
        { preventDefault: () => { prevented = true } },
        webPreferences,
        params
      )
    ).toBe('blocked')
    expect(prevented).toBe(true)
    expect(webPreferences.sandbox).toBe(true)
    expect(isAllowedGuestSrc('javascript:alert(1)')).toBe(false)
    expect(isAllowedGuestSrc('https://user:pass@example.com')).toBe(false)
  })

  it('弹窗：非 http 拒绝；有空位转内部页；满员走系统浏览器', () => {
    expect(routeGuestPopup('file:///etc/passwd', 0)).toEqual({ action: 'deny' })
    expect(routeGuestPopup('https://example.com/a', 1)).toEqual({
      action: 'deny',
      openInternal: 'https://example.com/a'
    })
    expect(routeGuestPopup('https://example.com/b', 2)).toEqual({
      action: 'deny',
      openExternal: 'https://example.com/b'
    })
  })
})

describe('主窗口安全选项', () => {
  it('显式保持沙箱开启，仅为 guest 打开 webview 标签', () => {
    const src = readFileSync(path.join(__dirname, '../../../../src/main/index.ts'), 'utf8')
    expect(src).toMatch(/sandbox:\s*true/)
    expect(src).toMatch(/contextIsolation:\s*true/)
    expect(src).toMatch(/nodeIntegration:\s*false/)
    expect(src).toMatch(/webSecurity:\s*true/)
    expect(src).toMatch(/webviewTag:\s*true/)
    expect(src).toMatch(/bindWebviewPolicy/)
    expect(src).not.toMatch(/sandbox:\s*false/)
    expect(src).not.toMatch(/webSecurity:\s*false/)
  })
})
