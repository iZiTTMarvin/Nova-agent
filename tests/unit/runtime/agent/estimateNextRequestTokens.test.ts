import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import { createAgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { defaultContextBudgetManager, ContextBudgetManager, estimateContextSize, resolveProductionBudgetLimits } from '../../../../src/runtime/agent/ContextBudgetManager'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { OpenAICompatibleModelClient } from '../../../../src/runtime/model/OpenAICompatibleModelClient'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { RequestBudgetMeasurement } from '../../../../src/runtime/model/requestBudget'

const roots: string[] = []
afterEach(() => { resetSessionIndexHostForTests(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })) })
const source = (r: RequestBudgetMeasurement) => ({ routeId: r.routeId, purpose: 'main' as const, logicalRequestId: 'logical', physicalAttemptId: 'physical' })
const config = { baseUrl: 'https://a.test/v1', apiKey: 'fixture', modelId: 'deepseek-v4-flash', contextWindow: 500_000 }
const messages: ChatMessage[] = [{ role: 'system', content: 'system' }, { role: 'user', content: '原文🙂' }]
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nova-budget-')); roots.push(root)
  const store = new SessionStore(root), session = store.create(root)
  const pool = new ModelClientPool({ primary: new OpenAICompatibleModelClient(config), primaryConfig: config,
    fallbacks: [{ config: { ...config, baseUrl: 'https://b.test/v1' }, client: new OpenAICompatibleModelClient({ ...config, baseUrl: 'https://b.test/v1' }) }] })
  let current = true
  const context = createAgentContext({ readState: createReadState(), messages: structuredClone(messages), sessionStore: store, sessionId: session.id })
  const make = () => new CompactionService({ context, modelClient: new MockModelClient(), contextBudgetManager: defaultContextBudgetManager,
    cacheDiagnostics: new CacheDiagnostics(), contextWindow: 500_000, measureRequest: pool.measureRequest.bind(pool), canWrite: () => current,
    getIdleCacheProfile: () => null, idleProjection: identitySummaryProjection })
  return { store, session, root, pool, context, service: make(), make, invalidate: () => { current = false } }
}

describe('同路由最终投影预算', () => {
  it.each([399_999, 400_000, 400_001])('500K 窗口的正常等号边界 %i', tokens => {
    const { service, pool } = setup(), request = pool.measureRequest(messages)
    expect(service.observeMainRequest(tokens, request, source(request))).toBe(true)
    expect(service.assessNextRequest(request)).toMatchObject({ status: tokens >= 400_000 ? 'compact' : 'within', estimatedTokens: tokens, threshold: 400_000, source: 'provider', marginTokens: 0 })
  })
  it('同一快照跨实例恢复锚点，纯追加计入增量与余量', () => {
    const { service, pool, store, session, make, context } = setup(), request = pool.measureRequest(messages)
    expect(service.observeMainRequest(390_000, request, source(request))).toBe(true)
    const persisted = store.loadContextSnapshot(session.id)!
    expect(persisted.entries).toEqual([])
    context.compactionState = null
    const restored = make(); restored.restoreBudget(persisted)
    const next = pool.measureRequest([...messages, { role: 'assistant', content: '后缀'.repeat(100) }])
    const result = restored.assessNextRequest(next)
    expect(result.source).toBe('anchored-estimate')
    expect(result.estimatedTokens).toBe(390_000 + next.serializedBytes - request.serializedBytes + result.marginTokens)
    expect(restored.assessNextRequest(request).estimatedTokens).toBe(390_000)
  })
  it('旧 route、旧 generation、摘要和旧 revision 不能覆盖 main 锚点', () => {
    const { service, pool, store, session, context, invalidate } = setup(), request = pool.measureRequest(messages)
    expect(service.observeMainRequest(390_000, request, source(request))).toBe(true)
    const saved = store.loadContextSnapshot(session.id)!
    expect(service.observeMainRequest(1, request, { ...source(request), purpose: 'compaction-state' })).toBe(false)
    pool.switchToFallback(1)
    expect(service.observeMainRequest(1, request, source(request))).toBe(false)
    expect(service.assessNextRequest(pool.measureRequest(messages)).source).toBe('conservative-estimate')
    pool.resetToPrimary(); context.compactionState = null
    expect(service.observeMainRequest(1, request, source(request))).toBe(false)
    context.compactionState = saved; invalidate()
    expect(service.observeMainRequest(1, request, source(request))).toBe(false)
    expect(store.loadContextSnapshot(session.id)).toEqual(saved)
  })
  it('旧正文替换和工具信封变化使锚点失效，未知超大 reasoning 被阻止', async () => {
    const { service, pool, context } = setup(), request = pool.measureRequest(messages)
    service.observeMainRequest(390_000, request, source(request))
    expect(service.assessNextRequest(pool.measureRequest([{ ...messages[0], content: '另一份 system' }, messages[1]])).source).toBe('conservative-estimate')
    expect(service.assessNextRequest(pool.measureRequest(messages, [{ name: 'read', description: 'read', parameters: { type: 'object', properties: {} } }])).source).toBe('conservative-estimate')
    const huge: ChatMessage[] = [{ role: 'assistant', content: 'tiny', reasoningContent: '中'.repeat(200_000), toolCalls: [{ id: 'a', name: 'read', arguments: '{}' }] }, { role: 'tool', toolCallId: 'a', content: 'ok' }]
    const measured = pool.measureRequest(huge)
    expect(measured.serializedBytes).toBeGreaterThan(600_000)
    expect(service.assessNextRequest(measured).status).toBe('blocked')
    const before = structuredClone(context.messages)
    await expect(service.prepareMainRequest(huge, undefined, identitySummaryProjection)).rejects.toMatchObject({ attemptedCompaction: false })
    expect(context.messages).toEqual(before)
  })
  it('400K 压缩失败保持现场且拒绝下一主请求', async () => {
    const { service, pool, context } = setup(), request = pool.measureRequest(messages)
    service.observeMainRequest(400_000, request, source(request))
    const before = structuredClone(context.messages)
    await expect(service.prepareMainRequest(messages, undefined, identitySummaryProjection)).rejects.toMatchObject({ attemptedCompaction: true })
    expect(context.messages).toEqual(before)
  })
  it('未知快照版本不被锚点写入覆盖', () => {
    const { root, session, store, service, pool } = setup()
    const path = join(root, 'sessions', session.id, 'context-snapshot.json'), bytes = JSON.stringify({ version: 99, note: 'keep' })
    writeFileSync(path, bytes)
    const request = pool.measureRequest(messages)
    expect(store.loadContextSnapshot(session.id)).toBeNull()
    expect(service.observeMainRequest(100, request, source(request))).toBe(false)
    expect(readFileSync(path, 'utf8')).toBe(bytes)
  })
  it('纯硬限制仍保留自定义字节和单次输出预留语义', () => {
    const { tokens, bytes } = estimateContextSize(messages)
    expect(new ContextBudgetManager({ maxSerializedBytes: bytes }).enforceInline(messages).status).toBe('within_budget')
    expect(new ContextBudgetManager({ maxSerializedBytes: bytes - 1 }).enforceInline(messages).status).toBe('requires_compaction')
    expect(new ContextBudgetManager({ maxEstimatedTokens: tokens, reservedOutputTokens: 1 }).enforceInline(messages).status).toBe('requires_compaction')
    expect(resolveProductionBudgetLimits({ contextWindow: 500_000 }).highWaterTokens).toBe(491_808)
  })
})
