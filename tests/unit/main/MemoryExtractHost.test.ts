import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import type { SessionData } from '../../../src/runtime/sessions/types'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'
import { MemoryExtractScheduler } from '../../../src/main/services/MemoryExtractScheduler'
import { MEMORY_EXTRACT_IDLE_DELAY_MS } from '../../../src/runtime/memory/memoryConfig'

let profile: string
let activeStore: SessionStore
const settings = vi.fn(), extract = vi.fn(), process = vi.fn(), episodic = vi.fn()
vi.mock('electron', () => ({ app: { getPath: () => profile } }))
vi.mock('../../../src/runtime/settings/novaSettings', async original => ({ ...await original<typeof import('../../../src/runtime/settings/novaSettings')>(), loadNovaSettings: () => settings() }))
vi.mock('../../../src/runtime/memory/extraction/MemoryExtractor', async original => ({ ...await original<typeof import('../../../src/runtime/memory/extraction/MemoryExtractor')>(), MemoryExtractor: vi.fn().mockImplementation(() => ({ extract })) }))
vi.mock('../../../src/main/services/MemoryServiceHost', () => ({
  getMemoryService: () => ({ registerWorkspace: () => '0123456789abcdef' }),
  getMemoryRepository: () => ({ listByScope: () => [] }),
  getMemoryCandidateProcessor: () => ({ process })
}))
vi.mock('../../../src/main/services/MemoryConsolidationHost', () => ({ drainAndPersistSync: (...args: unknown[]) => episodic(...args), drainAndSchedulePersist: (...args: unknown[]) => episodic(...args) }))
vi.mock('../../../src/main/services/MemorySessionExclusion', () => ({ isMemoryExcludedSession: () => false, isMemoryExcludedMode: (mode: string) => mode === 'learn' }))
vi.mock('../../../src/main/services/SessionStoreHost', () => ({ getSessionStore: () => activeStore }))
vi.mock('../../../src/main/services/MemoryMaintenanceHost', () => ({ organizeMemoryAfterExtract: vi.fn() }))
vi.mock('../../../src/main/agent/state/AgentExecutionStateHost', () => ({ isSessionTurnInProgress: () => false }))

function fixture(text = '以后所有项目的提交信息都必须使用中文并且保留原因'): { session: SessionData; store: SessionStore } {
  const session: SessionData = { schemaVersion: 22, kind: 'primary', id: 's1', mode: 'default', permissionMode: 'auto', workspaceRoot: '/workspace', codeIndexEnabled: false, createdAt: 1, updatedAt: 1,
    messages: [{ id: 'u1', parentId: null, role: 'user', content: text, timestamp: 1 }], currentLeafId: 'u1' }
  const store = { load: () => session, loadMetadata: () => session, list: () => [session] } as unknown as SessionStore
  return { session, store }
}

beforeEach(async () => {
  vi.clearAllMocks(); profile = mkdtempSync(join(tmpdir(), 'nova-extract-host-'))
  settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true })
  activeStore = fixture().store
  extract.mockResolvedValue([])
  process.mockReturnValue({ candidates: 1, added: 1, merged: 0, promoted: 0, superseded: 0, retracted: 0, ignored: 0, failed: 0 })
  const host = await import('../../../src/main/services/MemoryExtractHost'); host.resetExtractTurnCountersForTests()
})
afterEach(async () => {
  const host = await import('../../../src/main/services/MemoryExtractHost'); host.resetExtractTurnCountersForTests()
  vi.useRealTimers(); rmSync(profile, { recursive: true, force: true })
})

