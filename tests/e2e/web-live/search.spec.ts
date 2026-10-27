import { expect, test } from '../fixtures/nova'
import type { NovaHarness } from '../fixtures/nova'

function toolOutput(nova: NovaHarness, requestIndex: number, callId: string): string {
  const messages = nova.provider.requests[requestIndex]?.body.messages
  if (!Array.isArray(messages)) throw new Error('模型请求缺少消息数组')
  const message = messages.find((value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && 'role' in value && value.role === 'tool' &&
    'tool_call_id' in value && value.tool_call_id === callId
  )
  if (typeof message?.content !== 'string') throw new Error(`缺少工具 ${callId} 的返回消息`)
  return message.content
}

test.skip(process.env.NOVA_WEB_LIVE !== '1', '显式设置 NOVA_WEB_LIVE=1 才访问公开免费搜索服务')
test.setTimeout(60_000)

test('默认模式下真实搜索和网页读取经 Electron 回灌模型请求', async ({ nova }) => {
    nova.provider.enqueue(
      { kind: 'tool', name: 'web_search', arguments: { query: 'TypeScript official documentation', maxResults: 3 }, callId: 'search' },
      { kind: 'tool', name: 'web_fetch', arguments: { url: 'https://www.typescriptlang.org/docs/' }, callId: 'fetch' },
      { kind: 'text', text: 'NOVA_WEB_LIVE_DIRECT_OK' }
    )
    await nova.sendPrompt('搜索 TypeScript 官方文档，再读取文档目录')
    await expect(nova.page.getByText('NOVA_WEB_LIVE_DIRECT_OK', { exact: false })).toBeVisible({ timeout: 45_000 })
    await nova.waitUntilIdle()
    expect(toolOutput(nova, 1, 'search')).toContain('https://www.typescriptlang.org/')
    expect(toolOutput(nova, 2, 'fetch')).toContain('Handbook')
    expect((await nova.getRunSnapshot())?.status).toBe('completed')
    expect(nova.pageErrors).toEqual([])
})

test.describe('脚本模式', () => {
  test.use({ toolPresentationMode: 'code-readonly' })
  test('真实搜索来源可被读取和筛选，正文留在沙箱', async ({ nova }) => {
    nova.provider.enqueue(
      {
        kind: 'tool', name: 'run_code', callId: 'web-code',
        arguments: {
          description: '查找官方文档并检查正文',
          code: `
            const search = await tools.web_search({ query: 'TypeScript official documentation', maxResults: 3 });
            const official = search.sources.find(s => s.url.startsWith('https://www.typescriptlang.org/') || s.url.startsWith('https://typescriptlang.org/'));
            if (!official) throw new Error('没有找到官方来源');
            const page = await tools.web_fetch({ url: official.url });
            return { source: official.url, hasHandbook: page.content.includes('Handbook'), chars: page.content.length };
          `
        }
      },
      { kind: 'text', text: 'NOVA_WEB_LIVE_CODE_OK' }
    )
    await nova.sendPrompt('用脚本搜索 TypeScript 官方文档并只返回来源和检查结果')
    await expect(nova.page.getByText('NOVA_WEB_LIVE_CODE_OK', { exact: false })).toBeVisible({ timeout: 45_000 })
    await nova.waitUntilIdle()
    const second = toolOutput(nova, 1, 'web-code')
    expect(second).toContain('https://www.typescriptlang.org/')
    expect(second).toMatch(/hasHandbook.*true/)
    expect(second).not.toContain('Quick introductions based on your background')
    expect((await nova.getRunSnapshot())?.status).toBe('completed')
    expect(nova.pageErrors).toEqual([])
  })
})

test('主来源限流时真实降级到第二个匿名接口', async ({ nova }) => {
    await nova.app.evaluate(() => {
      const state = globalThis as typeof globalThis & { webLiveHosts?: string[] }
      state.webLiveHosts = []
      const original = globalThis.fetch
      globalThis.fetch = async (input, init) => {
        const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
        state.webLiveHosts!.push(url.hostname)
        if (url.hostname === 'mcp.exa.ai') return new Response('', { status: 429 })
        return original(input, init)
      }
    })
    nova.provider.enqueue(
      { kind: 'tool', name: 'web_search', callId: 'fallback-search', arguments: { query: 'Electron BrowserWindow ready-to-show documentation', maxResults: 3 } },
      { kind: 'text', text: 'NOVA_WEB_LIVE_FALLBACK_OK' }
    )
    await nova.sendPrompt('搜索 Electron BrowserWindow 的官方说明')
    await expect(nova.page.getByText('NOVA_WEB_LIVE_FALLBACK_OK', { exact: false })).toBeVisible({ timeout: 45_000 })
    await nova.waitUntilIdle()
    const result = toolOutput(nova, 1, 'fallback-search')
    expect(result).toContain('## Sources')
    expect(result).toMatch(/https:\/\/(?:electronjs\.org\/|github\.com\/electron\/electron\/)/)
    const hosts = await nova.app.evaluate(() =>
      (globalThis as typeof globalThis & { webLiveHosts?: string[] }).webLiveHosts ?? []
    )
    expect(hosts).toContain('api.keenable.ai')
    expect(hosts).not.toContain('www.bing.com')
    expect(hosts).not.toContain('html.duckduckgo.com')
    expect(hosts).not.toContain('api.tavily.com')
    expect((await nova.getRunSnapshot())?.status).toBe('completed')
})
