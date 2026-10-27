import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ModelClient } from '../../../../../src/runtime/model/ModelClient'
import type { ToolContext } from '../../../../../src/runtime/tools/types'
import { createReadState } from '../../../../../src/runtime/tools/editTool'
import { createWebFetchTool } from '../../../../../src/runtime/tools/webFetch/webFetchTool'

describe('web_fetch 定向提取', () => {
  let server: Server
  let baseUrl: string
  let cacheDir: string
  let pageFetches = 0
  let modelCalls = 0
  let previousCacheDir: string | undefined
  const cloudflareKeys = ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'] as const
  const previousCloudflare: Record<string, string | undefined> = {}

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/pricing') {
        pageFetches++
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(`<html><body><article><h1>Pricing</h1><p>Pro monthly price: $42.10 USD</p><p>${'Irrelevant full-page sentence. '.repeat(20)}</p></article></body></html>`)
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

  beforeEach(() => {
    pageFetches = 0
    modelCalls = 0
    cacheDir = mkdtempSync(join(tmpdir(), 'nova-web-extract-cache-'))
    previousCacheDir = process.env.NOVA_WEB_FETCH_CACHE_DIR
    process.env.NOVA_WEB_FETCH_CACHE_DIR = cacheDir
    for (const key of cloudflareKeys) {
      previousCloudflare[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    if (previousCacheDir === undefined) delete process.env.NOVA_WEB_FETCH_CACHE_DIR
    else process.env.NOVA_WEB_FETCH_CACHE_DIR = previousCacheDir
    for (const key of cloudflareKeys) {
      const value = previousCloudflare[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(cacheDir, { recursive: true, force: true })
  })

  function context(client?: ModelClient): ToolContext {
    return {
      workingDir: process.cwd(),
      readState: createReadState(),
      modelClient: client,
      contextWindow: 32_000,
      runId: 'run-web-extract',
      sessionId: 'session-web-extract'
    }
  }

  function client(): ModelClient {
    return {
      updateConfig: () => undefined,
      chat: () => {
        modelCalls++
        return (async function *() {
          yield {
            type: 'text_delta',
            delta: JSON.stringify({
              answers: {
                price: { value: 42.1, confidence: 0.99 },
                currency: { value: 'USD', confidence: 0.98 }
              }
            })
          } as const
        })()
      }
    }
  }

  // 与既有正文提取测试一致：冷态首次加载 ESM 提取库时允许更高超时。
  it('默认 readable 不调用提取模型，正文和结构化全文保持可用', async () => {
    const tool = createWebFetchTool()
    const result = await tool.execute({ url: `${baseUrl}/pricing` }, context(client()))
    expect(result.success).toBe(true)
    expect(result.output).toContain('Irrelevant full-page sentence')
    expect(result.structuredContent).toMatchObject({ kind: 'readable', content: expect.stringContaining('Pricing') })
    expect(modelCalls).toBe(0)
  }, 15_000)

  it('extract 只返回字段与证据，Code Mode 数据中的价格保留 number 类型', async () => {
    const tool = createWebFetchTool()
    const result = await tool.execute({
      url: `${baseUrl}/pricing`,
      mode: 'extract',
      fields: { price: 'number: Pro monthly price', currency: 'text' }
    }, context(client()))
    expect(result.success).toBe(true)
    expect(result.output).toContain('price: 42.1')
    expect(result.output).toContain('来源第')
    expect(result.output).not.toContain('Irrelevant full-page sentence')
    expect(result.structuredContent).toMatchObject({
      kind: 'extract',
      extraction: {
        provider: 'current-model',
        fields: {
          price: { status: 'extracted', value: 42.1 },
          currency: { status: 'extracted', value: 'USD' }
        }
      }
    })
    const extraction = (result.structuredContent as { extraction: { fields: { price: { value: unknown } } } }).extraction
    expect(typeof extraction.fields.price.value).toBe('number')
  })

  it('第二次命中页面与提取双层缓存，force 同时绕过两层', async () => {
    const tool = createWebFetchTool()
    const model = client()
    const args = {
      url: `${baseUrl}/pricing`,
      mode: 'extract',
      fields: { price: 'number' }
    }
    const first = await tool.execute(args, context(model))
    const second = await tool.execute(args, context(model))
    expect(first.success).toBe(true)
    expect(second.structuredContent).toMatchObject({ fromCache: true })
    expect(pageFetches).toBe(1)
    expect(modelCalls).toBe(1)

    const forced = await tool.execute({ ...args, force: true }, context(model))
    expect(forced.success).toBe(true)
    expect(pageFetches).toBe(2)
    expect(modelCalls).toBe(2)
  })

  it('字段与模式不匹配时，在抓取和模型调用之前失败', async () => {
    const tool = createWebFetchTool()
    const invalid = await tool.execute({ url: `${baseUrl}/pricing`, mode: 'extract' }, context(client()))
    expect(invalid.success).toBe(false)
    const misplaced = await tool.execute({ url: `${baseUrl}/pricing`, fields: { price: 'number' } }, context(client()))
    expect(misplaced.success).toBe(false)
    expect(pageFetches).toBe(0)
    expect(modelCalls).toBe(0)
  })

  it('普通旧请求晚完成时不能覆盖 force 刷新的页面缓存', async () => {
    let releaseOld!: () => void
    let notifyStarted!: () => void
    const started = new Promise<void>(resolve => { notifyStarted = resolve })
    const waiting = new Promise<void>(resolve => { releaseOld = resolve })
    let calls = 0
    const raceServer = createServer(async (_req, res) => {
      calls++
      res.setHeader('content-type', 'text/plain')
      if (calls === 1) {
        notifyStarted()
        await waiting
        res.end('Old price 20')
      } else res.end('New price 30')
    })
    await new Promise<void>(resolve => raceServer.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(raceServer.address() as AddressInfo).port}/price`
    const tool = createWebFetchTool()
    try {
      const old = tool.execute({ url }, context())
      await started
      const fresh = await tool.execute({ url, force: true }, context())
      releaseOld()
      await old
      const cached = await tool.execute({ url }, context())
      expect(fresh.output).toContain('New price 30')
      expect(cached.structuredContent).toMatchObject({ fromCache: true, content: 'New price 30' })
      expect(calls).toBe(2)
    } finally {
      releaseOld()
      await new Promise<void>(resolve => raceServer.close(() => resolve()))
    }
  })
})
