// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from '../../../src/renderer/App'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import { useSettingsStore, resetSettingsStoreForTests, type ContextBreakdown } from '../../../src/renderer/stores/useSettingsStore'
import { resetWorkspaceStoreForTests } from '../../../src/renderer/stores/useWorkspaceStore'
import { resetWorkspaceDispatcherForTests } from '../../../src/renderer/stores/workspaceDispatcher'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import {
  resetCodeIndexStoreForTests,
  useCodeIndexStore
} from '../../../src/renderer/stores/useCodeIndexStore'
import { act, renderDom } from './renderDom'

const themeModeSpy = vi.hoisted(() => vi.fn())

vi.mock('@astryxdesign/core/theme', async importOriginal => {
  const actual = await importOriginal<typeof import('@astryxdesign/core/theme')>()
  return {
    ...actual,
    Theme: ({ children, mode }: { children: React.ReactNode; mode?: string }) => {
      themeModeSpy(mode)
      return children
    }
  }
})

vi.mock('../../../src/renderer/components/Sidebar', () => ({
  Sidebar: () => null
}))

vi.mock('../../../src/renderer/features/chat/ChatPanel', () => ({
  ChatPanel: () => null
}))

vi.mock('../../../src/renderer/features/settings/SettingsModal', () => ({
  SettingsModal: () => null
}))

vi.mock('../../../src/renderer/components/ContentTopBar', () => ({
  ContentTopBar: () => null
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
    themeModeSpy.mockClear()
    eventHandlers.clear()

    resetChatStoreForTests()
    resetSettingsStoreForTests()
    resetWorkspaceStoreForTests()
    resetWorkspaceDispatcherForTests()
    resetAgentStoreForTests()
    resetCodeIndexStoreForTests()

    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'load-model-config') return Promise.resolve(null)
      if (channel === 'settings:get') return Promise.resolve({ theme: 'system' })
      if (channel === 'workspace:get') {
        return Promise.resolve({
          currentSessionId: null,
          currentProjectPath: null,
          currentMode: 'default',
          availableSessions: []
        })
      }
      if (channel === 'codeindex:get-status') {
        return Promise.resolve({
          workspaceRoot: null,
          sequence: 1,
          enabled: false,
          status: 'idle',
          activeGeneration: null,
          revision: 0,
          coverage: {
            eligibleFiles: 0,
            indexedFiles: 0,
            parseFailures: 0,
            unsupportedFiles: 0,
            oversizedFiles: 0,
            unresolvedRelations: 0
          },
          progress: null,
          lastCompletedAt: null,
          failure: null,
          workerState: 'stopped',
          databaseBytes: 0
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

    Object.assign(window, {
      api: {
        invoke: mockInvoke,
        on: mockOn,
        removeAllListeners: mockRemoveAllListeners
      }
    })

    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('会话在挂载后才切入时，仍应接受当前会话的 breakdown', async () => {
    const renderer = renderDom(React.createElement(App))
    await act(async () => {
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

    renderer.unmount()
  })

  it('会话切换后应按最新 currentSessionId 过滤旧 breakdown 事件', async () => {
    const renderer = renderDom(React.createElement(App))
    await act(async () => {
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

    renderer.unmount()
  })

  it('将 settings store 的主题 mode 只读投影给 Astryx Theme provider', async () => {
    useSettingsStore.setState({ theme: 'dark' })

    const renderer = renderDom(React.createElement(App))
    await act(async () => {
      await Promise.resolve()
    })

    expect(themeModeSpy).toHaveBeenCalledWith('dark')
    renderer.unmount()
  })

  it('reload 挂载后拉取代码索引快照并订阅状态事件', async () => {
    const renderer = renderDom(React.createElement(App))
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('codeindex:get-status')
    expect(eventHandlers.get('codeindex:status')).toBeTypeOf('function')
    expect(useCodeIndexStore.getState().snapshotsByWorkspaceRoot['\0']?.enabled).toBe(false)

    renderer.unmount()
    expect(eventHandlers.has('codeindex:status')).toBe(false)
  })
})