describe('MemoryExtractHost', () => {
  it('默认关闭，显式入口、完成五轮与离开仍不调用模型；episodic 保留', async () => {
    const host = await import('../../../src/main/services/MemoryExtractHost')
    const { store } = fixture()
    await host.runMemoryExtract('s1', '/workspace', store)
    for (let i = 0; i < 5; i++) host.onUserTurnCompleteForExtract('s1', '/workspace')
    host.extractOnSessionLeave('s1', '/workspace')
    expect(extract).not.toHaveBeenCalled(); expect(episodic).toHaveBeenCalledTimes(2)
  })

  it('开启后持久推进游标；第二次不重复；输入先排除记忆结果再截窗', async () => {
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true, memoryAutoExtractEnabled: true })
    const { session, store } = fixture()
    let parent = 'u1'
    for (let i = 0; i < 55; i++) { const id = `memory${i}`; session.messages.push({ id, parentId: parent, timestamp: i + 2, role: 'assistant', content: '', blocks: [{ type: 'tool', toolCallId: `call${i}`, toolName: 'memory_read', arguments: { file: 'project/conventions.md' }, status: 'success', result: '旧记忆正文' }] }); parent = id }
    session.currentLeafId = parent
    const host = await import('../../../src/main/services/MemoryExtractHost')
    await host.runMemoryExtract('s1', '/workspace', store)
    expect(extract.mock.calls[0][0].recentMessages).toEqual([expect.objectContaining({ role: 'user', content: session.messages[0].content })])
    expect(JSON.parse(readFileSync(join(profile, 'memory/extract-state.json'), 'utf8')).sessions.s1).toMatchObject({ lastMessageId: 'memory54', attempts: 0, lastError: null })
    await host.runMemoryExtract('s1', '/workspace', store)
    expect(extract).toHaveBeenCalledTimes(1)
  })

  it('按去空白字符数跳过短输入仍推进；learn 和 opt-out 不调用模型', async () => {
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true, memoryAutoExtractEnabled: true })
    const { session, store } = fixture('中 文 短 句')
    const host = await import('../../../src/main/services/MemoryExtractHost')
    await host.runMemoryExtract('s1', '/workspace', store)
    expect(extract).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(profile, 'memory/extract-state.json'), 'utf8')).sessions.s1.lastMessageId).toBe('u1')
    host.resetExtractTurnCountersForTests(); session.mode = 'learn'
    await host.runMemoryExtract('s1', '/workspace', store); expect(extract).not.toHaveBeenCalled()
    session.mode = 'default'; session.memoryOptOut = true
    await host.runMemoryExtract('s1', '/workspace', store); expect(extract).not.toHaveBeenCalled()
  })

  it('关闭开关或 opt-out 发生在模型响应期间时禁止落库', async () => {
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true, memoryAutoExtractEnabled: true })
    const { session, store } = fixture()
    extract.mockImplementation(async () => { session.memoryOptOut = true; return [{ kind: 'preference', content: '保持中文' }] })
    const host = await import('../../../src/main/services/MemoryExtractHost')
    await host.runMemoryExtract('s1', '/workspace', store)
    expect(process).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(join(profile, 'memory/extract-state.json'), 'utf8')).sessions.s1.lastMessageId).toBe('u1')
  })

  it('关闭期间推进到当前末尾，重新开启只处理之后的对话', async () => {
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true, memoryAutoExtractEnabled: true })
    const { session, store } = fixture()
    activeStore = store
    session.memoryOptOut = true
    const host = await import('../../../src/main/services/MemoryExtractHost')
    host.onUserTurnCompleteForExtract('s1', '/workspace')
    expect(extract).not.toHaveBeenCalled()
    expect(episodic).not.toHaveBeenCalled()
    session.memoryOptOut = false
    session.messages.push({ id: 'u2', parentId: 'u1', role: 'user', content: '以后所有项目的自动发布前都必须保留完整变更日志', timestamp: 2 })
    session.currentLeafId = 'u2'
    await host.runMemoryExtract('s1', '/workspace', store)
    expect(extract.mock.calls[0][0].recentMessages).toEqual([expect.objectContaining({ content: session.messages[1].content })])
  })

  it('游标所在消息离开 active path 时从新分支重取，模型空数组也推进', async () => {
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true, memoryAutoExtractEnabled: true })
    const { session, store } = fixture()
    const host = await import('../../../src/main/services/MemoryExtractHost')
    await host.runMemoryExtract('s1', '/workspace', store)
    session.messages = [{ id: 'branch', parentId: null, role: 'user', content: '以后所有项目的发布前都必须核对最新变更日志并且检查构建结果', timestamp: 2 }]
    session.currentLeafId = 'branch'
    await host.runMemoryExtract('s1', '/workspace', store)
    expect(extract).toHaveBeenCalledTimes(2)
    expect(extract.mock.calls[1][0].recentMessages).toEqual([expect.objectContaining({ content: session.messages[0].content })])
    expect(JSON.parse(readFileSync(join(profile, 'memory/extract-state.json'), 'utf8')).sessions.s1.lastMessageId).toBe('branch')
  })

  it('启动补跑仅取最近合格会话，最多五个，默认关闭时不调用模型', async () => {
    vi.useFakeTimers()
    const host = await import('../../../src/main/services/MemoryExtractHost')
    host.initializeMemoryExtractHost(); await vi.advanceTimersByTimeAsync(60_001)
    expect(extract).not.toHaveBeenCalled()
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true, memoryAutoExtractEnabled: true })
    const sessions = Array.from({ length: 7 }, (_, index) => ({ ...fixture().session, id: `s${index}`, updatedAt: Date.now() - index }))
    const excluded = [{ ...fixture().session, id: 'learn', mode: 'learn', updatedAt: Date.now() }, { ...fixture().session, id: 'private', memoryOptOut: true, updatedAt: Date.now() }, { ...fixture().session, id: 'old', updatedAt: Date.now() - 8 * 86_400_000 }]
    const all = [...sessions, ...excluded]
    activeStore = { load: (id: string) => all.find(session => session.id === id), loadMetadata: (id: string) => all.find(session => session.id === id), list: () => all } as unknown as SessionStore
    host.initializeMemoryExtractHost(); await vi.advanceTimersByTimeAsync(60_100)
    expect(extract.mock.calls.map(call => call[0].sessionId)).toEqual(['s0', 's1', 's2', 's3', 's4'])
  })
})

