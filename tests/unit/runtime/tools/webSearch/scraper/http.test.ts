/**
 * scraper/http.ts 单元测试
 * 通过本地 HTTP fixture 覆盖请求头、正文超时、取消与资源释放。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'
import {
  scraperFetch,
  withScraperResponse
} from '../../../../../../src/runtime/tools/webSearch/scraper/http'

let server: Server
let baseUrl: string
const sockets = new Set<Socket>()
const releasedPaths: string[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/ok') {
      expect(req.headers['user-agent']).toContain('Chrome')
      expect(req.headers['accept-encoding']).toBe('identity')
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end('<html>ok</html>')
      return
    }

    if (req.url === '/header-hang') return

    if (req.url === '/connection-fail') {
      req.socket.destroy()
      return
    }

    if (req.url === '/slow-body') {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.flushHeaders()
      const timer = setTimeout(() => res.end('late body'), 150)
      res.on('close', () => clearTimeout(timer))
      return
    }

    if (req.url === '/trickle' || req.url === '/cancel-body' || req.url === '/release') {
      res.writeHead(req.url === '/release' ? 503 : 200, { 'content-type': 'text/plain' })
      res.flushHeaders()
      res.write('chunk')
      const timer = setInterval(() => res.write('.'), 20)
      res.on('close', () => {
        clearInterval(timer)
        if (!res.writableEnded) releasedPaths.push(req.url ?? '')
      })
      return
    }

    res.writeHead(404).end()
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  for (const socket of sockets) socket.destroy()
  await new Promise<void>(resolve => server.close(() => resolve()))
})

async function waitForRelease(path: string): Promise<void> {
  const deadline = Date.now() + 1_000
  while (!releasedPaths.includes(path)) {
    if (Date.now() >= deadline) throw new Error(`未释放响应：${path}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

describe('scraperFetch', () => {
  it('正常 GET 返回 HTML，并发送浏览器请求头', async () => {
    await expect(scraperFetch(`${baseUrl}/ok`)).resolves.toBe('<html>ok</html>')
  })

  it('响应头一直未到时按 deadline 超时', async () => {
    await expect(
      scraperFetch(`${baseUrl}/header-hang`, { timeoutMs: 40 })
    ).rejects.toThrow('请求超时（40ms）')
  })

  it('连接在响应头前断开时返回网络失败', async () => {
    await expect(scraperFetch(`${baseUrl}/connection-fail`)).rejects.toThrow()
  })

  it('响应头已到但正文过慢时仍按同一 deadline 超时', async () => {
    await expect(
      scraperFetch(`${baseUrl}/slow-body`, { timeoutMs: 40 })
    ).rejects.toThrow('请求超时（40ms）')
  })

  it('持续 trickle 不能无限续命', async () => {
    await expect(
      scraperFetch(`${baseUrl}/trickle`, { timeoutMs: 70 })
    ).rejects.toThrow('请求超时（70ms）')
    await waitForRelease('/trickle')
  })

  it('正文消费期间响应父 signal 取消并释放连接', async () => {
    const controller = new AbortController()
    const pending = scraperFetch(`${baseUrl}/cancel-body`, { signal: controller.signal })
    setTimeout(() => controller.abort(), 40)

    await expect(pending).rejects.toThrow('请求已取消')
    await waitForRelease('/cancel-body')
  })

  it('非 2xx 响应不读取正文时仍释放连接', async () => {
    await expect(scraperFetch(`${baseUrl}/release`)).rejects.toThrow('HTTP 503')
    await waitForRelease('/release')
  })

  it('消费者提前返回时仍释放未读正文', async () => {
    const status = await withScraperResponse(
      `${baseUrl}/release`,
      {},
      async response => response.status
    )

    expect(status).toBe(503)
  })

  it('调用前 signal 已中止时不发起请求', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      scraperFetch(`${baseUrl}/ok`, { signal: controller.signal })
    ).rejects.toThrow('请求已取消')
  })
})
