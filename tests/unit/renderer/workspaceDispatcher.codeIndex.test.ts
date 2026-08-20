// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import { resetAgentStoreForTests } from '../../../src/renderer/stores/useAgentStore'
import { resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'
import {
  resetCodeIndexStoreForTests,
  useCodeIndexStore
} from '../../../src/renderer/stores/useCodeIndexStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'
import { resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import {
  resetWorkspaceStoreForTests,
  useWorkspaceStore
} from '../../../src/renderer/stores/useWorkspaceStore'
import {
  dispatchWorkspaceChange,
  resetWorkspaceDispatcherForTests
} from '../../../src/renderer/stores/workspaceDispatcher'
import type { WorkspaceState } from '../../../src/shared/workspace/types'
import type { CodeIndexStatusDto } from '../../../src/shared/code-index'

const invoke = vi.fn()

describe('workspaceDispatcher 代码索引同步', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetAgentStoreForTests()
    resetChatStoreForTests()
    resetCodeIndexStoreForTests()
    resetSettingsStoreForTests()
    resetWorkspaceStoreForTests()
    resetWorkspaceDispatcherForTests()
    useRunStore.getState().resetForTests()
    useSubagentProjectionStore.getState().resetForTests()
    Object.assign(window, {
      api: {
        invoke,
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    })
    invoke.mockImplementation((channel: string, params?: { sessionId?: string }) => {
      if (channel === 'codeindex:get-status') {
        return Promise.resolve(disabledStatus('C:\\repo'))
      }
      if (channel === 'run:get-snapshot') {
        return Promise.resolve({ snapshot: null, waitingSessions: [] })
      }
      if (channel === 'load-session') {
        return Promise.resolve({
          id: params?.sessionId ?? 'sess-a',
          workspaceRoot: 'C:\\repo',
          mode: 'default',
          messages: [],
          createdAt: 0,
          updatedAt: 0,
          messageCount: 0
        })
      }
      return Promise.resolve(undefined)
    })
  })

  it('只在会话或工作区切换时补拉代码索引快照', async () => {
    // 首次初始化的补拉由 App.init().then 负责；这里只验证后续广播不会噪声触发。
    invoke.mockClear()
    useWorkspaceStore.setState({ initialized: true })

    dispatchWorkspaceChange(workspaceState({
      currentSessionId: 'sess-a',
      currentProjectPath: 'C:\\repo',
      availableSessions: [sessionSummary('sess-a')]
    }))
    await Promise.resolve()

    dispatchWorkspaceChange(workspaceState({
      currentSessionId: 'sess-a',
      currentProjectPath: 'C:\\repo',
      availableSessions: [sessionSummary('sess-a'), sessionSummary('sess-b')]
    }))
    await Promise.resolve()

    const channels = invoke.mock.calls.map(([channel]) => channel)
    expect(channels.filter(channel => channel === 'codeindex:get-status')).toHaveLength(1)
  })

  it('同根切换会话时先关闭旧准入闸门，再拉取新会话快照', async () => {
    useWorkspaceStore.setState({ initialized: true })
    dispatchWorkspaceChange(workspaceState({
      currentSessionId: 'sess-a',
      currentProjectPath: 'C:\\repo',
      availableSessions: [sessionSummary('sess-a'), sessionSummary('sess-b')]
    }))
    await Promise.resolve()

    useCodeIndexStore.setState({
      snapshotsByWorkspaceRoot: {
        'C:\\repo': { ...disabledStatus('C:\\repo'), enabled: true, sequence: 4, status: 'ready' }
      }
    })

    let resolveStatus: ((value: CodeIndexStatusDto) => void) | null = null
    invoke.mockImplementation((channel: string, params?: { sessionId?: string }) => {
      if (channel === 'codeindex:get-status') {
        return new Promise<CodeIndexStatusDto>(resolve => {
          resolveStatus = resolve
        })
      }
      if (channel === 'run:get-snapshot') {
        return Promise.resolve({ snapshot: null, waitingSessions: [] })
      }
      if (channel === 'load-session') {
        return Promise.resolve({
          id: params?.sessionId ?? 'sess-b',
          workspaceRoot: 'C:\\repo',
          mode: 'default',
          messages: [],
          createdAt: 0,
          updatedAt: 0,
          messageCount: 0
        })
      }
      return Promise.resolve(undefined)
    })

    dispatchWorkspaceChange(workspaceState({
      currentSessionId: 'sess-b',
      currentProjectPath: 'C:\\repo',
      availableSessions: [sessionSummary('sess-a'), sessionSummary('sess-b')]
    }))

    expect(useCodeIndexStore.getState().snapshotsByWorkspaceRoot['C:\\repo']?.enabled).toBe(false)
    useCodeIndexStore.getState().handleStatusEvent({
      ...disabledStatus('C:\\repo'),
      enabled: true,
      sequence: 5,
      status: 'ready'
    })
    expect(useCodeIndexStore.getState().snapshotsByWorkspaceRoot['C:\\repo']?.enabled).toBe(false)

    resolveStatus?.(disabledStatus('C:\\repo'))
    await Promise.resolve()
    await Promise.resolve()
    expect(useCodeIndexStore.getState().snapshotsByWorkspaceRoot['C:\\repo']?.enabled).toBe(false)
  })
})

function workspaceState(
  overrides: Partial<WorkspaceState>
): WorkspaceState {
  return {
    currentSessionId: null,
    currentProjectPath: null,
    currentMode: 'default',
    reasoningEffortOverride: null,
    availableSessions: [],
    messagesRevision: 1,
    tier1BranchContext: null,
    ...overrides
  }
}

function sessionSummary(sessionId: string) {
  return {
    id: sessionId,
    title: sessionId,
    createdAt: 0,
    updatedAt: 0,
    mode: 'default' as const,
    workspaceRoot: 'C:\\repo',
    messageCount: 0
  }
}

function disabledStatus(workspaceRoot: string) {
  return {
    workspaceRoot,
    sequence: 1,
    enabled: false,
    status: 'idle' as const,
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
    workerState: 'stopped' as const,
    databaseBytes: 0
  }
}
