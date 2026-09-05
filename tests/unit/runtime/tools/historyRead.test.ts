import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { persistCompactionSnapshot } from '../../../../src/runtime/sessions/contextSnapshot'
import { makeCompactionLedger } from '../../../../src/test-support/builders/compactionLedger'
import { historyReadTool } from '../../../../src/runtime/tools/historyRead'
import { archiveReadTool } from '../../../../src/runtime/tools/archiveRead'
import { ArtifactStore } from '../../../../src/runtime/artifacts/ArtifactStore'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { ACTIVE_TOOL_RESULT_MAX_TOKENS } from '../../../../src/runtime/request-projection'
import { CHARS_PER_TOKEN } from '../../../../src/runtime/agent/tokenEstimator'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import { createAgentContext, getEffectiveToolDefinitions } from '../../../../src/runtime/agent/core/AgentContext'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'

describe('history_read', () => {
  let tmpDir: string
  let store: SessionStore
  let artifacts: ArtifactStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'history-read-'))
    store = new SessionStore(tmpDir)
    artifacts = new ArtifactStore(tmpDir)
  })

  afterEach(() => {
    resetSessionIndexHostForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function toolContext(sessionId: string): ToolContext {
    return {
      workingDir: tmpDir,
      readState: createReadState(),
      sessionStore: store,
      sessionId,
      artifactStore: artifacts
    }
  }

  it('能读到只存在于被取代 state 覆盖区间的原文', async () => {
    const session = store.create(tmpDir)
    store.appendMessage(session.id, {
      id: 'u-secret',
      role: 'user',
      content: 'SECRET_FOLDED_TASK',
      timestamp: 1
    })
    store.appendMessage(session.id, {
      id: 'a-secret',
      role: 'assistant',
      content: 'folded assistant',
      timestamp: 2
    })
    store.appendMessage(session.id, {
      id: 'u-tail',
      role: 'user',
      content: 'tail only',
      timestamp: 3
    })
    persistCompactionSnapshot(
      store,
      session.id,
      makeCompactionLedger({
        summary: 'new state without secret',
        entries: [
          {
            id: 'c1',
            shadows: {
              from: { messageId: 'u-secret', step: 0 },
              to: { messageId: 'a-secret', step: 0 }
            },
            stub: 'folded',
            touchedFiles: { paths: [], omittedCount: 0 },
            trigger: 'threshold',
            createdAt: 1
          }
        ],
        tailFrom: { messageId: 'u-tail', step: 0 }
      })
    )

    const search = await historyReadTool.execute(
      { operation: 'search', query: 'SECRET_FOLDED_TASK' },
      toolContext(session.id)
    )
    expect(search.success).toBe(true)
    const parsed = JSON.parse(search.output) as { matched: number; scanned: number }
    expect(parsed.scanned).toBeGreaterThan(0)
    expect(parsed.matched).toBeGreaterThan(0)

    const unknown = await historyReadTool.execute(
      { operation: 'read', checkpoint: 'c99' },
      toolContext(session.id)
    )
    expect(unknown.success).toBe(false)
    expect(unknown.error).toBe('unknown_checkpoint')
    expect(JSON.parse(unknown.output).code).toBe('unknown_checkpoint')
  })

  it('大工具结果走占位符，archive_read 可读全文', async () => {
    const session = store.create(tmpDir)
    const hugeLines = Array.from({ length: 80 }, (_, i) =>
      i === 9 ? 'UNIQUE_FULL_BODY' : 'z'.repeat(120)
    )
    const huge = hugeLines.join('\n')
    store.appendMessage(session.id, {
      id: 'u1',
      role: 'user',
      content: 'read it',
      timestamp: 1
    })
    store.appendMessage(session.id, {
      id: 'a1',
      role: 'assistant',
      content: '',
      timestamp: 2,
      toolCalls: [{ id: 'call-big', name: 'read', arguments: '{}', result: huge }]
    })
    persistCompactionSnapshot(
      store,
      session.id,
      makeCompactionLedger({
        summary: 'state',
        entries: [
          {
            id: 'c1',
            shadows: {
              from: { messageId: 'u1', step: 0 },
              to: { messageId: 'a1', step: 0 }
            },
            stub: 'folded',
            touchedFiles: { paths: [], omittedCount: 0 },
            trigger: 'threshold',
            createdAt: 1
          }
        ]
      })
    )

    const read = await historyReadTool.execute(
      { operation: 'read', checkpoint: 'c1' },
      toolContext(session.id)
    )
    expect(read.success).toBe(true)
    expect(read.output).not.toContain('UNIQUE_FULL_BODY')
    const payload = JSON.parse(read.output) as { lines: string[] }
    const toolLine = payload.lines.find(line => line.includes('resourceRef'))
    expect(toolLine).toBeTruthy()
    const placeholder = JSON.parse(toolLine!.slice(toolLine!.indexOf('{'))) as { resourceRef: string }
    expect(placeholder.resourceRef).toMatch(/^artifact:\/\//)
    const archived = await archiveReadTool.execute(
      { ref: placeholder.resourceRef, operation: 'read', offset: 1, limit: 20 },
      toolContext(session.id)
    )
    expect(archived.success).toBe(true)
    expect(archived.output).toContain('UNIQUE_FULL_BODY')
  })

  it('账本为空时有效工具列表不含 history_read', () => {
    const registry = new ToolRegistry()
    registry.register(historyReadTool)
    const ctx = createAgentContext({
      readState: createReadState(),
      toolRegistry: registry,
      compactionState: null
    })
    expect(getEffectiveToolDefinitions(ctx).map(def => def.name)).not.toContain('history_read')

    ctx.compactionState = makeCompactionLedger({ entryCount: 1 })
    expect(getEffectiveToolDefinitions(ctx).map(def => def.name)).toContain('history_read')
  })
})
