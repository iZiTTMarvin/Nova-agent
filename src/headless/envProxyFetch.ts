/**
 * headless 出口代理支持（CONNECT 隧道）。
 *
 * 隔离评测容器 / 企业内网只允许经 HTTP 代理出网，而 Node 全局 fetch（undici）
 * 默认不读 HTTP(S)_PROXY，直连会被网络层重置。这里只实现模型传输用到的 fetch
 * 子集：HTTPS 目标经代理 CONNECT 建 TLS 隧道，HTTP 目标走代理绝对路径转发，
 * NO_PROXY 命中的主机直连。仅在 headless 入口注入，Electron 不经过此路径。
 */
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { connect as tlsConnect } from 'node:tls'
import { Readable } from 'node:stream'
import type { Duplex } from 'node:stream'
import type { TransportFetchImpl } from '../runtime/model/types'

interface ProxyConfig {
  host: string
  port: number
  authHeader?: string
  bypass: (hostname: string) => boolean
}

type FetchInit = Parameters<TransportFetchImpl>[1]

/** NOVA_PROXY_DEBUG=1 时向 stderr 输出代理路径诊断（headless 命令经 tee 落盘，不含凭据） */
function proxyDebug(message: string): void {
  if (process.env.NOVA_PROXY_DEBUG === '1') {
    process.stderr.write(`[envProxyFetch] ${message}\n`)
  }
}

/**
 * 从环境变量构建代理感知 fetch；未配置代理时返回 undefined（走全局 fetch）。
 * 读取顺序遵循常见约定：HTTPS_PROXY/https_proxy 优先，HTTP_PROXY 兜底。
 */
export function createEnvProxyFetch(
  env: NodeJS.ProcessEnv = process.env
): TransportFetchImpl | undefined {
  const proxyUrl = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (!proxyUrl || !proxyUrl.trim()) return undefined
  const config = parseProxyConfig(proxyUrl, env.NO_PROXY ?? env.no_proxy ?? '')
  return (url, init) => proxiedFetch(new URL(url), init ?? {}, config)
}

/** 诊断用：返回代理 host:port（不含凭据），无代理配置时返回 'direct' */
export function describeEnvProxy(env: NodeJS.ProcessEnv = process.env): string {
  const proxyUrl = env.HTTPS_PROXY ?? env.https_proxy ?? env.HTTP_PROXY ?? env.http_proxy
  if (!proxyUrl || !proxyUrl.trim()) return 'direct'
  try {
    return `env_proxy ${new URL(proxyUrl).host}`
  } catch {
    return 'env_proxy(unparseable)'
  }
}

