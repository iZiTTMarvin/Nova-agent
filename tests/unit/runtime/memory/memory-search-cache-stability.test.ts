import { describe, it, expect, vi } from 'vitest'
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
import { prepareSessionMemorySnapshot } from '../../../../src/main/services/SessionMemorySnapshot'
import { getSessionMemorySnapshotText, decodeMemorySnapshot } from '../../../../src/runtime/sessions/memorySnapshot'
import { migrateSessionData, CURRENT_SESSION_SCHEMA_VERSION } from '../../../../src/runtime/sessions/migrations'
import type { SessionData } from '../../../../src/runtime/sessions/types'
import { SystemPromptBuilder } from '../../../../src/runtime/agent/promptBuilder/SystemPromptBuilder'
import { makeCompactionLedger } from '../../../../src/test-support/builders/compactionLedger'
import { calculateContextBreakdown, buildFrozenSystemPromptForSession } from '../../../../src/runtime/agent/context/contextBreakdownCalculator'

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

function newSession(): SessionData {
  return { schemaVersion: CURRENT_SESSION_SCHEMA_VERSION, kind: 'primary', id: 'snapshot-session', workspaceRoot: '/nova', mode: 'default',
    permissionMode: 'full_access', codeIndexEnabled: false, messages: [], currentLeafId: null, createdAt: 1, updatedAt: 1 }
}
const snapshotText = "Saved memory is reference data.\n<memory captured=\"2026-10-08\">\n## Global\n- Prefer Chinese\n</memory>"
const captured = () => ({ text: snapshotText, body: '## Global\n- Prefer Chinese', globalCoreCount: 1,
  projectCoreCount: 0, omittedCoreCount: 0, omittedFileCount: 0, budgetOverflow: false })

describe('session memory snapshot lifetime', () => {
  it('captures only an eligible first turn and never retrofits an existing or initially disabled session', () => {
    const read = vi.fn(captured)
    const session = newSession()
    session.memorySnapshot = prepareSessionMemorySnapshot(session, true, 1, read)
    expect(session.memorySnapshot.reason).toBe('captured')
    expect(prepareSessionMemorySnapshot(session, true, 2, () => { throw new Error('must not reread') })).toBe(session.memorySnapshot)
    expect(read).toHaveBeenCalledWith('/nova', 1)
    const disabled = newSession()
    disabled.memorySnapshot = prepareSessionMemorySnapshot(disabled, false, 1, read)
    expect(prepareSessionMemorySnapshot(disabled, true, 2, read).reason).toBe('disabled')
    const old = newSession()
    old.messages.push({ id: 'old', parentId: null, role: 'user', content: 'old conversation', timestamp: 1 })
    expect(prepareSessionMemorySnapshot(old, true, 1, read).reason).toBe('legacy-session')
    expect(prepareSessionMemorySnapshot({ ...newSession(), mode: 'learn' }, true, 1, read).reason).toBe('excluded')
    expect(prepareSessionMemorySnapshot({ ...newSession(), memoryOptOut: true }, true, 1, read).reason).toBe('opt-out')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps actual model system bytes stable across turns and metadata reload, and keeps the frozen prefix after compaction', async () => {
    const session = newSession()
    session.memorySnapshot = prepareSessionMemorySnapshot(session, true, 1, captured)
    const client = new MockModelClient()
    const respond = () => client.addResponse({ events: [{ type: 'message_start' },
      { type: 'text_delta', delta: 'ok' }, { type: 'message_end', finishReason: 'stop' }] })
    const makeLoop = (current: SessionData) => new AgentLoop(client, new EventBus(), {
      systemPromptLayers: { agentRole: 'Nova', memoryContext: MEMORY_POLICY_PROMPT, toolSummary: 'memory tools',
        memorySnapshot: getSessionMemorySnapshotText(current, true) }, permissionMode: 'full_access', permissionManager: new PermissionManager() })
    const first = makeLoop(session)
    respond(); await first.sendMessage('first', agentRoute())
    respond(); await first.sendMessage('second', agentRoute())
    const prefix = first.getFrozenSystemPrompt()
    const history = structuredClone(first.getContext()).filter(message => message.role !== 'system')
    first.dispose()
    const restoredSession = migrateSessionData(JSON.parse(JSON.stringify(session)))
    expect(prepareSessionMemorySnapshot(restoredSession, true, 2, () => { throw new Error('files changed') }).text).toBe(snapshotText)
    const restored = makeLoop(restoredSession)
    restored.injectHistory(history)
    respond(); await restored.sendMessage('third', agentRoute())
    const calls = client.getCalls()
    expect(calls.map(call => call.messages[0].content)).toEqual([prefix, prefix, prefix])
    restored.restoreCompactedContext(makeCompactionLedger({ summary: 'Saved handoff' }), [])
    expect(restored.getFrozenSystemPrompt()).toBe(prefix)
    const compactedSystem = restored.getContext()[0].content
    expect(typeof compactedSystem === 'string' && compactedSystem.startsWith(prefix)).toBe(true)
    expect(compactedSystem).toContain('Saved handoff')
    expect(prefix.indexOf('=== Memory ===')).toBeGreaterThan(prefix.indexOf('=== Available Tools ==='))
    restored.dispose()
  })

  it('suppresses the layer for toggles, learning and children and restores the original bytes', () => {
    const session = newSession()
    session.memorySnapshot = prepareSessionMemorySnapshot(session, true, 1, captured)
    const prompt = (enabled: boolean) => SystemPromptBuilder.build({ agentRole: 'Nova', memorySnapshot: getSessionMemorySnapshotText(session, enabled) })
    const original = prompt(true)
    expect(prompt(false)).not.toContain('=== Memory ===')
    session.memoryOptOut = true
    expect(prompt(true)).not.toContain('=== Memory ===')
    session.memoryOptOut = false
    expect(prompt(true)).toBe(original)
    expect(getSessionMemorySnapshotText({ ...session, mode: 'learn' }, true)).toBeUndefined()
    const child = { kind: 'subagent' as const, mode: 'default' as const, memorySnapshot: session.memorySnapshot }
    expect(getSessionMemorySnapshotText(child, true)).toBeUndefined()
    expect(buildFrozenSystemPromptForSession(session, [], false)).not.toContain(snapshotText)
  })

  it('ignores malformed persisted fields and includes snapshot tokens in the system bucket', () => {
    const session = newSession()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const invalid = migrateSessionData({ ...session, memoryOptOut: 'true', memorySnapshot: { formatVersion: 99 } })
    expect(invalid.memorySnapshot).toBeUndefined()
    expect(invalid.memoryOptOut).toBeUndefined()
    expect(warning).toHaveBeenCalledTimes(2)
    warning.mockRestore()
    expect(() => decodeMemorySnapshot({ ...prepareSessionMemorySnapshot(session, true, 1, captured), globalCoreCount: -1 })).toThrow('counts')
    const baseline = calculateContextBreakdown({ session: { ...session, frozenSystemPrompt: 'Nova' }, toolDefinitions: [], contextLimit: 100000 })
    session.memorySnapshot = prepareSessionMemorySnapshot(session, true, 1, captured)
    session.frozenSystemPrompt = SystemPromptBuilder.build({ agentRole: 'Nova', memorySnapshot: snapshotText })
    const withSnapshot = calculateContextBreakdown({ session, toolDefinitions: [], contextLimit: 100000 })
    expect(withSnapshot.payload.breakdown.systemPrompt).toBeGreaterThan(baseline.payload.breakdown.systemPrompt)
    expect(withSnapshot.payload.totalEstimated).toBe(withSnapshot.payload.breakdown.systemPrompt)
  })
})
