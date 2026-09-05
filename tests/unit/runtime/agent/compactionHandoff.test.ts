import { describe, expect, it } from 'vitest'
import { collectRequiredFacts, validateHandoff } from '../../../../src/runtime/agent/compaction/handoffValidation'
import { CompactionService } from '../../../../src/runtime/agent/compaction/CompactionService'
import { createAgentContext } from '../../../../src/runtime/agent/core/AgentContext'
import { defaultContextBudgetManager } from '../../../../src/runtime/agent/ContextBudgetManager'
import { CacheDiagnostics } from '../../../../src/runtime/model/cacheDiagnostics'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { identitySummaryProjection } from '../../../../src/test-support/builders/identitySummaryProjection'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import type { ChatMessage } from '../../../../src/runtime/model/types'
import type { HandoffFact } from '../../../../src/runtime/sessions'

const source: ChatMessage = { role: 'user', content: '实现账单导出。\n必须保留金额单位 CNY。', origin: { messageId: 'u1', step: 0 } }
const fact: HandoffFact = { id: 'currency', category: 'constraint', owner: 'u1', value: '必须保留金额单位 CNY。',
  quote: '必须保留金额单位 CNY。', origin: { messageId: 'u1', step: 0 }, required: true }
const document = { schemaVersion: 1, goal: '账单导出', nextActions: '实现导出', keyContext: '金额格式', progress: '待实现', decisions: '保留单位', facts: [fact] }

describe('交接事实校验', () => {
  it('必需集合来自用户任务、显式约束及已验证事实，ID 随来源稳定', () => {
    const inherited = { ...fact, id: 'inherited', origin: { messageId: 'old', step: 0 }, owner: 'old' }
    const facts = collectRequiredFacts([source, { role: 'assistant', content: '必须删除单位' }], [inherited])
    expect(facts.map(value => value.value)).toEqual([inherited.value, '实现账单导出。', fact.value])
    expect(collectRequiredFacts([source], [inherited])).toEqual(facts)
    expect(facts.slice(1).every(value => value.owner === 'u1' && value.origin.messageId === 'u1')).toBe(true)
  })

  it.each([
    ['五标题齐但没有事实', '## 目标\n导出\n## 下一步\n实现\n## 关键上下文\n单位\n## 进展\n待办\n## 关键决策\n保留'],
    ['漏事实', JSON.stringify({ ...document, facts: [] })],
    ['错归属', JSON.stringify({ ...document, facts: [{ ...fact, owner: 'u2' }] })],
    ['伪来源', JSON.stringify({ ...document, facts: [{ ...fact, origin: { messageId: 'u2', step: 0 } }] })],
    ['伪造引用', JSON.stringify({ ...document, facts: [fact, { ...fact, id: 'fake', quote: '验证通过', value: '验证通过', required: false }] })],
    ['空目标', JSON.stringify({ ...document, goal: ' ' })],
    ['截断 JSON', JSON.stringify(document).slice(0, -1)]
  ])('%s 必须拒绝', (_name, text) => {
    expect(validateHandoff(text, [source], [fact], [])).toBeNull()
  })

  it('保留原句、来源及归属的完整候选通过', () => {
    expect(validateHandoff(JSON.stringify(document), [source], [fact], [])).toEqual(document)
  })

  it('只有 reasoning 的 state 不替换旧上下文', async () => {
    const context = createAgentContext({ readState: createReadState(), systemPrompt: 'system', messages: [
      { role: 'system', content: 'system' }, source,
      ...Array.from({ length: 30 }, (_, i): ChatMessage => ({ role: 'assistant', content: 'x'.repeat(1000), origin: { messageId: `a${i}`, step: 0 } }))
    ] })
    const original = context.messages
    const client = new MockModelClient().addCompactionPair({ events: [{ type: 'thinking_delta', delta: JSON.stringify(document) }, { type: 'message_end', finishReason: 'stop' }] })
    const service = new CompactionService({ context, modelClient: client, contextWindow: 1000,
      contextBudgetManager: defaultContextBudgetManager, cacheDiagnostics: new CacheDiagnostics(),
      getIdleCacheProfile: () => null, idleProjection: identitySummaryProjection })
    expect(await service.runThresholdCompaction(identitySummaryProjection)).toBe(false)
    expect(context.messages).toBe(original)
    expect(context.compactionState).toBeNull()
    service.dispose()
  })
})
