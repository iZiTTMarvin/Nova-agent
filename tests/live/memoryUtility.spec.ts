import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { AgentLoop, EventBus } from '../../src/runtime/agent'
import { agentRoute } from '../../src/runtime/agent/turn'
import { OpenAICompatibleModelClient } from '../../src/runtime/model/OpenAICompatibleModelClient'
import type { ModelClient, ChatOptions } from '../../src/runtime/model/ModelClient'
import type { ChatMessage, ChatEvent, ToolDefinition, ModelClientConfig } from '../../src/runtime/model/types'
import { ToolRegistry } from '../../src/runtime/tools/ToolRegistry'
import { readTool } from '../../src/runtime/tools/readTool'
import { lsTool } from '../../src/runtime/tools/lsTool'
import { writeTool } from '../../src/runtime/tools/writeTool'
import { createMemorySearchTool } from '../../src/runtime/tools/memorySearch'
import { PermissionManager } from '../../src/runtime/permissions/PermissionManager'
import { DEFAULT_NOVA_SETTINGS } from '../../src/runtime/settings/novaSettings'
import { openBetterSqliteMemoryDb } from '../../src/runtime/memory/BetterSqliteMemoryDb'
import { SqliteMemoryRepository } from '../../src/runtime/memory/repository/SqliteMemoryRepository'
import { StructuredMemoryRetriever } from '../../src/runtime/memory/retrieval/StructuredMemoryRetriever'
import { DocumentMemoryRetriever } from '../../src/runtime/memory/retrieval/DocumentMemoryRetriever'
import { MemoryRetrievalService } from '../../src/runtime/memory/retrieval/MemoryRetrievalService'
import { MemoryPrefetchService } from './fixtures/memory/MemoryPrefetchService'
import { createMemoryPrefetchWiring } from './fixtures/memory/MemoryPrefetchWiring'
import { MEMORY_POLICY_PROMPT } from '../../src/runtime/memory/memoryConfig'
import { computeWorkspaceHash } from '../../src/runtime/memory/MemoryPaths'
import { buildStableSystemPrompt } from '../../src/runtime/agent/promptBuilder/modePrompt'
import { MemoryExtractor, projectExtractionMessages } from '../../src/runtime/memory/extraction/MemoryExtractor'
import { MemoryCandidateProcessor } from '../../src/runtime/memory/policy/MemoryCandidateProcessor'
import type { NormalizedUsage } from '../../src/shared/model/types'

const apiKey = process.env.MEMORY_AB_API_KEY
const outputDir = process.env.MEMORY_AB_OUTPUT_DIR ?? '.local/memory-review/live'
const cases = [
  { name: 'invoice', topic: '账单导出', key: 'encoding', value: 'utf8-bom' },
  { name: 'queue', topic: '队列重试', key: 'retrySchedule', value: 'fibonacci-jitter' },
  { name: 'audit', topic: '审计日志', key: 'partition', value: 'tenant-day-v2' },
  { name: 'upload', topic: '上传校验', key: 'checksum', value: 'blake3-256' },
  { name: 'search', topic: '搜索索引', key: 'tokenizer', value: 'trigram-casefold' },
  { name: 'export', topic: '数据导出', key: 'timeZone', value: 'Asia/Taipei' }
].slice(0, Number(process.env.MEMORY_AB_CASES ?? '6'))

interface RequestRecord { turn: number; messages: ChatMessage[]; usage?: NormalizedUsage }
class Recorder implements ModelClient {
  readonly requests: RequestRecord[] = []
  turn = 0
  constructor(readonly config: ModelClientConfig, private readonly inner = new OpenAICompatibleModelClient(config)) {}
  updateConfig(config: ModelClientConfig): void { this.inner.updateConfig(config) }
  measureRequest(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions) {
    return this.inner.measureRequest(messages, tools, options)
  }
  async *chat(messages: ChatMessage[], tools?: ToolDefinition[], options?: ChatOptions): AsyncIterable<ChatEvent> {
    const record: RequestRecord = { turn: this.turn, messages: structuredClone(messages) }
    this.requests.push(record)
    for await (const event of this.inner.chat(messages, tools, options)) {
      if (event.type === 'usage') record.usage = event.usage
      yield event
    }
  }
}

