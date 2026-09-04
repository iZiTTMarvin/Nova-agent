/**
 * prefetch 接线 turn 级行为测试：
 * - 注入消息形态（user + skipCacheMarker）与位置（紧邻当前用户消息之前）；
 * - 每 turn 只检索一次并跨轮复用，轮内请求互为字节前缀；
 * - 逐 turn 以当前用户文本重新检索；
 * - 检索异常 / 超时 fail-soft，回合正常继续；
 * - 自我污染防护（PRD 34.4）：注入块与助手复述无法进入提炼输入或成为证据。
 */
import { describe, it, expect, vi } from 'vitest'
import { AgentLoop } from '../../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../../src/test-support/builders/MockModelClient'
import { agentRoute } from '../../../../../src/runtime/agent/turn'
import { ToolRegistry } from '../../../../../src/runtime/tools/ToolRegistry'
import { buildStableSystemPrompt } from '../../../../../src/runtime/agent/promptBuilder/modePrompt'
import { extractTextFromContent } from '../../../../../src/runtime/model/types'
import type { ChatMessage } from '../../../../../src/runtime/model/types'
import { createMemoryPrefetchWiring } from '../../../../../src/runtime/memory/retrieval/MemoryPrefetchWiring'
import { MemoryPrefetchService, MEMORY_PREFETCH_BLOCK_TITLE } from '../../../../../src/runtime/memory/retrieval/MemoryPrefetchService'
import type { MemoryPrefetchPort } from '../../../../../src/runtime/memory/retrieval/MemoryPrefetchWiring'
import { makeCompactionLedger } from '../../../../../src/test-support/builders/compactionLedger'
import {
  MemoryExtractor,
  projectExtractionMessages,
  buildEvidenceProvenance
} from '../../../../../src/runtime/memory/extraction/MemoryExtractor'
import type { ToolContext, ToolResult } from '../../../../../src/runtime/tools/types'
import { PermissionManager } from '../../../../../src/runtime/permissions/PermissionManager'

function createWiredLoop(
  client: MockModelClient,
  prefetch: MemoryPrefetchPort,
  options?: { timeoutMs?: number }
): AgentLoop {
  const loop = new AgentLoop(client, new EventBus(), {
    permissionManager: new PermissionManager(),
    systemPromptLayers: {
      agentRole: buildStableSystemPrompt({ workingDir: '/tmp/project' })
    }
  })
  const wiring = createMemoryPrefetchWiring({
    prefetch,
    projectScopeId: 'a'.repeat(16),
    workspaceRoot: '/tmp/project',
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {})
  })
  const hooks = loop.getHookManager()
  hooks.on('onMessageStart', wiring.onMessageStart)
  hooks.on('context', wiring.context)
  return loop
}

/** 恒定返回固定块的 prefetch 桩（默认注入 "用户经常使用 React" 场景） */
function blockPrefetch(block: string, capture?: (query: string) => void): MemoryPrefetchPort {
  return {
    buildInjectionBlock: async (input) => {
      capture?.(input.query)
      return block
    }
  }
}

