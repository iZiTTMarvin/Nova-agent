/**
 * T0-1：多 provider 请求体契约快照（改造前基线）
 *
 * 通过 mock fetch 捕获最终 JSON body，固化：
 * - cacheStrategy='anthropic' 时 cache_control 只在现有 marker 位置
 * - cacheStrategy='auto' 时绝不出现 cache_control / prompt_cache_key / reasoning_content
 * - tools 数组顺序与参数 JSON 键序在相同输入下逐字节稳定
 *
 * 覆盖：普通文本、多工具并行、图片投影、压缩内部请求、取消前半完成工具调用。
 * 禁止依赖真实 API key；不修改 src/。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import type { ChatMessage, ModelClientConfig, ToolDefinition } from '../../../../src/runtime/model/types'

/** 拦截 fetch，同时保留原始 JSON 字符串与解析后的 body */
function interceptFetch(): {
  rawBody: string | null
  body: Record<string, unknown> | null
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  let rawBody: string | null = null
  let capturedBody: Record<string, unknown> | null = null

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.body) {
      rawBody = init.body as string
      capturedBody = JSON.parse(rawBody)
    }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n')
        )
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    })
  }

  return {
    get rawBody() {
      return rawBody
    },
    get body() {
      return capturedBody
    },
    restore: () => {
      globalThis.fetch = originalFetch
    }
  }
}

async function drainChat(
  client: OpenAICompatibleModelClient,
  messages: ChatMessage[],
  tools?: ToolDefinition[],
  options?: Parameters<OpenAICompatibleModelClient['chat']>[2]
): Promise<void> {
  for await (const _ of client.chat(messages, tools, options)) {
    // 只需触发请求
  }
}

/** 递归收集对象树中所有出现过的键名 */
function collectKeysDeep(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectKeysDeep(item, out)
    return
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out.add(k)
      collectKeysDeep(v, out)
    }
  }
}

/** 收集 messages 里 cache_control 出现的 (messageIndex, contentBlockIndex) */
function collectCacheControlPositions(
  messages: Array<Record<string, unknown>>
): Array<{ msgIdx: number; blockIdx: number }> {
  const positions: Array<{ msgIdx: number; blockIdx: number }> = []
  messages.forEach((msg, msgIdx) => {
    const content = msg.content
    if (Array.isArray(content)) {
      content.forEach((block, blockIdx) => {
        if (
          block &&
          typeof block === 'object' &&
          'cache_control' in (block as Record<string, unknown>)
        ) {
          positions.push({ msgIdx, blockIdx })
        }
      })
    }
  })
  return positions
}

const BASE_CONFIG: ModelClientConfig = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'test-key-not-a-secret-for-prod',
  modelId: 'test-model'
}

const STABLE_TOOLS: ToolDefinition[] = [
  {
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, recursive: { type: 'boolean' } },
      required: ['path']
    }
  },
  {
    name: 'read',
    description: '读取文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, offset: { type: 'number' } },
      required: ['path']
    }
  },
  {
    name: 'grep',
    description: '搜索',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string' }, path: { type: 'string' } },
      required: ['pattern']
    }
  }
]

const IMG_BLOCK = {
  type: 'image_url' as const,
  image_url: { url: 'data:image/png;base64,abc123' }
}

