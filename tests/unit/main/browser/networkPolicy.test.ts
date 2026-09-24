import { describe, expect, it } from 'vitest'
import {
  createPartitionHostResolver,
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

  it('域名请求等待解析后决策；失败拒绝；等待后复核最新授权', async () => {
    resetBrowserPartitionPolicyForTests()
    const ses = fakeSession()
    const grants: string[] = []
    const sink: PartitionPolicySink = {
      grantsFor: () => [...grants],
      onPermissionDenied() {},
      onDownloadDenied() {}
    }
    const resolved: string[] = []
    const resolveHost = async (hostname: string): Promise<readonly string[] | null> => {
      resolved.push(hostname)
      if (hostname === 'dev.internal.test') return ['192.168.1.5']
      if (hostname === 'broken.test') return null
      return ['93.184.216.34']
    }
    installBrowserPartitionPolicy('persist:nova-browser-slot-1', ses, sink, { resolveHost })
    const decide = (details: {
      url: string
      resourceType: string
      initiatorOrigin?: string
      webContentsId?: number
    }): Promise<boolean> =>
      new Promise((resolve) => {
        ses.requestListener?.(details, (response) => resolve(response.cancel))
      })

    // 解析到私网且无授权：拒绝
    await expect(decide({ url: 'http://dev.internal.test:3000/', resourceType: 'mainFrame', webContentsId: 4 }))
      .resolves.toBe(true)
    // 解析到公网：放行
    await expect(decide({ url: 'http://cdn.example.com/app.js', resourceType: 'script', initiatorOrigin: 'https://example.com', webContentsId: 4 }))
      .resolves.toBe(false)
    // 解析失败：明确拒绝
    await expect(decide({ url: 'http://broken.test/x', resourceType: 'mainFrame', webContentsId: 4 }))
      .resolves.toBe(true)
    // 等待解析期间授权到位：复核后放行
    const pending = decide({ url: 'http://dev.internal.test:3000/', resourceType: 'mainFrame', webContentsId: 4 })
    grants.push('http://dev.internal.test:3000')
    await expect(pending).resolves.toBe(false)
    // 授权的域名预览可以加载同源子资源
    await expect(decide({ url: 'http://dev.internal.test:3000/main.tsx', resourceType: 'script', initiatorOrigin: 'http://dev.internal.test:3000', webContentsId: 4 }))
      .resolves.toBe(false)
    // IP 字面量请求不触发域名解析
    resolved.length = 0
    await expect(decide({ url: 'http://127.0.0.1:5173/', resourceType: 'mainFrame', webContentsId: 4 }))
      .resolves.toBe(true)
    expect(resolved).toEqual([])
  })

  it('域名解析缓存：成功按期限复用、失败不缓存、超容量先清过期再淘汰最旧', async () => {
    let clock = 1_000
    const lookups: string[] = []
    const answers = new Map<string, readonly string[] | null>()
    const resolver = createPartitionHostResolver({
      ttlMs: 100,
      cacheLimit: 2,
      now: () => clock,
      lookupHost: async (hostname) => {
        lookups.push(hostname)
        return answers.get(hostname) ?? null
      }
    })

    // 失败不缓存：每次都重试
    answers.set('fail.test', null)
    await expect(resolver('fail.test')).resolves.toBeNull()
    await expect(resolver('fail.test')).resolves.toBeNull()
    expect(lookups.filter((host) => host === 'fail.test')).toHaveLength(2)

    // 成功在期限内复用
    answers.set('ok-a.test', ['1.1.1.1'])
    await expect(resolver('ok-a.test')).resolves.toEqual(['1.1.1.1'])
    await expect(resolver('ok-a.test')).resolves.toEqual(['1.1.1.1'])
    expect(lookups.filter((host) => host === 'ok-a.test')).toHaveLength(1)

    // 期限过后重新解析
    clock += 101
    await expect(resolver('ok-a.test')).resolves.toEqual(['1.1.1.1'])
    expect(lookups.filter((host) => host === 'ok-a.test')).toHaveLength(2)

    // 容量上限：清过期项后仍满则淘汰最旧
    answers.set('ok-b.test', ['2.2.2.2'])
    answers.set('ok-c.test', ['3.3.3.3'])
    await resolver('ok-a.test')
    await resolver('ok-b.test')
    await resolver('ok-c.test')
    clock += 101
    // ok-a 最旧被淘汰，ok-b 因过期被清，新条目可以写入且不抛错
    answers.set('ok-d.test', ['4.4.4.4'])
    await expect(resolver('ok-d.test')).resolves.toEqual(['4.4.4.4'])
  })
})
