/**
 * MemoryExtractHost 单测：新候选管线接线、提炼失败降级、MEMORY.md 不再被自动追加。
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
  drainAndPersistSync: vi.fn()
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

describe('MemoryExtractHost 候选管线', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    loadNovaSettingsMock.mockReturnValue({ memoryEnabled: true })
    extractMock.mockReset()
  })

  it('持久化记忆查询先展平过滤再截窗，保留真实用户证据', async () => {
    extractMock.mockResolvedValue([])
    const messages: SessionMessage[] = [{ id: 'user', timestamp: 0, role: 'user', content: '以后导出必须使用 UTF8 BOM' }]
    for (let i = 0; i < 55; i++) messages.push({ id: `memory${i}`, timestamp: i + 1, role: 'assistant', content: '',
      blocks: [{ type: 'tool', toolCallId: `call${i}`, toolName: 'memory_search', arguments: { query: '导出' }, status: 'success', result: '旧记忆正文' }] })
    const { runMemoryExtract } = await loadHost()
    await runMemoryExtract('s1', '/tmp/ws', fakeSessionStore(messages), {} as never)
    expect(extractMock.mock.calls[0][0].recentMessages).toEqual([
      expect.objectContaining({ role: 'user', content: '以后导出必须使用 UTF8 BOM' })
    ])
  })

  it('提炼成功：候选交给 processor 落库，episodic 走零 LLM 观测格式化', async () => {
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

  it('提炼失败：只跳过结构化落库，episodic 降级路径不变', async () => {
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
