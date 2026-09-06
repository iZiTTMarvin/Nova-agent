import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore, buildConversationContext, type BuildConversationContextOptions } from '../../../src/runtime/sessions'
import { resetSessionIndexHostForTests } from '../../../src/runtime/sessions/SessionIndexHost'
import { restoreFromLedger } from '../../../src/runtime/sessions/contextSnapshot'
import { CompactionService } from '../../../src/runtime/agent/compaction/CompactionService'
import { createAgentContext } from '../../../src/runtime/agent/core/AgentContext'
import { defaultContextBudgetManager } from '../../../src/runtime/agent/ContextBudgetManager'
import { CacheDiagnostics } from '../../../src/runtime/model/cacheDiagnostics'
import { createReadState } from '../../../src/runtime/tools/editTool'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { identitySummaryProjection } from '../../../src/test-support/builders/identitySummaryProjection'
import * as atomicFile from '../../../src/runtime/storage/atomicFile'
import { formatMemorySearchResults } from '../../../src/runtime/tools/memorySearch'
import { estimateContextTokens } from '../../../src/runtime/agent/tokenEstimator'

describe('持久化压缩提交', () => {
  let directory: string
  let store: SessionStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'nova-compaction-commit-'))
    store = new SessionStore(directory)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    resetSessionIndexHostForTests()
    rmSync(directory, { recursive: true, force: true })
  })
  function fixture(projection: BuildConversationContextOptions = {}, multimodal = false, thinking = false, memory = false) {
    const session = store.create(directory, 'default')
    for (let i = 0; i < 24; i++) {
      const text = i === 0 ? '实现账单导出。\n必须保留金额单位 CNY。' : `继续工作 ${i}`
      store.appendMessage(session.id, { id: `u${i}`, role: 'user', content: multimodal ? [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'nova-image://fixture.png' } }] : text, timestamp: i * 2 })
      store.appendMessage(session.id, { id: `a${i}`, role: 'assistant', content: 'x'.repeat(1000), timestamp: i * 2 + 1,
        ...(memory ? { blocks: [{ type: 'tool' as const, toolCallId: `memory${i}`, toolName: 'memory_search',
          arguments: { query: '导出' }, status: 'success' as const, result: formatMemorySearchResults([{
            id: 'export', group: 'document', kind: 'document', relPath: 'export.md', body: '历史导出约定：使用 UTF8 BOM；必须核对当前工作区。',
            advisory: false, historicalNote: null
          }], '导出') }, { type: 'text' as const, content: 'x'.repeat(1000) }] }
          : thinking ? { blocks: [{ type: 'thinking' as const, content: 'thought', providerId: 'fixture' }, { type: 'text' as const, content: 'x'.repeat(1000) }] } : {}) })
    }
    const context = createAgentContext({ readState: createReadState(), messages: [{ role: 'system', content: 'system' }, ...buildConversationContext(store.load(session.id)!, 'default', projection)],
      systemPrompt: 'system', sessionStore: store, sessionId: session.id })
    const model = new MockModelClient().addHandoffPair({ events: [{ type: 'text_delta', delta: '继续实现导出' }, { type: 'message_end', finishReason: 'stop' }] })
    const diagnostics = new CacheDiagnostics()
    let authority = true
    const service = new CompactionService({ context, modelClient: model, contextWindow: 4000,
      contextBudgetManager: defaultContextBudgetManager, cacheDiagnostics: diagnostics,
      canWrite: () => authority, getIdleCacheProfile: () => null, idleProjection: identitySummaryProjection,
      getSystemPrompt: () => 'system\nhistory_read' })
    service.setHistoryProjection(projection)
    const file = join(directory, 'sessions', session.id, 'messages.jsonl')
    return { session, context, service, diagnostics, original: readFileSync(file), file, expire: () => { authority = false } }
  }
  it('原档案不变，重启的 system 与完整尾部相等', async () => {
    const f = fixture()
    expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(true)
    const ledger = store.loadContextSnapshot(f.session.id)!
    expect(ledger).toEqual(f.context.compactionState)
    expect(ledger.revision).toBe(1)
    expect(ledger.state?.validation).toBe('verified')
    expect(ledger.state?.handoff?.facts.map(fact => fact.value)).toContain('必须保留金额单位 CNY。')
    expect(readFileSync(f.file)).toEqual(f.original)
    const restored = restoreFromLedger(store.load(f.session.id)!, ledger, f.context.systemPrompt)
    expect(restored.kind).toBe('restored')
    expect(restored.messages).toEqual(f.context.messages)
    f.service.dispose()
  })

  it('多轮记忆检索沿原有预算压缩，提交和重载保持档案与调用配对', async () => {
    const control = fixture()
    const memory = fixture({}, false, false, true)
    const controlTokens = estimateContextTokens(control.context.messages)
    const memoryTokens = estimateContextTokens(memory.context.messages)
    expect(memoryTokens).toBeGreaterThan(controlTokens)
    expect(memory.context.messages.filter(message => message.role === 'tool')).toHaveLength(24)
    for (const f of [control, memory]) {
      expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(true)
      expect(estimateContextTokens(f.context.messages)).toBeLessThan(4000)
      const reopened = new SessionStore(directory)
      const ledger = reopened.loadContextSnapshot(f.session.id)!
      expect(ledger.state?.validation).toBe('verified')
      const restored = restoreFromLedger(reopened.load(f.session.id)!, ledger, f.context.systemPrompt)
      expect(restored.kind).toBe('restored')
      expect(restored.messages).toEqual(f.context.messages)
      for (const message of restored.messages.filter(message => message.role === 'tool')) {
        expect(restored.messages.some(candidate => candidate.toolCalls?.some(call => call.id === message.toolCallId))).toBe(true)
      }
      expect(readFileSync(f.file)).toEqual(f.original)
      f.service.dispose()
    }
  })
  it('原子写入失败不发布新状态或纪元', async () => {
    const f = fixture()
    const original = f.context.messages
    vi.spyOn(atomicFile, 'atomicWriteFileSync').mockImplementation(() => { throw new Error('disk full') })
    expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(false)
    expect(f.context.messages).toBe(original)
    expect(f.context.compactionState).toBeNull()
    expect(store.loadContextSnapshot(f.session.id)).toBeNull()
    expect(f.diagnostics.getEpochReason()).toBe('session_init')
    expect(readFileSync(f.file)).toEqual(f.original)
    f.service.dispose()
  })
  it('未落盘的 assistant 尾部不能获得提交回执', async () => {
    const f = fixture()
    f.context.messages.push({ role: 'assistant', content: '未提交', origin: { messageId: 'inflight', step: 0 } })
    const original = structuredClone(f.context.messages)
    expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(false)
    expect(f.context.messages).toEqual(original)
    expect(store.loadContextSnapshot(f.session.id)).toBeNull()
    f.service.dispose()
  })
  it('最终投影等待时 generation 失效，旧候选不能提交', async () => {
    const f = fixture()
    let calls = 0
    const projection = { project: async (messages: typeof f.context.messages) => {
      if (++calls === 4) f.expire()
      return messages
    } }
    expect(await f.service.runThresholdCompaction(projection)).toBe(false)
    expect(store.loadContextSnapshot(f.session.id)).toBeNull()
    expect(f.context.compactionState).toBeNull()
    f.service.dispose()
  })
  it('磁盘提交后取消仍完成内存发布，重启读取相同 revision', async () => {
    const f = fixture()
    const controller = new AbortController()
    const save = store.saveContextSnapshot.bind(store)
    vi.spyOn(store, 'saveContextSnapshot').mockImplementation((id, ledger) => { save(id, ledger); controller.abort() })
    expect(await f.service.runThresholdCompaction(identitySummaryProjection, controller.signal)).toBe(true)
    expect(f.context.compactionState).toEqual(new SessionStore(directory).loadContextSnapshot(f.session.id))
    expect(f.diagnostics.getEpochReason()).toBe('compaction')
    f.service.dispose()
  })
  it('写盘后发布前退出，重启从已提交 revision 恢复完整尾部', async () => {
    const f = fixture()
    const original = structuredClone(f.context.messages)
    const save = store.saveContextSnapshot.bind(store)
    vi.spyOn(store, 'saveContextSnapshot').mockImplementation((id, ledger) => { save(id, ledger); throw new Error('process exited') })
    expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(false)
    expect(f.context.messages).toEqual(original)
    const ledger = new SessionStore(directory).loadContextSnapshot(f.session.id)!
    expect(ledger.revision).toBe(1)
    const restored = restoreFromLedger(store.load(f.session.id)!, ledger, 'system\nhistory_read')
    expect(restored.kind).toBe('restored')
    const tailIndex = original.findIndex(message => message.origin?.messageId === ledger.tailFrom?.messageId && message.origin?.step === ledger.tailFrom?.step)
    expect(restored.messages.slice(-original.slice(tailIndex).length)).toEqual(original.slice(tailIndex))
    expect(readFileSync(f.file)).toEqual(f.original)
    f.service.dispose()
  })
  it('同 revision 的第二份候选无法覆盖已提交快照', async () => {
    const f = fixture()
    const original = structuredClone(f.context.messages)
    expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(true)
    const ledger = store.loadContextSnapshot(f.session.id)!
    expect(store.commitCompaction(f.session.id, { ...ledger, updatedAt: ledger.updatedAt + 1 }, 0, original)).toBe(false)
    expect(store.loadContextSnapshot(f.session.id)).toEqual(ledger)
    f.service.dispose()
  })
  it.each(['none', 'tool-call-history', 'all-history'] as const)('%s 恢复投影的 thinking 历史可提交，原始正文改动仍拒绝', async reasoningReplay => {
    const projection = { reasoningReplay, currentProviderId: 'fixture' }
    const f = fixture(projection, false, true)
    const original = structuredClone(f.context.messages)
    expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(true)
    const ledger = store.loadContextSnapshot(f.session.id)!
    expect(restoreFromLedger(store.load(f.session.id)!, ledger, f.context.systemPrompt, projection).messages).toEqual(f.context.messages)
    original.at(-1)!.content = '未持久化改动'
    expect(store.commitCompaction(f.session.id, { ...ledger, revision: 2 }, 1, original, projection)).toBe(false)
    f.service.dispose()
  })
  it('图文中的必需事实与解析后的图片尾部可完整提交恢复', async () => {
    const projection = { resolveImageUrl: () => 'data:image/png;base64,fixture' }
    const f = fixture(projection, true)
    expect(await f.service.runThresholdCompaction(identitySummaryProjection)).toBe(true)
    const ledger = store.loadContextSnapshot(f.session.id)!
    expect(ledger.state?.handoff?.facts.map(fact => fact.quote)).toContain('必须保留金额单位 CNY。')
    expect(restoreFromLedger(store.load(f.session.id)!, ledger, f.context.systemPrompt, projection).messages).toEqual(f.context.messages)
    expect(readFileSync(f.file)).toEqual(f.original)
    f.service.dispose()
  })
})
