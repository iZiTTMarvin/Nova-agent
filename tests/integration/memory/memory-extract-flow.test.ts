/**
 * memory-extract-flow 集成：提炼 → episodic 落盘 → memory_search 召回
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
import { MemoryExtractor } from '@runtime/memory/MemoryExtractor'
import { consolidateExtracted } from '@runtime/memory/MemoryConsolidator'
import { formatMemorySearchResults } from '@runtime/tools/memorySearch'

const EXTRACT_MARKER = '北极星提炼验收短语'

describe('memory-extract-flow 集成', () => {
  let tempDir: string | null = null
  let service: MemoryService | null = null

  afterEach(() => {
    service?.close()
    service = null
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  function setup(): { scopeId: string; memoryRoot: string } {
    tempDir = mkdtempSync(join(tmpdir(), 'nova-extract-e2e-'))
    const workspace = join(tempDir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const memoryRoot = getMemoryRoot(tempDir)
    mkdirSync(memoryRoot, { recursive: true })
    const scopeId = computeWorkspaceHash(workspace)
    const db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    return { scopeId, memoryRoot }
  }

  it('提炼 → episodic 落盘 → search 可召回', async () => {
    const { scopeId, memoryRoot } = setup()
    const sessionId = 'sess-extract-1'

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
      result: 'ok'
    })

    const extractor = new MemoryExtractor({
      chat: vi.fn().mockResolvedValue(
        JSON.stringify([
          {
            userNeed: EXTRACT_MARKER,
            approach: '改配置',
            outcome: '成功完成',
            whatFailed: '',
            whatWorked: '改 tsconfig',
            tags: ['config']
          }
        ])
      )
    })

    const observations = capture.drainForExtract(sessionId)
    const extracted = await extractor.extract({
      recentMessages: [{ role: 'user', content: '优化构建' }],
      observations
    })
    expect(extracted).not.toBeNull()

    const { episodicMarkdown } = consolidateExtracted(extracted!, sessionId)
    service!.appendEpisodicSummary(scopeId, episodicMarkdown)

    const episodicPath = join(
      getProjectMemoryDir(memoryRoot, scopeId),
      'episodic/summary.md'
    )
    expect(existsSync(episodicPath)).toBe(true)
    expect(readFileSync(episodicPath, 'utf8')).toContain(EXTRACT_MARKER)

    const hits = service!.search(scopeId, EXTRACT_MARKER, { limit: 5, scoreFloor: 0.01 })
    expect(hits.length).toBeGreaterThan(0)
    const formatted = formatMemorySearchResults(hits, EXTRACT_MARKER)
    expect(formatted).toContain(EXTRACT_MARKER)
  })
})