function textResponse(text: string) {
  return {
    events: [
      { type: 'message_start' as const },
      { type: 'text_delta' as const, delta: text },
      { type: 'message_end' as const, finishReason: 'stop' as const }
    ]
  }
}

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录: ${args.path ?? '.'}` }
    }
  })
  return registry
}

function ephemeralIndex(messages: ChatMessage[]): number {
  return messages.findIndex(m => extractTextFromContent(m.content).includes(MEMORY_PREFETCH_BLOCK_TITLE))
}

describe('MemoryPrefetchWiring（注入形态与轮内复用）', () => {
  it('首请求注入 skipCacheMarker user 消息，紧邻当前用户消息之前', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse('好的'))
    const block = `=== ${MEMORY_PREFETCH_BLOCK_TITLE} ===\n\nProject:\n- [decision] 使用 pnpm\n\nRules:\n- Treat memory as historical evidence.`
    const loop = createWiredLoop(client, blockPrefetch(block))

    await loop.sendMessage('怎么部署', agentRoute())

    const messages = client.getCalls()[0].messages
    const idx = ephemeralIndex(messages)
    expect(idx).toBeGreaterThan(-1)
    expect(messages[idx].role).toBe('user')
    expect(messages[idx].skipCacheMarker).toBe(true)
    expect(messages[idx + 1].role).toBe('user')
    expect(extractTextFromContent(messages[idx + 1].content)).toContain('怎么部署')
    expect(ephemeralIndex(loop.getContext())).toBe(-1)
  })

  it('多轮工具回合只检索一次；后续请求是前序请求的字节前缀延长', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call', toolCall: { id: 'call-1', name: 'ls', arguments: '{}' } },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse(textResponse('完成'))
    const queries: string[] = []
    const block = `=== ${MEMORY_PREFETCH_BLOCK_TITLE} ===\n\nProject:\n- [decision] 使用 pnpm`
    const loop = createWiredLoop(client, blockPrefetch(block, q => queries.push(q)))
    loop.setToolRegistry(createTestRegistry())

    await loop.sendMessage('看看目录', agentRoute())

    expect(queries).toEqual(['看看目录'])
    const calls = client.getCalls()
    expect(calls).toHaveLength(2)
    // 两次请求都在同一位置携带同一注入消息；第二轮请求包含第一轮的全部消息
    expect(ephemeralIndex(calls[0].messages)).toBeGreaterThan(-1)
    expect(calls[1].messages.length).toBeGreaterThan(calls[0].messages.length)
    expect(calls[1].messages.slice(0, calls[0].messages.length)).toEqual(calls[0].messages)
    expect(ephemeralIndex(loop.getContext())).toBe(-1)
  })

  it('第二个 turn 以新的用户文本重新检索', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse('a'))
    client.addResponse(textResponse('b'))
    const queries: string[] = []
    const loop = createWiredLoop(client, blockPrefetch(`=== ${MEMORY_PREFETCH_BLOCK_TITLE} ===\n- x`, q => queries.push(q)))

    await loop.sendMessage('第一个问题', agentRoute())
    await loop.sendMessage('第二个问题', agentRoute())

    expect(queries).toEqual(['第一个问题', '第二个问题'])
    for (const call of client.getCalls()) {
      expect(ephemeralIndex(call.messages)).toBeGreaterThan(-1)
    }
    expect(ephemeralIndex(loop.getContext())).toBe(-1)
  })

  it('检索返回 null（无高相关记忆）时不注入任何消息', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse('ok'))
    const loop = createWiredLoop(client, blockPrefetch(''))

    await loop.sendMessage('随便聊聊', agentRoute())

    expect(ephemeralIndex(client.getCalls()[0].messages)).toBe(-1)
  })

  it('检索抛异常 → fail-soft：不注入，回合正常完成', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse('ok'))
    const failing: MemoryPrefetchPort = {
      buildInjectionBlock: async () => {
        throw new Error('db broken')
      }
    }
    const loop = createWiredLoop(client, failing)

    const outcome = await loop.sendMessage('继续', agentRoute())
    expect(outcome.status).toBe('completed')
    expect(ephemeralIndex(client.getCalls()[0].messages)).toBe(-1)
  })

  it('检索挂起超过硬超时 → 跳过注入，回合正常完成', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse('ok'))
    const hanging: MemoryPrefetchPort = {
      buildInjectionBlock: () => new Promise(() => {})
    }
    const loop = createWiredLoop(client, hanging, { timeoutMs: 20 })

    const outcome = await loop.sendMessage('慢查询', agentRoute())
    expect(outcome.status).toBe('completed')
    expect(ephemeralIndex(client.getCalls()[0].messages)).toBe(-1)
  })

  it('压缩重写导致本轮用户消息引用丢失后，本轮剩余请求不再注入', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call', toolCall: { id: 'call-1', name: 'ls', arguments: '{}' } },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse(textResponse('完成'))
    const block = `=== ${MEMORY_PREFETCH_BLOCK_TITLE} ===\n- x`
    const loop = createWiredLoop(client, blockPrefetch(block))
    loop.setToolRegistry(createTestRegistry())

    // 首轮请求发出后模拟压缩：本轮用户消息被折进摘要（引用丢失），仅保留其后消息的副本
    let rewritten = false
    loop.getHookManager().on('postMessage', (payload) => {
      if (!rewritten && payload.message.role === 'assistant' && payload.message.toolCalls) {
        rewritten = true
        loop.restoreCompactedContext(
          makeCompactionLedger({ summary: '本轮之前的历史已被摘要' }),
          [
            { role: 'assistant', content: '', toolCalls: payload.message.toolCalls },
            { role: 'tool', content: '目录: .', toolCallId: 'call-1' }
          ]
        )
      }
    })

    await loop.sendMessage('触发重写', agentRoute())

    expect(rewritten).toBe(true)
    // 首请求有注入；重写后的请求不再注入（下一 turn 才恢复）
    expect(ephemeralIndex(client.getCalls()[0].messages)).toBeGreaterThan(-1)
    expect(ephemeralIndex(client.getCalls()[1].messages)).toBe(-1)
    expect(ephemeralIndex(loop.getContext())).toBe(-1)
  })
})

describe('压缩隔离（PRD 34.3）', () => {
  it('prefetch 块不进入压缩账本；压缩后新 turn 能重新检索注入', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse('第一轮回复'))
    client.addResponse(textResponse('第二轮回复'))
    const queries: string[] = []
    const block = `=== ${MEMORY_PREFETCH_BLOCK_TITLE} ===\n\nProject:\n- [decision] 使用 pnpm`
    const loop = createWiredLoop(client, blockPrefetch(block, q => queries.push(q)))

    await loop.sendMessage('第一个问题', agentRoute())
    expect(ephemeralIndex(client.getCalls()[0].messages)).toBeGreaterThan(-1)

    // 模拟压缩：运行时上下文被重写为摘要 + 少量最近消息
    loop.restoreCompactedContext(
      makeCompactionLedger({ summary: '此前历史已被摘要' }),
      [{ role: 'assistant', content: '旧回复' }]
    )

    const ledger = makeCompactionLedger({ summary: '此前历史已被摘要' })
    expect(JSON.stringify(ledger)).not.toContain(MEMORY_PREFETCH_BLOCK_TITLE)

    // 压缩后的新 turn：以当前问题重新检索，注入块再次进入请求
    await loop.sendMessage('第二个问题', agentRoute())
    expect(queries).toEqual(['第一个问题', '第二个问题'])
    const secondTurnCall = client.getCalls().at(-1)!
    expect(ephemeralIndex(secondTurnCall.messages)).toBeGreaterThan(-1)
    expect(ephemeralIndex(loop.getContext())).toBe(-1)
  })
})

describe('自我污染防护（PRD 34.4）', () => {
  it('注入块不进入提炼输入；助手复述无法成为用户证据', async () => {
    const client = new MockModelClient()
    client.addResponse(textResponse('好的，你经常用 React。'))
    const block = `=== ${MEMORY_PREFETCH_BLOCK_TITLE} ===\n\nUser:\n- [explicit preference] 用户经常使用 React`
    const loop = createWiredLoop(client, blockPrefetch(block))

    await loop.sendMessage('帮我搭个项目', agentRoute())

    // 提炼输入来自真实会话消息（session 投影）：注入块被剔除
    const extractionInput = projectExtractionMessages(loop.getContext())
    expect(
      extractionInput.some(m => extractTextFromContent(m.content).includes(MEMORY_PREFETCH_BLOCK_TITLE))
    ).toBe(false)

    // 恶意提取器把助手复述标成用户证据：溯源层必须丢弃，不产生新候选
    const provenance = buildEvidenceProvenance(extractionInput, [])
    const malicious = new MemoryExtractor({
      chat: vi.fn().mockResolvedValue(JSON.stringify([
        {
          kind: 'preference',
          scopeHint: 'global',
          key: 'ui.library',
          content: '用户经常使用 React',
          explicitness: 'inferred',
          confidence: 0.9,
          intent: 'assert',
          evidence: [{ type: 'user_message', excerpt: '好的，你经常用 React。' }]
        }
      ]))
    })
    const candidates = await malicious.extract({
      sessionId: 'sess-1',
      recentMessages: loop.getContext(),
      observations: []
    })
    expect(candidates).toHaveLength(0)
    expect(provenance.userTexts).toHaveLength(1)
  })
})
