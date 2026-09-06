import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { createMemorySearchTool } from '../../../../src/runtime/tools/memorySearch'
import { MemoryRetrievalService } from '../../../../src/runtime/memory/retrieval/MemoryRetrievalService'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import { DEFAULT_NOVA_SETTINGS } from '../../../../src/runtime/settings/novaSettings'
import { MEMORY_POLICY_PROMPT } from '../../../../src/runtime/memory/memoryConfig'
import type { ScoredMemoryResult } from '../../../../src/runtime/memory/retrieval/MemoryRetriever'
import { projectExtractionMessages } from '../../../../src/runtime/memory/extraction/MemoryExtractor'

describe('主动记忆读取的请求历史', () => {
  it('记忆变化与重建会话都不改写已发送的前缀，检索结果不成为新证据', async () => {
    let content = '部署脚本位于 scripts/release.mjs'
    const retrieval = new MemoryRetrievalService({ structuredRetriever: { search: async (): Promise<ScoredMemoryResult[]> => [{
      id: 'deployment', group: 'structured-project', kind: 'convention', content, status: 'active', explicitness: 'user_explicit',
      confidence: 1, memoryKey: 'deployment', lastSeenAt: 0, advisory: false, historicalNote: null, source: null, lexicalScore: 1
    }] }, documentRetriever: { search: async () => [] } })
    const client = new MockModelClient()
    const makeLoop = (): AgentLoop => {
      const registry = new ToolRegistry()
      registry.register(createMemorySearchTool({ getMemoryRetrievalService: () => retrieval,
        loadSettings: () => ({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }) }))
      const loop = new AgentLoop(client, new EventBus(), { systemPrompt: MEMORY_POLICY_PROMPT,
        permissionManager: new PermissionManager(), permissionMode: 'full_access' })
      loop.setWorkingDir('/tmp/memory-test')
      loop.setWorkspaceRoot('/tmp/memory-test')
      loop.setToolRegistry(registry)
      return loop
    }
    const respond = (text: string): void => { client.addResponse({ events: [
      { type: 'message_start' }, { type: 'text_delta', delta: text }, { type: 'message_end', finishReason: 'stop' }
    ] }) }
    client.addResponse({ events: [{ type: 'message_start' },
      { type: 'tool_call', toolCall: { id: 'memory-call', name: 'memory_search', arguments: '{"query":"部署"}' } },
      { type: 'message_end', finishReason: 'tool_calls' }] })
    respond('先核对脚本')
    const loop = makeLoop()
    await loop.sendMessage('项目怎么部署', agentRoute())
    content = '最新约定改用另一个部署脚本'
    respond('沿用刚才的上下文')
    await loop.sendMessage('继续', agentRoute())
    const history = structuredClone(loop.getContext())
    loop.dispose()
    const restored = makeLoop()
    restored.injectHistory(history.filter(message => message.role !== 'system'))
    respond('恢复后继续')
    await restored.sendMessage('核对', agentRoute())
    const requests = client.getCalls().map(call => call.messages)
    expect(requests).toHaveLength(4)
    for (let i = 1; i < requests.length; i += 1) {
      expect(requests[i].slice(0, requests[i - 1].length)).toEqual(requests[i - 1])
    }
    expect(JSON.stringify(requests.at(-1))).toContain('scripts/release.mjs')
    expect(JSON.stringify(requests.at(-1))).not.toContain('最新约定')
    expect(requests.flat().some(message => message.skipCacheMarker)).toBe(false)
    expect(projectExtractionMessages(restored.getContext()).some(message => message.toolCallId === 'memory-call')).toBe(false)
    restored.dispose()
  })
})
