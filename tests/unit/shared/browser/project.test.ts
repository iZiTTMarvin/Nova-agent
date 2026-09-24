import { describe, expect, it } from 'vitest'
import { BROWSER_ENGINE_CAPABILITIES } from '../../../../src/shared/browser'
import {
  BROWSER_ERR_ABORTED,
  isCertificateBrowserLoadError,
  projectBrowserPage,
  projectFaviconUrl,
  projectGuestLoadError,
  readGuestFaviconArgs,
  readGuestLoadFailureArgs
} from '../../../../src/shared/browser/project'

describe('浏览器页面快照投影', () => {
  it('把 favicon 与主 frame 致命错误写进页面记录', () => {
    const page = projectBrowserPage({
      browserId: 'brw_1',
      generation: 1,
      documentEpoch: 2,
      sessionId: 'sess_1',
      url: 'https://example.com',
      title: 'Example',
      loading: false,
      lifecycle: 'ready',
      control: { holder: 'user' },
      faviconUrl: 'https://example.com/favicon.ico',
      loadError: {
        errorCode: -201,
        message: 'ERR_CERT_DATE_INVALID',
        url: 'https://example.com',
        isCertificateError: true
      }
    })
    expect(page.capabilities).toEqual(BROWSER_ENGINE_CAPABILITIES)
    expect(page.faviconUrl).toBe('https://example.com/favicon.ico')
    expect(page.loadError).toEqual({
      errorCode: -201,
      message: 'ERR_CERT_DATE_INVALID',
      url: 'https://example.com',
      isCertificateError: true
    })
  })

  it('favicon 只收录 http(s) 或 data 图片，忽略空值与危险 scheme', () => {
    expect(projectFaviconUrl(['https://cdn.example/favicon.ico'])).toBe('https://cdn.example/favicon.ico')
    expect(projectFaviconUrl(['data:image/png;base64,abc'])).toBe('data:image/png;base64,abc')
    expect(projectFaviconUrl(['javascript:alert(1)', 'https://ok.test/i.ico'])).toBe('https://ok.test/i.ico')
    expect(projectFaviconUrl(['', null, 'file:///tmp/x.ico'])).toBeNull()
    expect(projectFaviconUrl('https://not-an-array.test')).toBeNull()
  })

  it('主 frame 致命错误才投影，子资源和 ERR_ABORTED 忽略', () => {
    expect(projectGuestLoadError({
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://missing.test',
      isMainFrame: true
    })).toEqual({
      errorCode: -105,
      message: 'ERR_NAME_NOT_RESOLVED',
      url: 'https://missing.test',
      isCertificateError: false
    })
    expect(projectGuestLoadError({
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://missing.test',
      isMainFrame: false
    })).toBeNull()
    expect(projectGuestLoadError({
      errorCode: BROWSER_ERR_ABORTED,
      errorDescription: 'ERR_ABORTED',
      validatedURL: 'https://example.com',
      isMainFrame: true
    })).toBeNull()
    expect(isCertificateBrowserLoadError(-201)).toBe(true)
    expect(isCertificateBrowserLoadError(-105)).toBe(false)
    expect(projectGuestLoadError({
      errorCode: -201,
      errorDescription: 'ERR_CERT_DATE_INVALID',
      validatedURL: 'https://bad-cert.test',
      isMainFrame: true
    })?.isCertificateError).toBe(true)
  })

  it('兼容 WebContents 位置参数与 webview DOM 事件对象', () => {
    expect(readGuestLoadFailureArgs([
      {},
      -102,
      'ERR_CONNECTION_REFUSED',
      'http://127.0.0.1:9/',
      true
    ])).toEqual({
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      validatedURL: 'http://127.0.0.1:9/',
      isMainFrame: true
    })
    expect(readGuestLoadFailureArgs([{
      errorCode: -201,
      errorDescription: 'cert',
      validatedURL: 'https://x.test',
      isMainFrame: true
    }])).toEqual({
      errorCode: -201,
      errorDescription: 'cert',
      validatedURL: 'https://x.test',
      isMainFrame: true
    })
    expect(readGuestFaviconArgs([{}, ['https://a.test/favicon.ico']])).toEqual([
      'https://a.test/favicon.ico'
    ])
    expect(readGuestFaviconArgs([{ favicons: ['https://b.test/favicon.ico'] }])).toEqual([
      'https://b.test/favicon.ico'
    ])
  })
})
