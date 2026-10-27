import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { webSearchTool } from '../../src/runtime/tools/webSearch'
import { createWebFetchTool } from '../../src/runtime/tools/webFetch'
import { createReadState } from '../../src/runtime/tools/editTool'
import type { JsonValue } from '../../src/shared/tools/types'

if (!process.argv.includes('--live')) throw new Error('此检查会访问公开网络；显式传入 --live 后运行')
const outputIndex = process.argv.indexOf('--output')
const output = resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : 'docs/Local_Docs/评估报告/2026-10-27-Web能力优化/live-results.json')
const cache = mkdtempSync(join(tmpdir(), 'nova-web-live-'))
const previousCache = process.env.NOVA_WEB_FETCH_CACHE_DIR
process.env.NOVA_WEB_FETCH_CACHE_DIR = cache
delete process.env.TAVILY_API_KEY

const cases = [
  { query: 'TypeScript official documentation', domain: 'typescriptlang.org', marker: 'TypeScript' },
  { query: 'Python 官方文档 asyncio TaskGroup', domain: 'docs.python.org', marker: 'TaskGroup' },
  { query: 'site:react.dev/reference/react/useEffect useEffect cleanup', domain: 'react.dev', marker: 'useEffect' },
  { query: 'Electron BrowserWindow ready-to-show documentation', domain: 'electronjs.org', marker: 'ready-to-show' },
  { query: '日本 気象庁 津波 警報 公式', domain: 'jma.go.jp', marker: '津波' },
  { query: 'Node.js release', recency: 'week' as const, domain: 'nodejs.org', marker: 'release' }
]

function record(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
}

const fetchTool = createWebFetchTool()
const context = { workingDir: process.cwd(), readState: createReadState() }
const results: object[] = []
let failures = 0
try {
  for (const sample of cases) {
    const startedAt = Date.now()
    const search = await webSearchTool.execute({ query: sample.query, recency: sample.recency, maxResults: 5 }, context)
    const data = record(search.structuredContent)
    const rawSources = Array.isArray(data?.sources) ? data.sources : []
    const sources = rawSources.flatMap(item => {
      const value = record(item)
      return typeof value?.url === 'string' && typeof value.title === 'string'
        ? [{ url: value.url, title: value.title, publishedDate: value.publishedDate }] : []
    })
    const official = sources.find(item => {
      const hostname = new URL(item.url).hostname
      return hostname === sample.domain || hostname.endsWith(`.${sample.domain}`)
    })
    const searchMs = Date.now() - startedAt
    const fetched = official ? await fetchTool.execute({ url: official.url }, context) : undefined
    const body = record(fetched?.structuredContent)?.content
    const readable = typeof body === 'string' ? body : ''
    const passed = search.success && !!official && fetched?.success === true &&
      readable.toLowerCase().includes(sample.marker.toLowerCase())
    if (!passed) failures++
    const result = {
      query: sample.query, recency: sample.recency, expectedDomain: sample.domain, expectedBodyMarker: sample.marker,
      passed, provider: data?.provider, searchMs, totalMs: Date.now() - startedAt,
      sources, selectedUrl: official?.url, fetchedCharacters: readable.length,
      searchError: search.error, fetchError: fetched?.error
    }
    results.push(result)
    console.log(JSON.stringify(result))
  }
} finally {
  mkdirSync(dirname(output), { recursive: true })
  writeFileSync(output, JSON.stringify({
    recordedAt: new Date().toISOString(), mode: 'Node native tools; no API key or model call',
    samples: cases.length, failures, results,
    limits: 'Small public-page smoke sample; not a general success-rate, model-accuracy, latency or cost benchmark.'
  }, null, 2))
  if (previousCache === undefined) delete process.env.NOVA_WEB_FETCH_CACHE_DIR
  else process.env.NOVA_WEB_FETCH_CACHE_DIR = previousCache
  rmSync(cache, { recursive: true, force: true })
}
if (failures) process.exitCode = 1
