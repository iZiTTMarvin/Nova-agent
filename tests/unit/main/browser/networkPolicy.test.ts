import { describe, expect, it } from 'vitest'
import {
  decidePartitionRequest,
  guestDownloadMessage,
  guestPermissionMessage,
  installBrowserPartitionPolicy,
  resetBrowserPartitionPolicyForTests,
  type PartitionPolicySession,
  type PartitionPolicySink
} from '../../../../src/main/browser/networkPolicy'

function fakeSession(): PartitionPolicySession & {
  requests: number
  checks: number
  downloads: number
  requestListener: ((
    details: { url: string; resourceType: string; initiatorOrigin?: string; webContentsId?: number },
    callback: (response: { cancel: boolean }) => void
  ) => void) | null
} {
  const session = {
    requests: 0,
    checks: 0,
    downloads: 0,
    requestListener: null as ((
      details: { url: string; resourceType: string; initiatorOrigin?: string; webContentsId?: number },
      callback: (response: { cancel: boolean }) => void
    ) => void) | null,
    webRequest: {
      onBeforeRequest(_filter: { urls: string[] }, listener: NonNullable<typeof session.requestListener>) {
        session.requests += 1
        session.requestListener = listener
      }
    },
    setPermissionRequestHandler() {
      session.requests += 0
    },
    setPermissionCheckHandler(handler: (webContents: { id: number } | null, permission: string, origin: string) => boolean) {
      session.checks += 1
      expect(handler(null, 'media', 'https://example.com')).toBe(false)
    },
    on(event: 'will-download') {
      if (event === 'will-download') session.downloads += 1
    }
  }
  return session
}

describe('浏览器分区网络策略', () => {
  it('危险 scheme、重定向后的私网子资源、以及另一份旧授权都被拒绝', () => {
    const granted = ['http://127.0.0.1:5173']
    expect(decidePartitionRequest({
      url: 'file:///C:/secret.txt',
      resourceType: 'mainFrame'
    }, granted)).toBe('deny')
    expect(decidePartitionRequest({
      url: 'javascript:alert(1)',
      resourceType: 'script',
      initiatorOrigin: 'http://127.0.0.1:5173'
    }, granted)).toBe('deny')
    expect(decidePartitionRequest({
      url: 'http://192.168.0.20/stolen',
      resourceType: 'xhr',
      initiatorOrigin: 'https://example.com'
    }, granted)).toBe('deny')
    expect(decidePartitionRequest({
      url: 'http://169.254.169.254/latest',
      resourceType: 'xhr',
      initiatorOrigin: 'http://127.0.0.1:5173'
    }, granted)).toBe('deny')
    expect(decidePartitionRequest({
      url: 'http://10.1.0.4/a',
      resourceType: 'script',
      initiatorOrigin: 'http://127.0.0.1:5173'
    }, [])).toBe('deny')
    expect(decidePartitionRequest({
      url: 'http://127.0.0.1:5173/src/main.tsx',
      resourceType: 'script',
      initiatorOrigin: 'http://127.0.0.1:5173'
    }, granted)).toBe('allow')
    expect(guestPermissionMessage('media', 'http://127.0.0.1:5173/')).toContain('摄像头')
    expect(guestPermissionMessage('fileSystem', 'http://127.0.0.1:5173/')).toContain('本机文件')
    expect(guestDownloadMessage('a.zip', 'http://127.0.0.1:5173/a.zip')).toContain('已拒绝下载')
  })

  it('同一 partition 只注册一次策略', () => {
    resetBrowserPartitionPolicyForTests()
    const ses = fakeSession()
    const sink: PartitionPolicySink = {
      grantsFor: () => [],
      onPermissionDenied() {},
      onDownloadDenied() {}
    }
    installBrowserPartitionPolicy('persist:nova-browser-slot-0', ses, sink)
    installBrowserPartitionPolicy('persist:nova-browser-slot-0', ses, sink)
    expect(ses.requests).toBe(1)
    expect(ses.checks).toBe(1)
    expect(ses.downloads).toBe(1)
    let cancelled = false
    ses.requestListener?.({
      url: 'http://172.16.0.9/',
      resourceType: 'xhr',
      initiatorOrigin: 'https://example.com',
      webContentsId: 4
    }, (response) => {
      cancelled = response.cancel
    })
    expect(cancelled).toBe(true)
  })
})
