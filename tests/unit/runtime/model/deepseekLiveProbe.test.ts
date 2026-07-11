/**
 * DeepSeek 服务端前缀缓存真实命中率观测。
 *
 * 需要真实 API key（DEEPSEEK_API_KEY），默认 CI 不执行。
 * 仅用于本地或具备授权的环境手动观测 DeepSeek 服务端缓存行为。
 * 不承诺固定命中率，数字供趋势对比；断言只做结构校验。
 *
 * 环境变量：
 * - DEEPSEEK_API_KEY（必填，缺失则整组 skip）
 * - DEEPSEEK_BASE_URL（缺省 https://api.deepseek.com/v1）
 * - DEEPSEEK_MODEL（缺省 deepseek-chat）
 */
import { describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatMessage, NormalizedUsage, ToolDefinition } from '../../../../src/runtime/model/types'

const apiKey = process.env.DEEPSEEK_API_KEY
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1'
const modelId = process.env.DEEPSEEK_MODEL ?? 'deepseek-chat'

const STABLE_SYSTEM =
  'You are a concise coding assistant. Keep replies short. Prefer tools when asked to inspect files.'

const STABLE_TOOLS: ToolDefinition[] = [
  {
    name: 'ls',
    description: 'List directory entries',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory path' } },
      required: ['path']
    }
  },
  {
    name: 'read',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path' },
        offset: { type: 'number', description: 'Optional start line' }
      },
      required: ['path']
    }
  }
]

interface ProbeRound {
  round: number
  promptTokens: number
  cachedTokens: number | undefined
  cacheMissTokens: number | undefined
  completionTokens: number
  ttftMs: number | undefined
}

function isFiniteNumberOrUndefined(v: unknown): boolean {
  return v === undefined || (typeof v === 'number' && Number.isFinite(v))
}

async function runRound(
  client: OpenAICompatibleModelClient,
  messages: ChatMessage[],
  tools: ToolDefinition[] | undefined
): Promise<{ usage: NormalizedUsage | null; ttftMs: number | undefined; assistantText: string }> {
  const started = Date.now()
  let ttftMs: number | undefined
  let usage: NormalizedUsage | null = null
  let assistantText = ''

  for await (const ev of client.chat(messages, tools)) {
    if (ev.type === 'text_delta') {
      if (ttftMs === undefined) ttftMs = Date.now() - started
      assistantText += ev.delta
    } else if (ev.type === 'usage') {
      usage = ev.usage
    } else if (ev.type === 'error') {
      throw new Error(`DeepSeek live probe error: ${ev.error}`)
    } else if (ev.type === 'context_overflow') {
      throw new Error(`DeepSeek live probe overflow: ${ev.rawError}`)
    }
  }

  return { usage, ttftMs, assistantText }
}

const describeLive = apiKey ? describe : describe.skip

describeLive('DeepSeek live cache probe', () => {
  it(
    '10 轮观测：记录 cached/miss/TTFT（结构断言，无命中率阈值）',
    async () => {
      const client = new OpenAICompatibleModelClient({
        baseUrl,
        apiKey: apiKey!,
        modelId,
        cacheProfile: 'deepseek'
      })

      const history: ChatMessage[] = [{ role: 'system', content: STABLE_SYSTEM }]
      const results: ProbeRound[] = []

      const userTurns: Array<{ content: string; withTools: boolean; idleMs?: number }> = [
        { content: 'Hello. Confirm you are ready.', withTools: false },
        { content: 'List files under src using the ls tool if needed.', withTools: true },
        { content: 'List files under tests using the ls tool if needed.', withTools: true },
        { content: 'Read package.json with the read tool if needed and summarize name only.', withTools: true },
        { content: 'Reply with one short sentence about TypeScript.', withTools: false },
        { content: 'Continue: one short sentence about Electron.', withTools: false, idleMs: 10_000 },
        { content: 'One short sentence about Vitest.', withTools: false },
        { content: 'One short sentence about caching.', withTools: false },
        { content: 'One short sentence about prefixes.', withTools: false },
        { content: 'One short sentence about observability.', withTools: false }
      ]

      for (let i = 0; i < userTurns.length; i++) {
        const turn = userTurns[i]
        if (turn.idleMs) {
          await new Promise((r) => setTimeout(r, turn.idleMs))
        }

        history.push({ role: 'user', content: turn.content })
        const tools = turn.withTools ? STABLE_TOOLS : undefined
        const { usage, ttftMs, assistantText } = await runRound(client, [...history], tools)

        expect(usage).not.toBeNull()
        expect(usage!.promptTokens).toBeGreaterThan(0)

        results.push({
          round: i,
          promptTokens: usage!.promptTokens,
          cachedTokens: usage!.cachedTokens,
          cacheMissTokens: usage!.cacheMissTokens,
          completionTokens: usage!.completionTokens,
          ttftMs
        })

        history.push({
          role: 'assistant',
          content: assistantText || '(empty)'
        })
      }

      expect(results).toHaveLength(10)

      for (const row of results) {
        expect(row.promptTokens).toBeGreaterThan(0)
        expect(isFiniteNumberOrUndefined(row.cachedTokens)).toBe(true)
        expect(isFiniteNumberOrUndefined(row.cacheMissTokens)).toBe(true)
        expect(Number.isFinite(row.completionTokens)).toBe(true)
      }

      // 第 1 轮之后：宽松观察，不写死命中率阈值
      for (let i = 1; i < results.length; i++) {
        const cached = results[i].cachedTokens ?? 0
        expect(cached).toBeGreaterThanOrEqual(0)
      }

      console.table(
        results.map((r) => ({
          round: r.round,
          promptTokens: r.promptTokens,
          cachedTokens: r.cachedTokens,
          cacheMissTokens: r.cacheMissTokens,
          completionTokens: r.completionTokens,
          ttftMs: r.ttftMs
        }))
      )
    },
    180_000
  )
})
