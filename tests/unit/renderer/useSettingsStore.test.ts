import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useSettingsStore, resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import { appendSessionUsage } from '../../../src/shared/session/usage'
import { normalizeUsage } from '../../../src/runtime/model/usage'
import type { ContextBreakdown } from '../../../src/shared/agent/contextBreakdown'

const mockInvoke = vi.fn()
global.window = {
  ...global.window,
  api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() }
} as unknown as Window & typeof globalThis

beforeEach(() => {
  resetSettingsStoreForTests()
  mockInvoke.mockReset()
})

it('迟到的会话详情不覆盖较新的上下文事件，切换会话仍采用目标详情', () => {
  const current: ContextBreakdown = { sessionId: 'a', messageId: 'm', capturedAt: 20,
    totalEstimated: 100, promptTokensActual: 0, contextLimit: 200_000,
    breakdown: { systemPrompt: 10, tools: 10, skills: 10, messages: 70, other: 0 } }
  const store = useSettingsStore.getState()
  store.setContextBreakdown(current)
  store.setContextBreakdown({ ...current, capturedAt: 10, totalEstimated: 50 })
  expect(useSettingsStore.getState().contextBreakdown).toEqual(current)
  const next = { ...current, sessionId: 'b', capturedAt: 10 }
  store.setContextBreakdown(next)
  expect(useSettingsStore.getState().contextBreakdown).toEqual(next)
})

it('用量投影拒绝重复、过期和其他会话快照；切回可从磁盘快照恢复', () => {
  const usage = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } })!
  const first = appendSessionUsage(null, 'a', usage, 'openai')
  const second = appendSessionUsage(first, 'a', usage, 'openai')
  const other = appendSessionUsage(null, 'b', usage, 'openai')
  const store = useSettingsStore.getState()
  store.resetSessionUsage('a')
  store.applySessionUsage(second)
  store.applySessionUsage(first)
  store.applySessionUsage(second)
  store.applySessionUsage(other)
  expect(useSettingsStore.getState().sessionUsage).toMatchObject({ totalPromptTokens: 200, hitRate: 0.8 })
  expect(useSettingsStore.getState().sessionUsageRevision).toBe(2)
  store.resetSessionUsage('b')
  store.applySessionUsage(second)
  expect(useSettingsStore.getState().sessionUsage).toBeNull()
  expect(useSettingsStore.getState().sessionUsageByProfile).toEqual({})
  store.applySessionUsage(other)
  expect(useSettingsStore.getState().sessionUsage?.totalPromptTokens).toBe(100)
  store.resetSessionUsage('a')
  store.applySessionUsage(second)
  expect(useSettingsStore.getState().sessionUsage?.totalPromptTokens).toBe(200)
})

describe('领航入口推荐偏好', () => {
  it('关闭后立即生效，迟到的旧读取不会重新展示', async () => {
    let finishRead: ((value: { pilotEntryGuideDismissed: boolean }) => void) | null = null
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') {
        return new Promise<{ pilotEntryGuideDismissed: boolean }>(resolve => { finishRead = resolve })
      }
      return Promise.resolve({ pilotEntryGuideDismissed: true })
    })

    const loading = useSettingsStore.getState().loadPilotEntryGuidePreference()
    useSettingsStore.getState().dismissPilotEntryGuide()
    expect(useSettingsStore.getState().pilotEntryGuideDismissed).toBe(true)
    finishRead?.({ pilotEntryGuideDismissed: false })
    await loading

    expect(mockInvoke).toHaveBeenCalledWith('settings:set', { pilotEntryGuideDismissed: true })
    expect(useSettingsStore.getState().pilotEntryGuideDismissed).toBe(true)
  })
})

describe('useSettingsStore.theme', () => {
  it('loadTheme 将持久化主题投影到 renderer store', async () => {
    mockInvoke.mockResolvedValue({ theme: 'dark' })
    await useSettingsStore.getState().loadTheme()
    expect(mockInvoke).toHaveBeenCalledWith('settings:get')
    expect(useSettingsStore.getState().theme).toBe('dark')
  })

  it('setTheme 只在 IPC 成功后采用权威返回值', async () => {
    mockInvoke.mockResolvedValue({ theme: 'light' })
    await useSettingsStore.getState().setTheme('dark')
    expect(mockInvoke).toHaveBeenCalledWith('settings:set', { theme: 'dark' })
    expect(useSettingsStore.getState().theme).toBe('light')
  })

  it('setTheme 失败时保留原投影并向调用方抛错', async () => {
    useSettingsStore.setState({ theme: 'light' })
    const failure = new Error('保存失败')
    mockInvoke.mockRejectedValue(failure)
    await expect(useSettingsStore.getState().setTheme('dark')).rejects.toBe(failure)
    expect(useSettingsStore.getState().theme).toBe('light')
  })
})
