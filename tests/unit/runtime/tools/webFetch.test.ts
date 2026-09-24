/**
 * web_fetch 工具：安全闸门、正文提取、缓存与病态天花板。
 * 保护的行为：模型读链接时拿到的是干净正文而不是导航噪声；
 * 重定向不能绕过内网拦截；大页明确报错而不是静默截断。
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'http'
import { AddressInfo } from 'net'
import { classifyIp } from '../../../../src/shared/permissions/ipClassify'
import { checkUrlSync } from '../../../../src/runtime/tools/webFetch/urlGate'
import { extractContent } from '../../../../src/runtime/tools/webFetch/extractor'
import { cacheGet, cachePut } from '../../../../src/runtime/tools/webFetch/fetchCache'
import { webFetchTool } from '../../../../src/runtime/tools/webFetch/webFetchTool'
import { resolvePermissionEffects } from '../../../../src/runtime/permissions/effectResolver'
import { createReadState } from '../../../../src/runtime/tools/editTool'

let cacheSandbox: string

beforeAll(() => {
  cacheSandbox = mkdtempSync(join(tmpdir(), 'nova-webfetch-cache-'))
  process.env.NOVA_WEB_FETCH_CACHE_DIR = cacheSandbox
})

afterAll(() => {
  delete process.env.NOVA_WEB_FETCH_CACHE_DIR
  rmSync(cacheSandbox, { recursive: true, force: true })
})

describe('classifyIp 网段分类', () => {
  it('loopback / 私网各段 / CGNAT / 云元数据 / 公网各归其位', () => {
    expect(classifyIp('127.0.0.1')).toBe('loopback')
    expect(classifyIp('localhost')).toBe('loopback')
    expect(classifyIp('::1')).toBe('loopback')
    expect(classifyIp('10.1.2.3')).toBe('private')
    expect(classifyIp('172.16.0.9')).toBe('private')
    expect(classifyIp('172.31.255.255')).toBe('private')
    expect(classifyIp('192.168.1.1')).toBe('private')
    expect(classifyIp('169.254.10.10')).toBe('private')
    expect(classifyIp('100.64.0.1')).toBe('private')
    expect(classifyIp('fd12:3456::1')).toBe('private')
    expect(classifyIp('169.254.169.254')).toBe('cloud-metadata')
    expect(classifyIp('100.100.100.200')).toBe('cloud-metadata')
    expect(classifyIp('8.8.8.8')).toBe('public')
    expect(classifyIp('2001:db8::1')).toBe('public')
    // IPv4-mapped IPv6 不能穿透私网/环回判定（Node fetch 经映射地址连 IPv4 目标）
    expect(classifyIp('::ffff:10.1.2.3')).toBe('private')
    expect(classifyIp('::ffff:192.168.1.1')).toBe('private')
    expect(classifyIp('::ffff:127.0.0.1')).toBe('loopback')
    expect(classifyIp('::ffff:169.254.169.254')).toBe('cloud-metadata')
    expect(classifyIp('0.0.0.0')).toBe('loopback')
  })
})

describe('urlGate 同步校验', () => {
  it('file:// 与非 http(s) scheme 拒绝', () => {
    expect(checkUrlSync('file:///C:/Windows/win.ini')).toMatchObject({ ok: false, reason: 'scheme' })
    expect(checkUrlSync('ftp://example.com/x')).toMatchObject({ ok: false, reason: 'scheme' })
  })

  it('非法 URL 与云元数据字面量拒绝', () => {
    expect(checkUrlSync('not a url')).toMatchObject({ ok: false, reason: 'invalid-url' })
    expect(checkUrlSync('http://169.254.169.254/latest/meta-data')).toMatchObject({ ok: false, reason: 'cloud-metadata' })
  })

  it('私网 IP 字面量：initial 放行（权限层 ask 把关），per-hop 拒绝（防重定向绕过）', () => {
    expect(checkUrlSync('http://192.168.1.1/admin')).toMatchObject({ ok: true })
    expect(checkUrlSync('http://192.168.1.1/admin', 'per-hop')).toMatchObject({ ok: false, reason: 'private-redirect' })
    // loopback 两种模式都放行：开发场景本体
    expect(checkUrlSync('http://127.0.0.1:3000/', 'per-hop')).toMatchObject({ ok: true })
  })

  it('IPv4-mapped IPv6 私网地址同样被拦（映射形式不能绕过网段判定）', () => {
    expect(checkUrlSync('http://[::ffff:192.168.1.1]/admin', 'per-hop')).toMatchObject({ ok: false, reason: 'private-redirect' })
    expect(checkUrlSync('http://[::ffff:169.254.169.254]/meta')).toMatchObject({ ok: false, reason: 'cloud-metadata' })
  })
})

describe('extractContent 正文提取', () => {
  // 本用例承担三个 ESM 提取库（readability/linkedom/turndown）的首次动态加载，
  // 冷态并行全量跑时单次加载可超默认 5s 超时，故放宽到 15s；后续用例复用已加载模块。
  it('新闻页：剥掉导航/页脚噪声，正文转 Markdown', async () => {
    const html = `<!doctype html><html><head><title>大新闻</title></head><body>
      <nav><a href="/">首页</a><a href="/x">导航一</a><a href="/y">导航二</a><a href="/z">导航三</a><a href="/w">导航四</a><a href="/v">导航五</a></nav>
      <article><h1>大新闻</h1><p>${'正文内容。'.repeat(60)}</p><p>${'更多细节。'.repeat(60)}</p></article>
      <footer>版权所有 © 2026 关于我们 联系方式 隐私政策 使用条款 网站地图</footer>
      </body></html>`
    const out = await extractContent(html, 'text/html')
    expect(out.kind).toBe('markdown')
    if (out.kind !== 'markdown') return
    expect(out.markdown).toContain('正文内容')
    expect(out.markdown).not.toContain('隐私政策')
    expect(out.markdown).not.toContain('<script')
  }, 15000)

  it('JS 壳页面：短且命中壳信号 → 明确报错不喂垃圾', async () => {
    const html = '<html><body>Please enable JavaScript to view this page.</body></html>'
    expect(await extractContent(html, 'text/html')).toMatchObject({ kind: 'js-shell' })
  })

  it('合法短页：仅短而无壳信号 → 降级返回原文加警告，不误杀', async () => {
    const html = '<html><body><p>OK</p></body></html>'
    expect(await extractContent(html, 'text/html')).toMatchObject({ kind: 'short-with-warning' })
  })

  it('非 HTML（JSON/纯文本）按原文返回', async () => {
    expect(await extractContent('{"a":1}', 'application/json')).toMatchObject({ kind: 'raw', text: '{"a":1}' })
    expect(await extractContent('plain text', 'text/plain')).toMatchObject({ kind: 'raw' })
  })
})

describe('fetchCache 缓存', () => {
  afterEach(() => {
    rmSync(cacheSandbox, { recursive: true, force: true })
  })

  it('put 后 get 命中且内容一致；未缓存的 URL 返回 null', () => {
    cachePut('https://example.com/docs', {
      finalUrl: 'https://example.com/docs',
      content: 'the body',
      contentType: 'text/html',
      fetchedAt: Date.now()
    })
    expect(cacheGet('https://example.com/docs')?.content).toBe('the body')
    expect(cacheGet('https://example.com/other')).toBeNull()
  })

  it('超过 TTL 的缓存条目过期返回 null', () => {
    cachePut('https://example.com/stale', {
      finalUrl: 'https://example.com/stale',
      content: 'old',
      fetchedAt: Date.now() - 3 * 24 * 60 * 60 * 1000
    })
    expect(cacheGet('https://example.com/stale')).toBeNull()
  })
})

describe('webFetchTool 契约', () => {
  it('反向断言：不声明 maxResultSizeChars（大页必须完整进归档通道，不能被执行器预截断）', () => {
    expect(webFetchTool.maxResultSizeChars).toBeUndefined()
  })

  it('非 http(s) scheme（如 data:）在入口即被拒绝', async () => {
    const out = await webFetchTool.execute({ url: 'data:text/plain,hello' }, minimalContext())
    expect(out.success).toBe(false)
    if (out.success) return
    expect(out.error).toContain('仅支持 http/https')
  })
})

describe('权限升格：web_fetch 私网 IP', () => {
  it('私网 IP 字面量追加 network.private_read（baseline 升格 ask）', () => {
    const result = resolvePermissionEffects(permissionQuery({ url: 'http://192.168.1.1/admin' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.effects).toContain('network.read')
    expect(result.effects).toContain('network.private_read')
  })

  it('loopback 与公网域名不升格', () => {
    for (const url of ['http://localhost:3000/', 'http://127.0.0.1:5173/', 'https://example.com/x']) {
      const result = resolvePermissionEffects(permissionQuery({ url }))
      expect(result.ok && result.effects).not.toContain('network.private_read')
    }
  })
})

describe('本地 server 抓取链路', () => {
  let server: Server
  let baseUrl: string
  let redirectBodyReleased = false

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><body><article><h1>本地文档</h1><p>${'本地内容。'.repeat(50)}</p></article></body></html>`)
        return
      }
      if (req.url === '/redirect-to-private') {
        res.writeHead(302, { location: 'http://192.168.99.99/admin' })
        res.end()
        return
      }
      if (req.url === '/redirect-with-body') {
        res.writeHead(302, { location: '/page' })
        res.flushHeaders()
        res.write('unused redirect body')
        const timer = setInterval(() => res.write('.'), 20)
        res.on('close', () => {
          clearInterval(timer)
          redirectBodyReleased = !res.writableEnded
        })
        return
      }
      if (req.url === '/redirect-loop') {
        res.writeHead(302, { location: '/redirect-loop' })
        res.end()
        return
      }
      res.writeHead(404).end()
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('localhost 页面放行并提取正文', async () => {
    const out = await webFetchTool.execute({ url: `${baseUrl}/page` }, minimalContext())
    expect(out.success).toBe(true)
    if (!out.success) return
    expect(out.output).toContain('本地文档')
    expect(out.output).toContain('新抓取')
  })

  it('同一链接二次读取命中缓存（零抓取）', async () => {
    const first = await webFetchTool.execute({ url: `${baseUrl}/page` }, minimalContext())
    expect(first.success).toBe(true)
    const second = await webFetchTool.execute({ url: `${baseUrl}/page` }, minimalContext())
    expect(second.success).toBe(true)
    if (!second.success) return
    expect(second.output).toContain('缓存')
    // force 跳过缓存重新抓取
    const forced = await webFetchTool.execute({ url: `${baseUrl}/page`, force: true }, minimalContext())
    expect(forced.success).toBe(true)
  })

  it('公网 302 跳内网：每跳校验拦截，不发起内网请求', async () => {
    const out = await webFetchTool.execute({ url: `${baseUrl}/redirect-to-private` }, minimalContext())
    expect(out.success).toBe(false)
    if (out.success) return
    expect(out.error).toContain('重定向进入内网')
  })

  it('跟随重定向前释放未消费的旧响应正文', async () => {
    const out = await webFetchTool.execute(
      { url: `${baseUrl}/redirect-with-body`, force: true },
      minimalContext()
    )
    expect(out.success).toBe(true)
    await expect.poll(() => redirectBodyReleased).toBe(true)
  })

  it('重定向环明确报错', async () => {
    const out = await webFetchTool.execute({ url: `${baseUrl}/redirect-loop` }, minimalContext())
    expect(out.success).toBe(false)
  })

  it('提取后超天花板的页面明确报错', async () => {
    const bigServer = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(`<html><body><article><p>${'大'.repeat(300_000)}</p></article></body></html>`)
    })
    await new Promise<void>(resolve => bigServer.listen(0, '127.0.0.1', resolve))
    const bigUrl = `http://127.0.0.1:${(bigServer.address() as AddressInfo).port}/big`
    try {
      const out = await webFetchTool.execute({ url: bigUrl }, minimalContext())
      expect(out.success).toBe(false)
      if (out.success) return
      expect(out.error).toContain('页面过大')
    } finally {
      await new Promise<void>(resolve => bigServer.close(() => resolve()))
    }
  })
})

function minimalContext() {
  return { workingDir: process.cwd(), readState: createReadState() }
}

function permissionQuery(args: Record<string, unknown>) {
  return {
    toolName: 'web_fetch',
    args,
    sessionId: 's1',
    workspaceRoot: '/tmp',
    permissionMode: 'auto' as const
  }
}
