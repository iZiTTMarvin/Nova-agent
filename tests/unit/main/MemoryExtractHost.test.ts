/**
 * MemoryExtractHost 单测：显式候选提炼接线，以及正常生命周期保持零 LLM 落盘。
 * 提炼器与仓储均 mock（宿主编排是测试对象），行为级断言见集成测试。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatMessage } from '../../../src/runtime/model/types'
import type { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import type { SessionMessage } from '../../../src/runtime/sessions'

const extractMock = vi.fn()
const processMock = vi.fn()
const appendEpisodicMock = vi.fn()
const drainWorkingBufferMock = vi.fn()
const drainAndPersistSyncMock = vi.fn()
const drainAndSchedulePersistMock = vi.fn()
const loadNovaSettingsMock = vi.fn()

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nova-test-userdata' }
}))

vi.mock('../../../src/runtime/settings/novaSettings', () => ({
  loadNovaSettings: () => loadNovaSettingsMock()
}))

vi.mock('../../../src/runtime/model/config', () => ({
  loadModelConfig: vi.fn(() => ({ apiKey: '', baseUrl: '', model: '' }))
}))

vi.mock('../../../src/runtime/memory/ObservationCapture', () => ({
  getObservationCaptureForSession: () => ({
    drainForExtract: () => [
      {
        id: 'obs_1',
        sessionId: 's1',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'edit',
        title: 'edit src/a.ts',
        facts: ['ok'],
        filesTouched: ['src/a.ts'],
        fingerprint: 'fp',
        capturedAt: Date.now(),
        hadSensitive: false
      }
    ],
    drainWorkingBuffer: drainWorkingBufferMock
  })
}))

vi.mock('../../../src/main/services/MemoryServiceHost', () => ({
  getMemoryService: () => ({
    appendEpisodicSummary: appendEpisodicMock,
  }),
  getMemoryCandidateProcessor: () => ({ process: processMock })
}))

vi.mock('../../../src/main/services/MemoryConsolidationHost', () => ({
  drainAndPersistSync: drainAndPersistSyncMock,
  drainAndSchedulePersist: drainAndSchedulePersistMock
}))

vi.mock('../../../src/runtime/memory/extraction/MemoryExtractor', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/runtime/memory/extraction/MemoryExtractor')>()
  return {
    ...actual,
    MemoryExtractor: vi.fn().mockImplementation(() => ({ extract: extractMock }))
  }
})

async function loadHost() {
  return await import('../../../src/main/services/MemoryExtractHost')
}

function fakeSessionStore(messages: Array<ChatMessage | SessionMessage>): SessionStore {
  return { load: () => ({ mode: 'default', messages: messages.map((message, i) => ({ id: `m${i}`, timestamp: i, ...message })) }) } as unknown as SessionStore
}

describe('MemoryExtractHost', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    loadNovaSettingsMock.mockReturnValue({ memoryEnabled: true })
    extractMock.mockReset()
    const { resetExtractTurnCountersForTests } = await loadHost()
    resetExtractTurnCountersForTests()
  })

  it('正常 turn cadence 只调度零 LLM episodic 落盘，不启动 extractor', async () => {
    const { onUserTurnCompleteForExtract } = await loadHost()
    const store = fakeSessionStore([{ role: 'user', content: '优化构建' }])

    for (let i = 0; i < 5; i++) {
      onUserTurnCompleteForExtract('s1', '/tmp/ws', store, {} as never)
    }

    expect(drainAndSchedulePersistMock).toHaveBeenCalledTimes(1)
    expect(drainAndSchedulePersistMock).toHaveBeenCalledWith('s1', '/tmp/ws')
    expect(extractMock).not.toHaveBeenCalled()
  })

  it('会话退出只同步固化 observation，不启动 extractor', async () => {
    const { extractOnSessionLeave } = await loadHost()
    const store = fakeSessionStore([{ role: 'user', content: '优化构建' }])

    extractOnSessionLeave('s1', '/tmp/ws', store)

    expect(drainAndPersistSyncMock).toHaveBeenCalledTimes(1)
    expect(drainAndPersistSyncMock).toHaveBeenCalledWith('s1', '/tmp/ws')
    expect(extractMock).not.toHaveBeenCalled()
  })

  it('持久化记忆查询先展平过滤再截窗，保留真实用户证据', async () => {
    extractMock.mockResolvedValue([])
    const messages: SessionMessage[] = [{ id: 'user', timestamp: 0, role: 'user', content: '以后导出必须使用 UTF8 BOM' } as SessionMessage]
    for (let i = 0; i < 55; i++) messages.push({ id: `memory${i}`, timestamp: i + 1, role: 'assistant', content: '',
      blocks: [{ type: 'tool', toolCallId: `call${i}`, toolName: 'memory_search', arguments: { query: '导出' }, status: 'success', result: '旧记忆正文' }] } as SessionMessage)
    const { runMemoryExtract } = await loadHost()
    await runMemoryExtract('s1', '/tmp/ws', fakeSessionStore(messages), {} as never)
    expect(extractMock.mock.calls[0][0].recentMessages).toEqual([
      expect.objectContaining({ role: 'user', content: '以后导出必须使用 UTF8 BOM' })
    ])
  })

  it('显式提炼成功：候选交给 processor 落库，episodic 走零 LLM 观测格式化', async () => {
    extractMock.mockResolvedValue([
      {
        kind: 'workflow',
        scopeHint: 'project',
        memoryKey: 'build.verify',
        content: '修改原生模块依赖后需要重建',
        explicitness: 'workspace_verified',
        confidence: 0.9,
        intent: 'assert',
        evidence: [{ type: 'tool_result', excerpt: '需要 electron-rebuild' }]
      }
    ])
    processMock.mockReturnValue({ candidates: 1, added: 1, merged: 0, promoted: 0, superseded: 0, retracted: 0, ignored: 0, failed: 0 })

    const { runMemoryExtract } = await loadHost()
    await runMemoryExtract('s1', '/tmp/ws', fakeSessionStore([
      { role: 'user', content: '优化构建' }
    ]), {} as never)

    expect(extractMock).toHaveBeenCalledTimes(1)
    expect(processMock).toHaveBeenCalledTimes(1)
    expect(processMock.mock.calls[0][0]).toMatchObject({
      sessionId: 's1',
      projectScopeId: expect.stringMatching(/^[0-9a-f]{16}$/)
    })
    expect(processMock.mock.calls[0][0].candidates).toHaveLength(1)
    expect(appendEpisodicMock).toHaveBeenCalledTimes(1)
    expect(appendEpisodicMock.mock.calls[0][1]).toContain('edit src/a.ts')
    expect(drainWorkingBufferMock).toHaveBeenCalledWith('s1')
  })

  it('显式提炼失败：只跳过结构化落库，episodic 降级路径不变', async () => {
    extractMock.mockResolvedValue(null)

    const { runMemoryExtract } = await loadHost()
    await runMemoryExtract('s1', '/tmp/ws', fakeSessionStore([
      { role: 'user', content: '优化构建' }
    ]), {} as never)

    expect(processMock).not.toHaveBeenCalled()
    expect(appendEpisodicMock).toHaveBeenCalledTimes(1)
    expect(appendEpisodicMock.mock.calls[0][1]).toContain('edit src/a.ts')
  })

  it('候选落库异常不阻塞 episodic 落盘', async () => {
    extractMock.mockResolvedValue([
      {
        kind: 'workflow',
        scopeHint: 'project',
        memoryKey: null,
        content: 'x',
        explicitness: 'observed',
        confidence: 0.5,
        intent: 'assert',
        evidence: [{ type: 'tool_result', excerpt: 'ok' }]
      }
    ])
    processMock.mockImplementation(() => {
      throw new Error('db unavailable')
    })

    const { runMemoryExtract } = await loadHost()
    await runMemoryExtract('s1', '/tmp/ws', fakeSessionStore([
      { role: 'user', content: '优化构建' }
    ]), {} as never)

    expect(appendEpisodicMock).toHaveBeenCalledTimes(1)
  })
})
