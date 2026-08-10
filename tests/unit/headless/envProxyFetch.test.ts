import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { afterEach, describe, expect, it } from 'vitest'
import { createEnvProxyFetch } from '../../../src/headless/envProxyFetch'

const servers: Server[] = []

afterEach(async () => {
  // CONNECT 测试会留下非请求态的裸 socket，close 之前先强制断开所有连接
  await Promise.all(
    servers.splice(0).map(
      server =>
        new Promise(resolve => {
          server.closeAllConnections()
          server.close(resolve)
        })
    )
  )
})

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

describe('createEnvProxyFetch', () => {
  it('未配置代理环境变量时返回 undefined', () => {
    expect(createEnvProxyFetch({})).toBeUndefined()
  })

  it('拒绝非 http 代理协议', () => {
    expect(() => createEnvProxyFetch({ HTTPS_PROXY: 'socks5://127.0.0.1:1080' })).toThrow(
      /env_proxy_unsupported_scheme/
    )
  })

  it('NO_PROXY 命中的主机绕过代理直连', async () => {
    const seen: string[] = []
    const target = createServer((req, res) => {
      seen.push(req.url ?? '')
      res.end('direct-ok')
    })
    servers.push(target)
    const port = await listen(target)

    const proxied = createEnvProxyFetch({
      HTTPS_PROXY: 'http://127.0.0.1:1', // 故意指向不可用代理；命中 bypass 则不会触碰
      NO_PROXY: 'localhost,127.0.0.1'
    })
    expect(proxied).toBeDefined()
    const res = await proxied!(`http://127.0.0.1:${port}/origin-form`, { method: 'GET' })
    expect(await res.text()).toBe('direct-ok')
    // 直连时目标看到的是 origin-form 路径而非绝对 URL
    expect(seen).toEqual(['/origin-form'])
  })

  it('纯 HTTP 目标按绝对路径形式发给代理并带认证头', async () => {
    let seenUrl = ''
    let seenAuth: string | undefined
    const proxy = createServer((req, res) => {
      seenUrl = req.url ?? ''
      seenAuth = req.headers['proxy-authorization']
      res.end('via-proxy')
    })
    servers.push(proxy)
    const proxyPort = await listen(proxy)

    const proxied = createEnvProxyFetch({
      HTTP_PROXY: `http://agent:secret-token@127.0.0.1:${proxyPort}`
    })
    const res = await proxied!('http://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    })
    expect(await res.text()).toBe('via-proxy')
    expect(seenUrl).toBe('http://opencode.ai/zen/go/v1/chat/completions')
    expect(seenAuth).toBe(`Basic ${Buffer.from('agent:secret-token').toString('base64')}`)
  })

  it('代理拒绝 CONNECT 时抛出可诊断错误', async () => {
    const proxy = createServer()
    proxy.on('connect', (req, socket) => {
      // CONNECT 的 socket 脱离 server 连接管理，必须自己收尾，否则 close 永不返回
      socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n')
    })
    servers.push(proxy)
    const proxyPort = await listen(proxy)

    const proxied = createEnvProxyFetch({ HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` })
    await expect(proxied!('https://opencode.ai/zen/go/v1', { method: 'POST' })).rejects.toThrow(
      /proxy_connect_failed: HTTP 407/
    )
  })
})
