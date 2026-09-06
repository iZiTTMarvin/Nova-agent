import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionStore, buildConversationContext } from '../../src/runtime/sessions'
import { restoreFromLedger } from '../../src/runtime/sessions/contextSnapshot'
import { resetSessionIndexHostForTests } from '../../src/runtime/sessions/SessionIndexHost'
import { CompactionService } from '../../src/runtime/agent/compaction/CompactionService'
import { createAgentContext } from '../../src/runtime/agent/core/AgentContext'
import { defaultContextBudgetManager } from '../../src/runtime/agent/ContextBudgetManager'
import { estimateContextTokens } from '../../src/runtime/agent/tokenEstimator'
import { createReadState } from '../../src/runtime/tools/editTool'
import { formatMemorySearchResults } from '../../src/runtime/tools/memorySearch'
import { CacheDiagnostics } from '../../src/runtime/model/cacheDiagnostics'
import { OpenAICompatibleModelClient } from '../../src/runtime/model/OpenAICompatibleModelClient'
import type { ModelClient } from '../../src/runtime/model/ModelClient'
import type { ChatMessage, ChatEvent } from '../../src/runtime/model/types'
import { identitySummaryProjection } from '../../src/test-support/builders/identitySummaryProjection'

const apiKey = process.env.MEMORY_AB_API_KEY

describe.skipIf(!apiKey)('真实模型记忆上下文压缩', () => {
  it('普通工具历史增加后仍可提交压缩并从磁盘恢复', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-memory-compaction-'))
    const store = new SessionStore(root)
    const rows: unknown[] = []
    try {
      for (const memory of [false, true]) {
        const session = store.create(root, 'default')
        for (let i = 0; i < 24; i++) {
          store.appendMessage(session.id, { id: `u${i}`, role: 'user', timestamp: i * 2,
            content: i === 0 ? '实现账单导出。\n必须保留金额单位 CNY。' : `继续核对模块 ${i}` })
          store.appendMessage(session.id, { id: `a${i}`, role: 'assistant', timestamp: i * 2 + 1,
            content: '模块检查完成，没有修改金额单位。'.repeat(60),
            ...(memory ? { blocks: [{ type: 'tool' as const, toolCallId: `m${i}`, toolName: 'memory_search',
              arguments: { query: '导出' }, status: 'success' as const, result: formatMemorySearchResults([{
                id: 'export', group: 'document', kind: 'document', relPath: 'export.md',
                body: '历史导出使用 UTF8 BOM，核对当前实现后再沿用。', advisory: false, historicalNote: null
              }], '导出') }, { type: 'text' as const, content: '模块检查完成，没有修改金额单位。'.repeat(60) }] } : {}) })
        }
        const archivePath = join(root, 'sessions', session.id, 'messages.jsonl')
        const archive = readFileSync(archivePath)
        const context = createAgentContext({ readState: createReadState(), systemPrompt: '遵循用户要求继续编程任务。',
          messages: [{ role: 'system', content: '遵循用户要求继续编程任务。' }, ...buildConversationContext(store.load(session.id)!, 'default')],
          sessionStore: store, sessionId: session.id })
        const client = new OpenAICompatibleModelClient({ apiKey: apiKey!,
          baseUrl: process.env.MEMORY_AB_BASE_URL ?? 'https://api.commandcode.ai/provider/v1',
          modelId: process.env.MEMORY_AB_MODEL ?? 'deepseek/deepseek-v4-flash', reasoningEffort: 'max', contextWindow: 128_000 })
        const events: ChatEvent[] = []
        const recording: ModelClient = { updateConfig: config => client.updateConfig(config),
          async *chat(messages, tools, options) {
            for await (const event of client.chat(messages, tools, options)) {
              if (event.type === 'usage' || event.type === 'error' || event.type === 'context_overflow') events.push(event)
              yield event
            }
          } }
        // 缩小本地阈值以强制覆盖压缩，供应商模型窗口仍使用原始配置。
        const service = new CompactionService({ context, modelClient: recording, contextWindow: 4000,
          contextBudgetManager: defaultContextBudgetManager, cacheDiagnostics: new CacheDiagnostics(),
          canWrite: () => true, getIdleCacheProfile: () => null, idleProjection: identitySummaryProjection,
          getSystemPrompt: () => '遵循用户要求继续编程任务。\nhistory_read' })
        const beforeTokens = estimateContextTokens(context.messages)
        try {
          const adopted = await service.runThresholdCompaction(identitySummaryProjection)
          const reopened = new SessionStore(root)
          const ledger = reopened.loadContextSnapshot(session.id)
          const restored = ledger ? restoreFromLedger(reopened.load(session.id)!, ledger, context.systemPrompt) : null
          rows.push({ memory, adopted, beforeTokens, afterTokens: estimateContextTokens(context.messages),
            ledger, restored: restored?.kind, events })
          const output = process.env.MEMORY_AB_OUTPUT_DIR ?? '.local/memory-review/compaction-live'
          mkdirSync(output, { recursive: true })
          writeFileSync(join(output, 'compaction.json'), JSON.stringify(rows, null, 2))
          expect(adopted).toBe(true)
          expect(ledger?.state?.validation).toBe('verified')
          expect(restored?.messages).toEqual(context.messages)
          expect(estimateContextTokens(context.messages)).toBeLessThan(4000)
          expect(readFileSync(archivePath)).toEqual(archive)
          const messages: ChatMessage[] = restored?.messages ?? []
          for (const tool of messages.filter(message => message.role === 'tool')) {
            expect(messages.some(message => message.toolCalls?.some(call => call.id === tool.toolCallId))).toBe(true)
          }
        } finally { service.dispose() }
      }
    } finally { resetSessionIndexHostForTests() }
  }, 300_000)
})
