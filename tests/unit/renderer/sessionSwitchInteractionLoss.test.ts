/**
 * T0-3 → T2-3：切会话后交互入口应通过 snapshot-first 恢复
 *
 * 修好后行为：
 * - 切走时 resetAgentRuntime 清空本地投影（避免串会话）
 * - 切回时 pullSnapshot → projectInteractionsToAgentStore 恢复 pending
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  useAgentStore,
  resetAgentStoreForTests
} from '../../../src/renderer/stores/useAgentStore'
import {
  useRunStore,
  projectInteractionsToAgentStore
} from '../../../src/renderer/stores/useRunStore'
import {
  dispatchWorkspaceChange,
  resetWorkspaceDispatcherForTests
} from '../../../src/renderer/stores/workspaceDispatcher'
import type { WorkspaceState } from '../../../src/shared/workspace/types'
import type { PendingPermissionRequest } from '../../../src/renderer/stores/types'
import type { RunSnapshot } from '../../../src/shared/run/types'

const sessionASnapshot: RunSnapshot = {
  runId: 'run-A',
  kind: 'agent',
  workspaceId: '/test/project',
  sessionId: 'session-A',
  messageId: 'msg_1',
  status: 'waiting_user',
  sequence: 3,
  pendingInteractions: [
    {
      interactionId: 'perm_1',
      runId: 'run-A',
      sessionId: 'session-A',
      messageId: 'msg_1',
      type: 'permission',
      status: 'pending',
      createdAt: Date.now(),
      version: 1,
      payload: {
        requestId: 'perm_1',
        toolName: 'bash',
        args: { command: 'ls' },
        riskLevel: 'medium',
        reason: 'run ls',
        toolCallIds: ['tc_1']
      }
    }
  ],
  currentAttempt: null,
  progress: { label: '等待你的授权' },
  lastHeartbeatAt: Date.now(),
  createdAt: Date.now(),
  updatedAt: Date.now(),
  toolCommits: []
}

const mockInvoke = vi.fn(async (channel: string, params?: { sessionId?: string }) => {
  if (channel === 'run:get-snapshot') {
    if (params?.sessionId === 'session-A') {
      return {
        snapshot: sessionASnapshot,
        waitingSessions: [
          { sessionId: 'session-A', runId: 'run-A', pendingCount: 1 }
        ]
      }
    }
    return { snapshot: null, waitingSessions: [] }
  }
  if (channel === 'run:list-waiting') {
    return [{ sessionId: 'session-A', runId: 'run-A', pendingCount: 1 }]
  }
  if (channel === 'load-session') {
    return {
      id: params?.sessionId ?? 'session-A',
      messages: [],
      workspaceRoot: '/test/project',
      mode: 'default',
      createdAt: 0,
      updatedAt: 0,
      messageCount: 0
    }
  }
  return undefined
})

function makeWorkspaceState(sessionId: string | null): WorkspaceState {
  return {
    currentProjectPath: '/test/project',
    currentSessionId: sessionId,
    currentMode: 'default',
    availableSessions: sessionId
      ? [
          {
            id: sessionId,
            title: 's',
            createdAt: Date.now(),
            updatedAt: Date.now(),
            mode: 'default',
            workspaceRoot: '/test/project',
            messageCount: 1
          }
        ]
      : [],
    messagesRevision: 1,
    tier1BranchContext: null
  }
}

const permissionRequest: PendingPermissionRequest = {
  messageId: 'msg_1',
  requestId: 'perm_1',
  toolName: 'bash',
  args: { command: 'ls' },
  riskLevel: 'medium',
  reason: 'run ls',
  toolCallIds: ['tc_1'],
  sessionId: 'session-A',
  runId: 'run-A',
  interactionId: 'perm_1',
  version: 1
}

describe('T2-3 切会话交互恢复（snapshot-first）', () => {
  beforeEach(() => {
    resetAgentStoreForTests()
    resetWorkspaceDispatcherForTests()
    useRunStore.getState().resetForTests()
    mockInvoke.mockClear()
    global.window = {
      ...global.window,
      api: {
        invoke: mockInvoke,
        on: vi.fn(),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
    dispatchWorkspaceChange(makeWorkspaceState('session-A'))
  })

  afterEach(() => {
    resetAgentStoreForTests()
    resetWorkspaceDispatcherForTests()
    useRunStore.getState().resetForTests()
  })

  it('权限等待中切到其他会话 → 本地投影清空（防串会话）', async () => {
    useAgentStore.getState().handlePermissionRequest(permissionRequest)
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm_1')

    dispatchWorkspaceChange(makeWorkspaceState('session-B'))
    // 切走时清空本地；session-B 的 pullSnapshot 返回 null
    await vi.waitFor(() => {
      expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
    })
  })

  it('切走再切回原会话 → snapshot 恢复交互入口', async () => {
    useAgentStore.getState().handlePermissionRequest(permissionRequest)
    expect(useAgentStore.getState().pendingPermissionRequest).not.toBeNull()

    dispatchWorkspaceChange(makeWorkspaceState('session-B'))
    await vi.waitFor(() => {
      expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
    })

    // 切回 session-A：pullSnapshot 恢复
    dispatchWorkspaceChange(makeWorkspaceState('session-A'))
    await vi.waitFor(() => {
      expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm_1')
    })
  })

  it('askQuestion 等待中切回 → 可从 snapshot 投影恢复', () => {
    // 直接验证投影函数（与 pullSnapshot 同源）
    const snap: RunSnapshot = {
      ...sessionASnapshot,
      pendingInteractions: [
        {
          interactionId: 'ask_1',
          runId: 'run-A',
          sessionId: 'session-A',
          messageId: 'msg_1',
          type: 'askQuestion',
          status: 'pending',
          createdAt: Date.now(),
          version: 1,
          payload: {
            requestId: 'ask_1',
            questions: [
              {
                question: '选哪个？',
                options: [{ label: 'A' }, { label: 'B' }]
              }
            ]
          }
        }
      ]
    }
    useAgentStore.getState().resetAgentRuntime()
    expect(useAgentStore.getState().pendingAskQuestion).toBeNull()
    projectInteractionsToAgentStore(snap, 'session-A')
    expect(useAgentStore.getState().pendingAskQuestion?.requestId).toBe('ask_1')
  })
})