function parseProxyConfig(proxyUrl: string, noProxy: string): ProxyConfig {
  const parsed = new URL(proxyUrl)
  if (parsed.protocol !== 'http:') {
    throw new Error(`env_proxy_unsupported_scheme: ${parsed.protocol}（仅支持 http 代理）`)
  }
  const authHeader =
    parsed.username !== ''
      ? `Basic ${Buffer.from(
          `${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`
        ).toString('base64')}`
      : undefined
  return {
    host: parsed.hostname,
    port: parsed.port ? Number(parsed.port) : 80,
    authHeader,
    bypass: buildBypass(noProxy)
  }
}

/** NO_PROXY 逗号分隔，支持精确主机、域名后缀（可带前导点）与 * 全放行 */
function buildBypass(noProxy: string): (hostname: string) => boolean {
  const entries = noProxy
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(Boolean)
  if (entries.length === 0) return () => false
  if (entries.includes('*')) return () => true
  return (hostname: string) => {
    const host = hostname.toLowerCase()
    return entries.some(entry => {
      const suffix = entry.startsWith('.') ? entry.slice(1) : entry
      return host === suffix || host.endsWith(`.${suffix}`)
    })
  }
}

async function proxiedFetch(
  url: URL,
  init: FetchInit,
  config: ProxyConfig
): Promise<Response> {
  const bypassed = config.bypass(url.hostname)
  proxyDebug(`${url.protocol}//${url.hostname} bypass=${bypassed} via=${config.host}:${config.port}`)
  if (bypassed) {
    return fetch(url, init)
  }
  if (url.protocol === 'https:') {
    const socket = await openConnectTunnel(config, url, init.signal)
    // HTTPS 请求复用已建立的 TLS 隧道 socket。注意：createConnection 选项只在
    // 「使用 agent」时才被尊重（agent:false 会新建默认 Agent 并丢弃该选项），
    // 因此必须注入一个携带 createConnection 的一次性 HttpsAgent。
    const tunnelAgent = new HttpsAgent({
      keepAlive: false,
      // @types/node 的 AgentOptions 未声明 createConnection，但 https.Agent
      // 运行时支持该选项（其默认值就是 tls.connect），此处返回已就绪的隧道 socket
      createConnection: () => socket
    } as ConstructorParameters<typeof HttpsAgent>[0] & { createConnection: () => Duplex })
    return issueRequest(
      httpsRequest,
      {
        host: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname + url.search,
        agent: tunnelAgent
      },
      url,
      init,
      {}
    )
  }
  if (url.protocol === 'http:') {
    // 纯 HTTP：按绝对路径形式发给代理，由代理转发
    return issueRequest(
      httpRequest,
      { host: config.host, port: config.port, path: url.href },
      url,
      init,
      config.authHeader ? { 'Proxy-Authorization': config.authHeader } : {}
    )
  }
  throw new Error(`env_proxy_unsupported_protocol: ${url.protocol}`)
}

type NodeRequestFn = typeof httpRequest

/** 向代理发起 CONNECT 并在返回的明文隧道上完成 TLS 握手 */
function openConnectTunnel(
  config: ProxyConfig,
  url: URL,
  signal?: AbortSignal
): Promise<Duplex> {
  return new Promise((resolve, reject) => {
    const target = `${url.hostname}:${url.port ? Number(url.port) : 443}`
    const req = httpRequest({
      host: config.host,
      port: config.port,
      method: 'CONNECT',
      path: target,
      agent: false,
      headers: {
        Host: target,
        ...(config.authHeader ? { 'Proxy-Authorization': config.authHeader } : {})
      }
    })

    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      proxyDebug(`CONNECT ${target} failed: ${error.message}`)
      signal?.removeEventListener('abort', onAbort)
      req.destroy()
      reject(error)
    }
    const onAbort = () => fail(new Error('cancelled'))

    signal?.addEventListener('abort', onAbort, { once: true })
    req.on('error', fail)
    // 非 2xx 的 CONNECT 响应不会触发 connect，而是走普通 response 事件
    req.on('response', res => {
      res.resume()
      fail(new Error(`proxy_connect_failed: HTTP ${res.statusCode ?? 0}`))
    })
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        fail(new Error(`proxy_connect_failed: HTTP ${res.statusCode ?? 0}`))
        return
      }
      signal?.removeEventListener('abort', onAbort)
      proxyDebug(`CONNECT ${target} established, starting TLS`)
      const tls = tlsConnect({ socket, servername: url.hostname })
      const onTlsAbort = () => tls.destroy()
      const done = (error?: Error) => {
        if (settled) return
        settled = true
        signal?.removeEventListener('abort', onTlsAbort)
        if (error) {
          tls.destroy()
          reject(error)
        } else {
          resolve(tls)
        }
      }
      signal?.addEventListener('abort', onTlsAbort, { once: true })
      tls.once('secureConnect', () => done())
      tls.once('error', error => done(error))
    })
    req.end()
  })
}

/** 在给定连接上发出请求并把 node 响应包装成 web Response（hop-by-hop 头不复制） */
function issueRequest(
  requestFn: NodeRequestFn,
  options: RequestOptions,
  url: URL,
  init: FetchInit,
  extraHeaders: Record<string, string>
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Host: url.host,
      ...init.headers,
      ...extraHeaders
    }
    if (init.body !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(init.body))
    }
    const req = requestFn({
      ...options,
      method: init.method ?? 'POST',
      headers,
      // 调用方注入的 agent（携带隧道 createConnection）优先；否则禁用连接池
      ...(options.agent === undefined ? { agent: false } : {})
    })

    const onAbort = () => req.destroy()
    init.signal?.addEventListener('abort', onAbort, { once: true })
    req.on('response', res => {
      // 响应头到达后，流传输阶段的取消由 web stream cancel 传导到 node res，无需再监听
      init.signal?.removeEventListener('abort', onAbort)
      resolve(toWebResponse(res))
    })
    req.on('error', error => {
      init.signal?.removeEventListener('abort', onAbort)
      reject(error)
    })
    if (init.body !== undefined) req.write(init.body)
    req.end()
  })
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length'
])

function toWebResponse(res: IncomingMessage): Response {
  const headers = new Headers()
  for (const [name, value] of Object.entries(res.headers)) {
    if (value === undefined || HOP_BY_HOP_HEADERS.has(name)) continue
    headers.append(name, Array.isArray(value) ? value.join(', ') : value)
  }
  return new Response(Readable.toWeb(res) as ReadableStream, {
    status: res.statusCode ?? 502,
    statusText: res.statusMessage ?? ''
  })
}
