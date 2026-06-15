import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../src/renderer/App'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { useSettingsStore, resetSettingsStoreForTests, type ContextBreakdown } from '../../../src/renderer/stores/useSettingsStore'
import { resetWorkspaceStoreForTests } from '../../../src/renderer/stores/useWorkspaceStore'
import { resetWorkspaceDispatcherForTests } from '../../../src/renderer/stores/workspaceDispatcher'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'

vi.mock('../../../src/renderer/components/Sidebar', () => ({
  Sidebar: () => null
}))

vi.mock('../../../src/renderer/features/chat/ChatPanel', () => ({
  ChatPanel: () => null
}))

vi.mock('../../../src/renderer/features/permissions/PermissionPrompt', () => ({
  PermissionPrompt: () => null
}))

vi.mock('../../../src/renderer/features/settings/SettingsModal', () => ({
  SettingsModal: () => null
}))

vi.mock('../../../src/renderer/components/TitleBar', () => ({
  TitleBar: () => null
}))

vi.mock('../../../src/renderer/components/Icons', () => ({
  NovaLogo: () => null,
  SettingsIcon: () => null
}))

vi.mock('../../../src/renderer/lib/streamDeltaBuffer', () => ({
  createStreamDeltaBuffer: () => ({
    pushThinking: vi.fn(),
    pushText: vi.fn(),
    pushToolCallDelta: vi.fn(),
    flushNow: vi.fn(),
    dispose: vi.fn()
  })
}))

const mockInvoke = vi.fn()
const mockOn = vi.fn()
const mockRemoveAllListeners = vi.fn()

const eventHandlers = new Map<string, (payload: any) => void>()

function makeContextBreakdown(sessionId: string, totalEstimated: number): ContextBreakdown {
  return {
    sessionId,
    messageId: '',
    breakdown: {
      systemPrompt: 100,
      skills: 50,
      tools: 25,
      messages: totalEstimated - 175,
      other: 0
    },
    totalEstimated,
    promptTokensActual: 0,
    capturedAt: 1,
    contextLimit: 200_000
  }
}

describe('App agent:context-breakdown 监听', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventHandlers.clear()

    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetWorkspaceStoreForTests()
    resetWorkspaceDispatcherForTests()
    resetAgentStoreForTests()

    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'load-model-config') return Promise.resolve(null)
      if (channel === 'workspace:get') {
        return Promise.resolve({
          currentSessionId: null,
          currentProjectPath: null,
          currentMode: 'default',
          availableSessions: []
        })
      }
      return Promise.resolve(undefined)
    })

    mockOn.mockImplementation((channel: string, handler: (payload: any) => void) => {
      eventHandlers.set(channel, handler)
      return () => {
        eventHandlers.delete(channel)
      }
    })

    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: mockOn,
        removeAllListeners: mockRemoveAllListeners
      }
    } as unknown as Window & typeof globalThis

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('会话在挂载后才切入时，仍应接受当前会话的 breakdown', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(App))
      await Promise.resolve()
    })

    const handler = eventHandlers.get('agent:context-breakdown')
    expect(handler).toBeTypeOf('function')

    act(() => {
      useChatStore.setState({ currentSessionId: 'sess_current' })
    })

    const payload = makeContextBreakdown('sess_current', 1200)
    act(() => {
      handler?.(payload)
    })

    expect(useSettingsStore.getState().contextBreakdown).toEqual(payload)

    act(() => {
      renderer?.unmount()
    })
  })

  it('会话切换后应按最新 currentSessionId 过滤旧 breakdown 事件', async () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null

    await act(async () => {
      renderer = TestRenderer.create(React.createElement(App))
      await Promise.resolve()
    })

    const handler = eventHandlers.get('agent:context-breakdown')
    expect(handler).toBeTypeOf('function')

    act(() => {
      useChatStore.setState({ currentSessionId: 'sess_a' })
    })

    const firstPayload = makeContextBreakdown('sess_a', 800)
    act(() => {
      handler?.(firstPayload)
    })
    expect(useSettingsStore.getState().contextBreakdown).toEqual(firstPayload)

    act(() => {
      useChatStore.setState({ currentSessionId: 'sess_b' })
    })

    const stalePayload = makeContextBreakdown('sess_a', 1600)
    act(() => {
      handler?.(stalePayload)
    })

    expect(useSettingsStore.getState().contextBreakdown).toEqual(firstPayload)

    act(() => {
      renderer?.unmount()
    })
  })
})