describe('T0-1 请求体契约快照（改造前基线）', () => {
  let interceptor: ReturnType<typeof interceptFetch> | null = null

  afterEach(() => {
    interceptor?.restore()
    interceptor = null
  })

  describe('cacheStrategy=anthropic：cache_control 仅在现有 marker 位置', () => {
    it('普通文本：system + 最后 2 条非 system 带标记，中间消息不带', async () => {
      interceptor = interceptFetch()
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'anthropic'
      })

      await drainChat(client, [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'msg1' },
        { role: 'assistant', content: 'msg2' },
        { role: 'user', content: 'msg3' }
      ])

      const messages = interceptor.body!.messages as Array<Record<string, unknown>>
      const positions = collectCacheControlPositions(messages)

      // system(0) + assistant(2) + user(3)；msg1(1) 不标记
      expect(positions).toEqual([
        { msgIdx: 0, blockIdx: 0 },
        { msgIdx: 2, blockIdx: 0 },
        { msgIdx: 3, blockIdx: 0 }
      ])
      expect(typeof messages[1].content).toBe('string')
      expect(messages[1].content).toBe('msg1')
    })

    it('多工具并行：最后一个 tool 定义带 cache_control，前面的不带', async () => {
      interceptor = interceptFetch()
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'anthropic'
      })

      await drainChat(
        client,
        [{ role: 'user', content: '并行读两个文件' }],
        STABLE_TOOLS
      )

      const tools = interceptor.body!.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(3)
      expect(tools[0].cache_control).toBeUndefined()
      expect(tools[1].cache_control).toBeUndefined()
      expect(tools[2].cache_control).toEqual({ type: 'ephemeral' })
      // 顺序与入参一致（不按名称重排）
      expect(
        tools.map(t => (t.function as { name: string }).name)
      ).toEqual(['ls', 'read', 'grep'])
    })
  })

  describe('cacheStrategy=auto：禁止出现缓存/reasoning 相关字段', () => {
    async function assertAutoBodyClean(
      messages: ChatMessage[],
      tools?: ToolDefinition[],
      options?: Parameters<OpenAICompatibleModelClient['chat']>[2]
    ): Promise<Record<string, unknown>> {
      interceptor = interceptFetch()
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'auto'
      })
      await drainChat(client, messages, tools, options)
      const body = interceptor.body!
      const keys = new Set<string>()
      collectKeysDeep(body, keys)
      expect(keys.has('cache_control')).toBe(false)
      expect(keys.has('prompt_cache_key')).toBe(false)
      expect(keys.has('reasoning_content')).toBe(false)
      // 顶层也不应出现这些字段
      expect('prompt_cache_key' in body).toBe(false)
      expect('cache_control' in body).toBe(false)
      return body
    }

    it('普通文本请求体干净', async () => {
      const body = await assertAutoBodyClean([
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hello' }
      ])
      const messages = body.messages as Array<Record<string, unknown>>
      expect(typeof messages[0].content).toBe('string')
      expect(typeof messages[1].content).toBe('string')
    })

    it('多工具并行请求体干净且 tools 顺序稳定', async () => {
      const body = await assertAutoBodyClean(
        [{ role: 'user', content: '用工具' }],
        STABLE_TOOLS
      )
      const tools = body.tools as Array<Record<string, unknown>>
      expect(tools.map(t => (t.function as { name: string }).name)).toEqual([
        'ls',
        'read',
        'grep'
      ])
    })

    it('图片投影后请求体干净（非视觉模型剥离 image_url）', async () => {
      const body = await assertAutoBodyClean([
        {
          role: 'user',
          content: [
            { type: 'text', text: '看看这张图' },
            IMG_BLOCK
          ]
        }
      ])
      const messages = body.messages as Array<Record<string, unknown>>
      // 非视觉：投影为纯文本字符串
      expect(typeof messages[0].content).toBe('string')
      expect(String(messages[0].content)).toContain('看看这张图')
    })

    it('压缩内部请求（includeInternalMessages）正文可进 API，但无缓存字段', async () => {
      const body = await assertAutoBodyClean(
        [
          { role: 'user', content: '真实历史问题' },
          { role: 'assistant', content: '历史回答' },
          {
            role: 'user',
            content: '请对上面的对话历史生成摘要',
            internal: true
          }
        ],
        undefined,
        { includeInternalMessages: true }
      )
      const messages = body.messages as Array<Record<string, unknown>>
      expect(messages).toHaveLength(3)
      expect(messages[2].content).toBe('请对上面的对话历史生成摘要')
      // internal 元数据不得泄漏到 API
      expect(messages.every(m => !('internal' in m))).toBe(true)
    })

    it('取消前半完成工具调用：未配对 tool_calls 被剥离，请求体仍干净', async () => {
      const body = await assertAutoBodyClean([
        { role: 'user', content: '列出目录' },
        {
          role: 'assistant',
          content: '我来调用工具',
          // 典型 abort 残留：声明了 tool_calls 但无对应 tool 响应
          toolCalls: [{ id: 'tc_abort', name: 'ls', arguments: '{"path":"."}' }]
        }
      ])
      const messages = body.messages as Array<Record<string, unknown>>
      expect(messages).toHaveLength(2)
      expect(messages[1].tool_calls).toBeUndefined()
      expect(messages[1].content).toBe('我来调用工具')
    })
  })

  describe('tools 顺序与参数 JSON 键序逐字节稳定', () => {
    it('相同输入连续两次请求的 tools 段 JSON 完全一致', async () => {
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'auto'
      })
      const messages: ChatMessage[] = [{ role: 'user', content: '稳定工具定义' }]

      interceptor = interceptFetch()
      await drainChat(client, messages, STABLE_TOOLS)
      const raw1 = interceptor.rawBody!
      const toolsJson1 = JSON.stringify(
        (JSON.parse(raw1) as { tools: unknown }).tools
      )
      interceptor.restore()

      interceptor = interceptFetch()
      await drainChat(client, messages, STABLE_TOOLS)
      const raw2 = interceptor.rawBody!
      const toolsJson2 = JSON.stringify(
        (JSON.parse(raw2) as { tools: unknown }).tools
      )

      expect(toolsJson1).toBe(toolsJson2)
      // 参数对象键序与入参一致（properties 内 path 在 recursive 前）
      expect(toolsJson1).toContain('"properties":{"path"')
      expect(toolsJson1.indexOf('"path"')).toBeLessThan(toolsJson1.indexOf('"recursive"'))
    })

    it('anthropic 策略下 tools 段（含末尾 cache_control）也逐字节稳定', async () => {
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'anthropic'
      })
      const messages: ChatMessage[] = [{ role: 'user', content: '稳定' }]

      interceptor = interceptFetch()
      await drainChat(client, messages, STABLE_TOOLS)
      const tools1 = JSON.stringify(
        (interceptor.body as { tools: unknown }).tools
      )
      interceptor.restore()

      interceptor = interceptFetch()
      await drainChat(client, messages, STABLE_TOOLS)
      const tools2 = JSON.stringify(
        (interceptor.body as { tools: unknown }).tools
      )

      expect(tools1).toBe(tools2)
      expect(tools1).toContain('"cache_control":{"type":"ephemeral"}')
    })
  })

  describe('anthropic 场景覆盖：图片 / 压缩 / 半完成工具', () => {
    it('图片投影 + anthropic：标记位置仍只在 system/末尾非 system', async () => {
      interceptor = interceptFetch()
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'anthropic',
        supportsVision: true
      })

      await drainChat(client, [
        { role: 'system', content: 'vision sys' },
        {
          role: 'user',
          content: [{ type: 'text', text: '看图' }, IMG_BLOCK]
        }
      ])

      const messages = interceptor.body!.messages as Array<Record<string, unknown>>
      const positions = collectCacheControlPositions(messages)
      // system + 唯一 user（最后一条非 system）
      expect(positions.map(p => p.msgIdx)).toEqual([0, 1])
      // user 的 cache_control 打在最后一个 content block（图片块）上
      expect(positions[1].blockIdx).toBe(1)
    })

    it('压缩内部请求 + anthropic：internal 消息不参与 marker，且发往 API 前剥离 internal 字段', async () => {
      interceptor = interceptFetch()
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'anthropic'
      })

      await drainChat(
        client,
        [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'q1' },
          { role: 'assistant', content: 'a1' },
          { role: 'user', content: '压缩指令', internal: true }
        ],
        undefined,
        { includeInternalMessages: true }
      )

      const messages = interceptor.body!.messages as Array<Record<string, unknown>>
      expect(messages).toHaveLength(4)
      expect(messages.every(m => !('internal' in m))).toBe(true)

      const positions = collectCacheControlPositions(messages)
      // internal(3) 跳过；标记 system(0) + 最后 2 条非 system 非 internal：user(1)、assistant(2)
      expect(positions.map(p => p.msgIdx).sort((a, b) => a - b)).toEqual([0, 1, 2])
      // 压缩指令本身无 cache_control
      expect(typeof messages[3].content).toBe('string')
      expect(messages[3].content).toBe('压缩指令')
    })

    it('半完成工具调用 + anthropic：剥离后仍可对剩余消息打标记', async () => {
      interceptor = interceptFetch()
      const client = new OpenAICompatibleModelClient({
        ...BASE_CONFIG,
        cacheStrategy: 'anthropic'
      })

      await drainChat(client, [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: 'calling',
          toolCalls: [{ id: 'tc1', name: 'ls', arguments: '{}' }]
        }
      ])

      const messages = interceptor.body!.messages as Array<Record<string, unknown>>
      expect(messages[2].tool_calls).toBeUndefined()
      const positions = collectCacheControlPositions(messages)
      expect(positions.map(p => p.msgIdx)).toEqual([0, 1, 2])
    })
  })
})
