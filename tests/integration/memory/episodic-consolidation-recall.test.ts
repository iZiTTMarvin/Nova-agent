/**
 * P2-3 闭环集成：采集 → consolidate → append episodic → FTS 召回
 *
 * 使用真实 better-sqlite3（Node ABI），验证 append→reindex→search 主链路。
 */
import { describe, it, expect, afterEach } from 'vitest'
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
  consolidateObservations,
  EPISODIC_SUMMARY_REL_PATH
} from '@runtime/memory/MemoryConsolidator'

/** episodic 块内可检索的独特标记（中文 trigram） */
const EPISODIC_MARKER = '北极星验收短语'

describe('episodic 巩固闭环集成（P2-3）', () => {
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
    tempDir = mkdtempSync(join(tmpdir(), 'nova-episodic-e2e-'))
    const workspace = join(tempDir, 'ws')
    mkdirSync(workspace, { recursive: true })
    const memoryRoot = getMemoryRoot(tempDir)
    mkdirSync(memoryRoot, { recursive: true })
    const scopeId = computeWorkspaceHash(workspace)
    const db = openBetterSqliteMemoryDb(join(memoryRoot, 'memory.db'))
    service = new MemoryService(memoryRoot, db, { reconcileOnSearch: false })
    return { scopeId, memoryRoot }
  }

  it('采集 → drain → consolidate → append → search 召回 episodic', () => {
    const { scopeId, memoryRoot } = setup()
    const sessionId = 'sess-integration-1'

    const capture = new ObservationCapture()
    capture.onToolCall({
      sessionId,
      messageId: 'msg-1',
      toolCallId: 'tc-1',
      toolName: 'edit',
      args: { path: 'src/config.ts', old_string: 'a', new_string: 'b' }
    })
    capture.onToolResult({
      sessionId,
      messageId: 'msg-1',
      toolCallId: 'tc-1',
      toolName: 'edit',
      result: `${EPISODIC_MARKER}\n第二行说明\n第三行`
    })

    const snapshot = capture.drainWorkingBuffer(sessionId)
    expect(snapshot).toHaveLength(1)
    expect(snapshot[0].facts[0]).toContain(EPISODIC_MARKER)

    const markdown = consolidateObservations(snapshot)
    expect(markdown).toContain(sessionId)
    service!.appendEpisodicSummary(scopeId, markdown)

    const episodicPath = join(
      getProjectMemoryDir(memoryRoot, scopeId),
      ...EPISODIC_SUMMARY_REL_PATH.split('/')
    )
    expect(existsSync(episodicPath)).toBe(true)
    const diskBody = readFileSync(episodicPath, 'utf8')
    expect(diskBody).toContain(EPISODIC_MARKER)
    expect(diskBody).not.toContain('MEMORY.md')

    const memoryMdPath = join(getProjectMemoryDir(memoryRoot, scopeId), 'MEMORY.md')
    expect(existsSync(memoryMdPath)).toBe(false)

    const hits = service!.search(scopeId, EPISODIC_MARKER)
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some((h) => h.relPath === EPISODIC_SUMMARY_REL_PATH)).toBe(true)
    expect(hits[0].body).toContain(EPISODIC_MARKER)
  })

  it('二次 append 累积且均可检索', () => {
    const { scopeId } = setup()
    const capture = new ObservationCapture()

    const runOnce = (sessionId: string, marker: string, toolCallId: string) => {
      capture.onToolCall({
        sessionId,
        messageId: 'm',
        toolCallId,
        toolName: 'read',
        args: { path: 'notes.md' }
      })
      capture.onToolResult({
        sessionId,
        messageId: 'm',
        toolCallId,
        toolName: 'read',
        result: marker
      })
      const obs = capture.drainWorkingBuffer(sessionId)
      service!.appendEpisodicSummary(scopeId, consolidateObservations(obs))
    }

    runOnce('s-a', '第一次巩固标记', 'tc-a')
    runOnce('s-b', '第二次巩固标记', 'tc-b')

    const hitsA = service!.search(scopeId, '第一次巩固')
    const hitsB = service!.search(scopeId, '第二次巩固')
    expect(hitsA.some((h) => h.relPath === EPISODIC_SUMMARY_REL_PATH)).toBe(true)
    expect(hitsB.some((h) => h.relPath === EPISODIC_SUMMARY_REL_PATH)).toBe(true)
  })
})