// 每个结果按实际文件判定，模型未被要求输出评分关键词；三臂使用同一任务和工具实现。
describe.skipIf(!apiKey)('真实记忆任务闭环', () => {
  for (const [caseIndex, task] of cases.entries()) {
    it(task.name, async () => {
      const root = mkdtempSync(join(tmpdir(), 'nova-memory-utility-'))
      const db = openBetterSqliteMemoryDb(join(root, 'memory.db'))
      const repository = new SqliteMemoryRepository(db)
      const retrieval = new MemoryRetrievalService({
        structuredRetriever: new StructuredMemoryRetriever(repository),
        documentRetriever: new DocumentMemoryRetriever(null)
      })
      const rows: unknown[] = []
      try {
        const arms = caseIndex % 2 ? ['tool', 'off', 'ephemeral'] as const : ['off', 'ephemeral', 'tool'] as const
        const selectedArms = arms.filter(arm => !process.env.MEMORY_AB_ARMS || process.env.MEMORY_AB_ARMS.split(',').includes(arm))
        expect(selectedArms.length).toBeGreaterThan(0)
        for (const arm of selectedArms) {
          const workspace = join(root, arm)
          const specPath = 'docs/decisions/current-service-contract.md'
          mkdirSync(join(workspace, 'docs/decisions'), { recursive: true })
          const rememberedOnly = caseIndex >= 3 || process.env.MEMORY_AB_EXTRACT_SEEDS === '1'
          writeFileSync(join(workspace, 'README.md'), rememberedOnly
            ? '运行配置为 service.json；此项目遵循用户此前确认的个人约定，仓库不记录个人偏好。'
            : '项目约定见 docs/index.md。运行配置为 service.json。')
          writeFileSync(join(workspace, 'docs/index.md'), '当前服务约定见 decisions/current-service-contract.md。其他旧文档只供历史参考。')
          writeFileSync(join(workspace, specPath), rememberedOnly
            ? '个人约定由用户确认；请勿猜测未指定的选择。'
            : `${task.topic}当前生效约定：service.json 的 ${task.key} 必须是 ${JSON.stringify(task.value)}。保留其他字段。`)
          writeFileSync(join(workspace, 'service.json'), JSON.stringify({ service: task.name, [task.key]: 'legacy', enabled: true }))
          const scopeId = computeWorkspaceHash(workspace)
          const memoryContent = rememberedOnly ? `用户已明确确认本项目的${task.topic}约定：service.json 的 ${task.key}=${task.value}。`
            : `${task.topic}约定：service.json 的 ${task.key}=${task.value}；当前规范在 ${specPath}，直接读取该文件核对，无需重新遍历文档。`
          let learning: { candidates: unknown; result: unknown } | null = null
          if (process.env.MEMORY_AB_EXTRACT_SEEDS === '1' && arm !== 'off') {
            const extractorClient = new OpenAICompatibleModelClient({ apiKey: apiKey!,
              baseUrl: process.env.MEMORY_AB_BASE_URL ?? 'https://api.commandcode.ai/provider/v1',
              modelId: process.env.MEMORY_AB_MODEL ?? 'deepseek/deepseek-v4-flash', reasoningEffort: 'max' })
            const extractor = new MemoryExtractor({ chat: async (messages) => {
              let text = ''
              // 真实评测按用户指定的 max 运行；产品提炼强度不在这里修改。
              for await (const event of extractorClient.chat(messages)) {
                if (event.type === 'text_delta') text += event.delta
                if (event.type === 'error') throw new Error(event.error)
              }
              return text
            } })
            const learningSession = randomUUID()
            const candidates = await extractor.extract({ sessionId: learningSession, observations: [],
              recentMessages: [{ role: 'user', content: `请记住我的长期约定：${memoryContent}` }] })
            expect(candidates).not.toBeNull()
            const result = new MemoryCandidateProcessor({ repository }).process({ sessionId: learningSession,
              projectScopeId: scopeId, candidates: candidates ?? [] })
            expect(result.added).toBeGreaterThan(0)
            const reopened = openBetterSqliteMemoryDb(join(root, 'memory.db'))
            try {
              const persisted = new SqliteMemoryRepository(reopened).listByScope({ scopeKind: 'project', scopeId })
              expect(persisted.some(record => record.status === 'active' && record.content.includes(task.value))).toBe(true)
            } finally { reopened.close() }
            learning = { candidates, result }
          } else repository.insertRecord({ id: randomUUID(), scope: { scopeKind: 'project', scopeId }, kind: 'convention',
            memoryKey: `service.${task.name}`, status: 'active', explicitness: 'user_explicit', confidence: 1,
            content: memoryContent, sourceType: 'user_message' })
          repository.insertRecord({ id: randomUUID(), scope: { scopeKind: 'project', scopeId }, kind: 'preference',
            memoryKey: 'unrelated', status: 'active', explicitness: 'observed', confidence: 0.8,
            content: '暗色主题颜色通过 design tokens 设置。', sourceType: 'user_message' })
          const config: ModelClientConfig = { apiKey: apiKey!, baseUrl: process.env.MEMORY_AB_BASE_URL ?? 'https://api.commandcode.ai/provider/v1',
            modelId: process.env.MEMORY_AB_MODEL ?? 'deepseek/deepseek-v4-flash', reasoningEffort: 'max', supportsVision: false, contextWindow: 128_000 }
          const wireRequests: { model: unknown; reasoningEffort: unknown; messages: unknown }[] = []
          config.fetchImpl = async (url, init) => {
            const body: unknown = JSON.parse(init.body ?? '{}')
            if (typeof body === 'object' && body !== null) wireRequests.push({
              model: 'model' in body ? body.model : null,
              reasoningEffort: 'reasoning_effort' in body ? body.reasoning_effort : null,
              messages: 'messages' in body ? body.messages : null
            })
            return fetch(url, init)
          }
          const client = new Recorder(config)
          const bus = new EventBus()
          const calls: { turn: number; name: string; args: unknown }[] = []
          bus.on(event => { if (event.type === 'tool_call') calls.push({ turn: client.turn, name: event.toolName, args: event.args }) })
          const registry = new ToolRegistry()
          for (const tool of [readTool, lsTool, writeTool]) registry.register(tool)
          if (arm !== 'off') registry.register(createMemorySearchTool({ getMemoryRetrievalService: () => retrieval,
            loadSettings: () => ({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }) }))
          const loop = new AgentLoop(client, bus, { permissionManager: new PermissionManager(), permissionMode: 'full_access',
            systemPrompt: `${buildStableSystemPrompt({ workingDir: workspace })}\n${MEMORY_POLICY_PROMPT}`,
            contextWindow: 128_000, maxToolRounds: 12, promptCacheKey: randomUUID() })
          loop.setToolRegistry(registry)
          loop.setWorkingDir(workspace)
          loop.setWorkspaceRoot(workspace)
          loop.setSessionId(randomUUID())
          const historyLines = Number(process.env.MEMORY_AB_HISTORY_LINES ?? '0')
          if (historyLines > 0) loop.injectHistory([
            { role: 'user', content: Array.from({ length: historyLines }, (_, i) =>
              `Archived check ${i}: module health was verified; this completed check does not define current service configuration.`).join('\n') },
            { role: 'assistant', content: '历史检查已完成，接下来按当前任务工作。' }
          ])
          if (arm === 'ephemeral') {
            const wiring = createMemoryPrefetchWiring({ prefetch: new MemoryPrefetchService(retrieval), projectScopeId: scopeId,
              workspaceRoot: workspace, workingState: { peekRecent: () => [] }, timeoutMs: 1000 })
            loop.getHookManager().on('onMessageStart', wiring.onMessageStart)
            loop.getHookManager().on('context', wiring.context)
          }
          try {
            const first = await loop.sendMessage(`请按这个项目现行的${task.topic}约定修正 service.json，保留其他字段。完成实际修改并核对结果。`, agentRoute())
            client.turn = 1
            const second = await loop.sendMessage('再确认一下刚才的配置是否正确。直接复用已确认的约定，不需要重新探索项目。', agentRoute())
            const actual: unknown = JSON.parse(readFileSync(join(workspace, 'service.json'), 'utf8'))
            const expected = { service: task.name, [task.key]: task.value, enabled: true }
            const passed = typeof actual === 'object' && actual !== null && !Array.isArray(actual)
              && Object.keys(actual).length === Object.keys(expected).length
              && Object.entries(expected).every(([key, value]) => Object.entries(actual).some(
                ([actualKey, actualValue]) => actualKey === key && actualValue === value))
            const prefixBreaks = client.requests.slice(1).flatMap((request, i) => {
              const previous = client.requests[i].messages
              return JSON.stringify(request.messages.slice(0, previous.length)) === JSON.stringify(previous) ? [] : [i + 1]
            })
            const row = { case: task.name, rememberedOnly, learning, arm, passed, first: first.status, second: second.status, calls,
              firstError: first.status === 'failed' ? first.error.message : null,
              secondError: second.status === 'failed' ? second.error.message : null,
              prefixBreaks, wireRequests, requests: client.requests, extractionContainsMemory: projectExtractionMessages(loop.getContext()).some(
                message => message.role === 'tool' && typeof message.content === 'string' && message.content.includes('无需重新遍历文档')) }
            rows.push(row)
            mkdirSync(outputDir, { recursive: true })
            writeFileSync(join(outputDir, `${task.name}.json`), JSON.stringify(rows, null, 2))
            console.info(JSON.stringify({ case: task.name, arm, passed, tools: calls.length, searches: calls.filter(call => call.name === 'memory_search').length,
              prefixBreaks, usage: client.requests.map(request => ({ turn: request.turn, usage: request.usage })) }))
            expect(first.status).not.toBe('failed')
            expect(second.status).not.toBe('failed')
            if (arm !== 'off' || !rememberedOnly) expect(actual).toEqual(expected)
            if (arm === 'tool') {
              expect(prefixBreaks).toEqual([])
              expect(row.extractionContainsMemory).toBe(false)
            }
          } finally { loop.dispose() }
        }
      } finally { db.close() }
    }, 900_000)
  }
})
