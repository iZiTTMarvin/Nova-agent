import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DEFAULT_NOVA_SETTINGS } from '../../../src/runtime/settings/novaSettings'

let profile: string
const settings = vi.fn(), busy = vi.fn(), chat = vi.fn(), maintain = vi.fn(), organize = vi.fn(), upgrade = vi.fn(), input = vi.fn()
vi.mock('electron', () => ({ app: { getPath: () => profile } }))
vi.mock('../../../src/runtime/settings/novaSettings', async original => ({ ...await original<typeof import('../../../src/runtime/settings/novaSettings')>(), loadNovaSettings: () => settings() }))
vi.mock('../../../src/main/agent/state/AgentExecutionStateHost', () => ({ isAgentTurnInProgress: () => busy() }))
vi.mock('../../../src/main/services/MemoryModelChat', () => ({ createExtractChatFn: () => chat }))
vi.mock('../../../src/main/services/MemoryServiceHost', () => ({
  getMemoryService: () => ({ reconcile: () => undefined }), upgradeMemoryLearnedEpoch: (...args: unknown[]) => upgrade(...args),
  getMemoryEntryStore: () => ({ memoryRoot: join(profile, 'memory'), isReadOnly: () => false, listScopes: () => [{ scopeKind: 'global', scopeId: 'user' }], maintain, trimMaintenanceBackups: () => undefined, topicMaintenanceInput: input, organize })
}))

beforeEach(async () => {
  vi.clearAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 9, 8, 12))
  profile = mkdtempSync(join(tmpdir(), 'nova-maintenance-host-'))
  settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true })
  busy.mockReturnValue(false); maintain.mockReturnValue(2); upgrade.mockReturnValue(0)
  chat.mockResolvedValue('{"merge":[],"retire":[]}')
  input.mockReturnValue({ fingerprint: 'fixture', suggested: true, entries: [
    { record: { id: 'm_0000000001', memoryKey: 'first', explicitness: 'user_explicit', content: '中文提交需要说明原因' }, pinned: false },
    { record: { id: 'm_0000000002', memoryKey: 'second', explicitness: 'observed', content: '中文提交需要说明约束' }, pinned: true }
  ] })
  const host = await import('../../../src/main/services/MemoryMaintenanceHost'); host.resetMemoryMaintenanceHostForTests()
})
afterEach(async () => {
  const host = await import('../../../src/main/services/MemoryMaintenanceHost'); host.resetMemoryMaintenanceHostForTests()
  vi.useRealTimers(); rmSync(profile, { recursive: true, force: true })
})

describe('MemoryMaintenanceHost lifecycle', () => {
  it('retention runs only after startup idle and at most once per local day, including restart', async () => {
    const host = await import('../../../src/main/services/MemoryMaintenanceHost')
    busy.mockReturnValue(true); host.initializeMemoryMaintenanceHost()
    await vi.advanceTimersByTimeAsync(60_001); expect(maintain).not.toHaveBeenCalled()
    busy.mockReturnValue(false); await vi.advanceTimersByTimeAsync(30_001)
    expect(maintain).toHaveBeenCalledTimes(1); expect(upgrade).toHaveBeenCalledWith(1)
    expect(host.runMemoryRetention()).toEqual({ entries: 0, files: 0 })
    host.resetMemoryMaintenanceHostForTests()
    expect(host.runMemoryRetention()).toEqual({ entries: 0, files: 0 })
    expect(maintain).toHaveBeenCalledTimes(1)
    vi.setSystemTime(new Date(2026, 9, 9, 12)); expect(host.runMemoryRetention()).toEqual({ entries: 2, files: 0 })
  })

  it('auto organizing defaults off and is bounded daily; explicit organizing always runs and passes the original fingerprint', async () => {
    const host = await import('../../../src/main/services/MemoryMaintenanceHost'), scope = { scopeKind: 'global' as const, scopeId: 'user' }
    await host.organizeMemoryTopic(scope, 'conventions.md', true)
    expect(chat).not.toHaveBeenCalled()
    await Promise.all([host.organizeMemoryTopic(scope, 'conventions.md'), host.organizeMemoryTopic(scope, 'conventions.md')])
    expect(chat).toHaveBeenCalledTimes(2)
    expect(chat.mock.calls[0][0][0].content).toContain('untrusted reference data')
    expect(JSON.parse(chat.mock.calls[0][0][1].content)[0].by).toBe('user')
    expect(organize).toHaveBeenCalledWith(scope, 'conventions.md', { merge: [], retire: [] }, 'fixture')
    const persisted = readFileSync(join(profile, 'memory/maintenance-state.json'), 'utf8')
    expect(persisted).toContain('global/user/conventions.md')
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true, memoryAutoExtractEnabled: true })
    await host.organizeMemoryTopic(scope, 'conventions.md', true)
    expect(chat).toHaveBeenCalledTimes(2)
    vi.setSystemTime(new Date(2026, 9, 9, 12))
    await host.organizeMemoryTopic(scope, 'conventions.md', true); await host.organizeMemoryTopic(scope, 'conventions.md', true)
    expect(chat).toHaveBeenCalledTimes(3)
  })

  it('explicit organizing reports disabled memory instead of a silent empty result', async () => {
    const host = await import('../../../src/main/services/MemoryMaintenanceHost')
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: false })
    await expect(host.organizeMemoryTopic({ scopeKind: 'global', scopeId: 'user' }, 'conventions.md')).rejects.toThrow('记忆未启用')
    expect(chat).not.toHaveBeenCalled()
  })

  it('turning off memory during response and malformed model JSON never call Store organization', async () => {
    const host = await import('../../../src/main/services/MemoryMaintenanceHost'), scope = { scopeKind: 'global' as const, scopeId: 'user' }
    chat.mockImplementation(async () => { settings.mockReturnValue(DEFAULT_NOVA_SETTINGS); return '{"merge":[],"retire":[]}' })
    await host.organizeMemoryTopic(scope, 'conventions.md')
    expect(organize).not.toHaveBeenCalled()
    settings.mockReturnValue({ ...DEFAULT_NOVA_SETTINGS, memoryEnabled: true }); chat.mockResolvedValue('invalid JSON')
    await expect(host.organizeMemoryTopic(scope, 'gotchas.md')).rejects.toThrow()
    expect(organize).not.toHaveBeenCalled()
  })
})
