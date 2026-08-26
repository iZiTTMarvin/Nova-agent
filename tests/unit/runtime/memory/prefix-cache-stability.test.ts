/**
 * 关键回归（PRD 34.1 / 34.2）：
 * - 记忆数据变化（写结构化库 + 改 MEMORY.md + 追加 episodic）后，system prompt
 *   逐字节不变，只含固定 Memory Policy；
 * - prefetch 块以 ephemeral user 消息进入当次模型请求（紧邻当前用户消息之前），
 *   不进入 AgentLoop.getContext()。
 * 装配与 AgentRuntimeFactory 同构：memoryContext = MEMORY_POLICY_PROMPT + wiring hooks。
 */
import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { buildStableSystemPrompt } from '../../../../src/runtime/agent/promptBuilder/modePrompt'
import { renderBaseRules } from '../../../../src/runtime/agent/promptRenderer'
import { extractTextFromContent } from '../../../../src/runtime/model/types'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { MEMORY_POLICY_PROMPT } from '../../../../src/runtime/memory/memoryConfig'
import { MEMORY_PREFETCH_BLOCK_TITLE } from '../../../../src/runtime/memory/retrieval/MemoryPrefetchService'
import { MemoryPrefetchService } from '../../../../src/runtime/memory/retrieval/MemoryPrefetchService'
import { createMemoryPrefetchWiring } from '../../../../src/runtime/memory/retrieval/MemoryPrefetchWiring'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import type {
  MemorySearchInput,
  MemorySearchResult,
  StructuredMemoryResult
} from '../../../../src/runtime/memory/retrieval/MemoryRetriever'

/** 可切换数据集的检索桩：模拟结构化库 + MEMORY.md + episodic 的组合变化 */
function createRetrievalStub() {
  let results: MemorySearchResult[] = []
  const queries: string[] = []
  return {
    queries,
    setResults(next: MemorySearchResult[]): void {
      results = next
    },
    search: async (input: MemorySearchInput): Promise<MemorySearchResult[]> => {
      queries.push(input.query)
      return results
    }
  }
}

function structured(content: string): StructuredMemoryResult {
  return {
    id: `mem_${content.length}`,
    group: 'structured-project',
    kind: 'decision',
    content,
    status: 'active',
    explicitness: 'workspace_verified',
    confidence: 0.9,
    memoryKey: 'k',
    lastSeenAt: 0,
    advisory: false,
    historicalNote: null,
    source: null
  }
}

function documentHit(body: string): MemorySearchResult {
  return {
    id: 'MEMORY.md',
    group: 'document',
    kind: 'document',
    relPath: 'MEMORY.md',
    body,
    advisory: false,
    historicalNote: null
  }
}

function createMemoryLoop(
  client: MockModelClient,
  retrieval: ReturnType<typeof createRetrievalStub>
): AgentLoop {
  const loop = new AgentLoop(client, new EventBus(), {
    permissionManager: new PermissionManager(),
    systemPromptLayers: {
      agentRole: buildStableSystemPrompt({ workingDir: '/tmp/project' }),
      baseRules: renderBaseRules(),
      projectRules: '',
      memoryContext: MEMORY_POLICY_PROMPT,
      skillContext: '',
      toolSummary: ''
    }
  })
  const wiring = createMemoryPrefetchWiring({
    prefetch: new MemoryPrefetchService(retrieval),
    projectScopeId: 'a'.repeat(16),
    workspaceRoot: '/tmp/project'
  })
  const hooks = loop.getHookManager()
  hooks.on('onMessageStart', wiring.onMessageStart)
  hooks.on('context', wiring.context)
  return loop
}

function reply(client: MockModelClient, text: string): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

function systemOf(messages: Array<{ role: string; content: unknown }>): string {
  return extractTextFromContent(messages.find(m => m.role === 'system')?.content ?? '')
}

describe('prefix-cache-stability（PRD 34.1）', () => {
  it('记忆数据变化后 system prompt 逐字节不变，只含固定 Memory Policy', async () => {
    const retrieval = createRetrievalStub()
    // 记忆 A：结构化 + MEMORY.md + episodic
    retrieval.setResults([
      structured('决定使用 PostgreSQL'),
      documentHit('# 项目记忆\n部署使用 pnpm。')
    ])
    const clientA = new MockModelClient()
    reply(clientA, '好的')
    const loop = createMemoryLoop(clientA, retrieval)

    await loop.sendMessage('部署用什么数据库', agentRoute())
    const systemA = systemOf(clientA.getCalls()[0].messages)
    expect(systemA).toContain(MEMORY_POLICY_PROMPT)
    expect(systemA).not.toContain('PostgreSQL')
    expect(systemA).not.toContain('pnpm')

    // 更新记忆：结构化改 SQLite、MEMORY.md 改 npm、追加 episodic 命中
    retrieval.setResults([
      structured('决定使用 SQLite'),
      documentHit('# 项目记忆\n部署使用 npm。'),
      {
        id: 'episodic/summary.md',
        group: 'document',
        kind: 'document',
        relPath: 'episodic/summary.md',
        body: '## 本周\n重构了登录模块。',
        advisory: false,
        historicalNote: null
      }
    ])

    // 同一 loop 的下一轮 + 重新装配的 loop，两处都要逐字节一致
    reply(clientA, '收到')
    await loop.sendMessage('那包管理器呢', agentRoute())
    const systemB = systemOf(clientA.getCalls()[1].messages)

    const clientC = new MockModelClient()
    reply(clientC, '嗯')
    const rebuilt = createMemoryLoop(clientC, retrieval)
    await rebuilt.sendMessage('继续', agentRoute())
    const systemC = systemOf(clientC.getCalls()[0].messages)

    expect(systemB).toBe(systemA)
    expect(systemC).toBe(systemA)
  })

  it('动态记忆块进入请求但不进入 system prompt（PRD 34.2 请求侧）', async () => {
    const retrieval = createRetrievalStub()
    retrieval.setResults([structured('决定使用 PostgreSQL')])
    const client = new MockModelClient()
    reply(client, '好的')
    const loop = createMemoryLoop(client, retrieval)

    await loop.sendMessage('数据库选型', agentRoute())

    const call = client.getCalls()[0]
    const systemText = systemOf(call.messages)
    expect(systemText).not.toContain(MEMORY_PREFETCH_BLOCK_TITLE)

    const messages = call.messages as Array<{ role: string; content: unknown; skipCacheMarker?: boolean }>
    const ephemeralIdx = messages.findIndex(m => extractTextFromContent(m.content).includes(MEMORY_PREFETCH_BLOCK_TITLE))
    expect(ephemeralIdx).toBeGreaterThan(-1)
    expect(messages[ephemeralIdx].role).toBe('user')
    expect(messages[ephemeralIdx].skipCacheMarker).toBe(true)

    // 位置紧邻当前用户消息之前
    const userIdx = messages.findIndex(m => m.role === 'user' && extractTextFromContent(m.content).includes('数据库选型'))
    expect(userIdx).toBe(ephemeralIdx + 1)

    // getContext()（持久化与压缩的输入来源）不含注入块
    const persisted = loop.getContext()
    expect(
      persisted.some(m => extractTextFromContent(m.content).includes(MEMORY_PREFETCH_BLOCK_TITLE))
    ).toBe(false)
  })
})