describe('persistent extraction queue', () => {
  it('重复排队合并，跨会话全局单飞，新 turn 重置空闲计时', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const execute = vi.fn(async (id: string) => { if (id === 's1') await new Promise<void>(resolve => { release = resolve }); return { lastMessageId: 'u1' } })
    const queue = new MemoryExtractScheduler({ memoryRoot: join(profile, 'memory'), enabled: () => true, exists: () => true, execute })
    queue.enqueue('s1', '/ws'); queue.enqueue('s1', '/ws'); queue.enqueue('s2', '/ws')
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACT_IDLE_DELAY_MS - 1)
    queue.onTurnStarted('s1')
    await vi.advanceTimersByTimeAsync(1)
    expect(execute.mock.calls.map(call => call[0])).toEqual(['s2'])
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACT_IDLE_DELAY_MS)
    expect(execute.mock.calls.map(call => call[0])).toEqual(['s2', 's1'])
    queue.enqueue('s3', '/ws', 0); await vi.advanceTimersByTimeAsync(0)
    expect(execute).toHaveBeenCalledTimes(2)
    release(); await vi.advanceTimersByTimeAsync(1)
    expect(execute.mock.calls.map(call => call[0])).toEqual(['s2', 's1', 's3'])
    queue.dispose()
  })

  it('失败三次后推进，成功游标重启恢复；删除中断不能复活游标', async () => {
    vi.useFakeTimers()
    const root = join(profile, 'memory'), execute = vi.fn(async () => ({ lastMessageId: 'tail', failed: true }))
    const deps = { memoryRoot: root, enabled: () => true, exists: () => true, execute }
    const queue = new MemoryExtractScheduler(deps)
    await queue.runNow('s1', '/ws')
    expect(queue.getCursor('s1')).toMatchObject({ attempts: 1, lastMessageId: null })
    await vi.advanceTimersByTimeAsync(MEMORY_EXTRACT_IDLE_DELAY_MS * 2 + 1)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(queue.getCursor('s1')).toMatchObject({ attempts: 3, lastMessageId: 'tail', lastError: 'extraction-failed' })
    queue.dispose()
    const restored = new MemoryExtractScheduler(deps)
    expect(restored.getCursor('s1')).toEqual(queue.getCursor('s1'))
    restored.removeSession('s1'); restored.dispose()
    expect(JSON.parse(readFileSync(join(root, 'extract-state.json'), 'utf8')).sessions).toEqual({})
    let release: () => void = () => undefined
    const inflight = new MemoryExtractScheduler({ ...deps, execute: async () => { await new Promise<void>(resolve => { release = resolve }); return { lastMessageId: 'tail' } } })
    inflight.enqueue('s2', '/ws', 0); await vi.advanceTimersByTimeAsync(0)
    inflight.removeSession('s2'); release(); await vi.advanceTimersByTimeAsync(1)
    expect(inflight.getCursor('s2')).toBeUndefined(); inflight.dispose()
  })

  it('启动清理过期和已删除游标，不覆盖损坏的状态文件', async () => {
    const root = join(profile, 'memory'), now = 100 * 86_400_000
    const queue = new MemoryExtractScheduler({ memoryRoot: root, enabled: () => true, exists: () => true, execute: async () => ({ lastMessageId: 'tail' }), now: () => now - 31 * 86_400_000 })
    await queue.runNow('expired', '/ws'); await queue.runNow('deleted', '/ws'); queue.dispose()
    const restored = new MemoryExtractScheduler({ memoryRoot: root, enabled: () => true, exists: id => id !== 'deleted', execute: async () => ({ lastMessageId: 'tail' }), now: () => now })
    expect(restored.getCursor('expired')).toBeUndefined(); expect(restored.getCursor('deleted')).toBeUndefined(); restored.dispose()
    const path = join(root, 'extract-state.json')
    writeFileSync(path, '{invalid state')
    expect(() => new MemoryExtractScheduler({ memoryRoot: root, enabled: () => true, exists: () => true, execute: async () => ({ lastMessageId: 'tail' }) })).toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{invalid state')
  })

  it('游标状态损坏时，opt-out 会话的 turn 收尾与离开不抛错，也不改写状态文件', async () => {
    const { session, store } = fixture()
    activeStore = store; session.memoryOptOut = true
    const path = join(profile, 'memory', 'extract-state.json')
    mkdirSync(join(profile, 'memory'), { recursive: true })
    writeFileSync(path, '{invalid state')
    const host = await import('../../../src/main/services/MemoryExtractHost')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => host.onUserTurnCompleteForExtract('s1', '/workspace')).not.toThrow()
    expect(() => host.extractOnSessionLeave('s1', '/workspace')).not.toThrow()
    expect(readFileSync(path, 'utf8')).toBe('{invalid state')
    expect(() => host.skipMemoryExtractionThroughCurrentTail('s1', store)).toThrow()
  })
})
