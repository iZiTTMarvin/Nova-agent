/**
 * memory-extract-flow 集成：采集 → 候选提炼 → policy 落库 → episodic 零 LLM 落盘 → 检索召回。
 * 另覆盖自我污染防护：动态注入块与助手复述都不得强化既有记忆。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { openBetterSqliteMemoryDb } from '@runtime/memory/BetterSqliteMemoryDb'
import {
  getMemoryRoot,
  computeWorkspaceHash,
  getProjectMemoryDir
} from '@runtime/memory/MemoryPaths'
import { MemoryService } from '@runtime/memory/MemoryService'
import { ObservationCapture } from '@runtime/memory/ObservationCapture'
import {
  MemoryExtractor,
  projectExtractionMessages
} from '@runtime/memory/extraction/MemoryExtractor'
import { consolidateObservations } from '@runtime/memory/MemoryConsolidator'
import { SqliteMemoryRepository } from '@runtime/memory/repository/SqliteMemoryRepository'
import { MemoryCandidateProcessor } from '@runtime/memory/policy/MemoryCandidateProcessor'
import { formatMemorySearchResults } from '@runtime/tools/memorySearch'
import type { MemorySearchResult } from '@runtime/memory/retrieval/MemoryRetriever'
import type { ChatMessage } from '@runtime/model/types'

const EPISODIC_MARKER = '北极星提炼验收短语'
const TOOL_FACT = 'package.json 变更后必须运行 electron-rebuild 重建原生模块'

describe('memory-extract-flow 集成', () => {
  let tempDir: string | null = null
  let service: MemoryService | null = null
  let repo: SqliteMemoryRepository | null = null

  afterEach(() => {
    service?.close()
    service = null
    repo = null
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  function setup(): { scopeId: string; memoryRoot: string; processor: MemoryCandidateProcessor } {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-extract-e2e-'))
    const workspace = join(tempDir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const memoryRoot = getMemoryRoot(tempDir)
    mkdirSync(memoryRoot, { recursive: true })
    const scopeId = computeWorkspaceHash(workspace)
    const db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    repo = new SqliteMemoryRepository(db)
    const processor = new MemoryCandidateProcessor({ repository: repo })
    return { scopeId, memoryRoot, processor }
  }

  function captureObservation(sessionId: string): ObservationCapture {
    const capture = new ObservationCapture()
    capture.onToolCall({
      sessionId,
      messageId: 'msg-1',
      toolCallId: 'tc-1',
      toolName: 'edit',
      args: { path: 'src/a.ts', old_string: 'a', new_string: 'b' }
    })
    capture.onToolResult({
      sessionId,
      messageId: 'msg-1',
      toolCallId: 'tc-1',
      toolName: 'edit',
      result: `${TOOL_FACT}\n${EPISODIC_MARKER}\n第三行`
    })
    return capture
  }

  it('提炼候选 → 结构化落库 + episodic 零 LLM 落盘，两路均可召回', async () => {
    const { scopeId, memoryRoot, processor } = setup()
    const sessionId = 'sess-extract-1'
    const capture = captureObservation(sessionId)
    const observations = capture.drainForExtract(sessionId)

    const extractor = new MemoryExtractor({
      chat: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            kind: 'workflow',
            scopeHint: 'project',
            key: 'build.verify',
            content: 'package.json 变更后必须重建原生模块',
            explicitness: 'workspace_verified',
            confidence: 0.9,
            intent: 'assert',
            evidence: [{ type: 'tool_result', excerpt: TOOL_FACT }]
          }
        ])
      )
    })

    const recentMessages: ChatMessage[] = [{ role: 'user', content: '优化构建流程' }]
    const candidates = await extractor.extract({ sessionId, recentMessages, observations })
    expect(candidates).toHaveLength(1)

    const counts = processor.process({
      sessionId,
      projectScopeId: scopeId,
      candidates: candidates!
    })
    expect(counts).toMatchObject({ candidates: 1, added: 1 })

    const record = repo!.findActiveByKey(
      { scopeKind: 'project', scopeId },
      'workflow',
      'build.verify'
    )
    expect(record).toMatchObject({
      status: 'active',
      explicitness: 'workspace_verified',
      sourceType: 'tool_result'
    })
    expect(repo!.listEvidence(record!.id)).toHaveLength(1)
    expect(repo!.listEvidence(record!.id)[0]).toMatchObject({
      sessionId,
      projectScopeId: scopeId,
      excerpt: TOOL_FACT
    })

    // episodic 历史照写（零 LLM 观测格式化），MEMORY.md 不再被自动追加
    service!.appendEpisodicSummary(scopeId, consolidateObservations(observations))
    const episodicPath = join(getProjectMemoryDir(memoryRoot, scopeId), 'episodic/summary.md')
    expect(existsSync(episodicPath)).toBe(true)
    expect(readFileSync(episodicPath, 'utf8')).toContain(EPISODIC_MARKER)
    expect(existsSync(join(getProjectMemoryDir(memoryRoot, scopeId), 'MEMORY.md'))).toBe(false)

    const hits = service!.search(scopeId, EPISODIC_MARKER, { limit: 5, scoreFloor: 0.01 })
    expect(hits.length).toBeGreaterThan(0)
    const documentResults: MemorySearchResult[] = hits.map((hit) => ({
      id: hit.relPath,
      group: 'document',
      kind: 'document',
      relPath: hit.relPath,
      body: hit.body,
      advisory: false,
      historicalNote: null
    }))
    expect(formatMemorySearchResults(documentResults, EPISODIC_MARKER)).toContain(EPISODIC_MARKER)

    const structured = repo!.searchFts('原生模块')
    expect(structured.map((h) => h.record.id)).toEqual([record!.id])
  })

  it('自我污染防护：注入块与助手复述不得强化既有记忆', async () => {
    const { scopeId, processor } = setup()
    const sessionId = 'sess-extract-2'

    const before = processor.process({
      sessionId,
      projectScopeId: scopeId,
      candidates: [
        {
          kind: 'preference',
          scopeHint: 'global',
          memoryKey: 'stack.ui',
          content: '用户经常使用 React',
          explicitness: 'observed',
          confidence: 0.6,
          intent: 'assert',
          evidence: [{ type: 'tool_result', excerpt: 'package.json 依赖 react' }]
        }
      ]
    })
    expect(before).toMatchObject({ added: 1 })
    const existing = repo!.listByScope({ scopeKind: 'global', scopeId: 'user' })[0]

    // 助手在回复中复述记忆；动态注入块以 skipCacheMarker 临时消息形态进入会话
    const pollutedMessages: ChatMessage[] = [
      { role: 'user', content: '帮我看下这个项目的依赖' },
      { role: 'assistant', content: '你经常用 React 和 TypeScript，这个项目也是 React 技术栈' },
      {
        role: 'user',
        content: '=== Relevant Memory ===\n- [preference] 用户经常使用 React',
        skipCacheMarker: true
      }
    ]

    // 输入投影层：注入块被剔除，提炼输入不含该内容
    const projected = projectExtractionMessages(pollutedMessages)
    expect(projected).toHaveLength(2)
    expect(projected.some((m) => m.content.includes('Relevant Memory'))).toBe(false)

    // 模型即便照着注入块/助手复述产出候选，证据也无法通过同角色逐字溯源
    const extractor = new MemoryExtractor({
      chat: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            kind: 'preference',
            scopeHint: 'global',
            key: 'stack.ui',
            content: '用户经常使用 React',
            explicitness: 'observed',
            confidence: 0.9,
            intent: 'assert',
            evidence: [{ type: 'user_message', excerpt: '用户经常使用 React' }]
          }
        ])
      )
    })
    const candidates = await extractor.extract({
      sessionId,
      recentMessages: pollutedMessages,
      observations: []
    })
    expect(candidates).toHaveLength(0)

    const counts = processor.process({
      sessionId,
      projectScopeId: scopeId,
      candidates: candidates ?? []
    })
    expect(counts).toMatchObject({ candidates: 0 })

    const after = repo!.findById(existing.id)
    expect(after?.evidenceCount).toBe(1)
    expect(after?.confidence).toBe(0.6)
    expect(repo!.listByScope({ scopeKind: 'global', scopeId: 'user' })).toHaveLength(1)
  })
})
