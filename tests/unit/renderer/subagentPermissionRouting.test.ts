import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetChatStoreForTests,
  useChatStore
} from '../../../src/renderer/stores/useChatStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'
import {
  projectDescendantPendingPermissions,
  resetAgentStoreForTests,
  useAgentStore
} from '../../../src/renderer/stores/useAgentStore'
import type { RunSnapshot } from '../../../src/shared/run/types'
import type { Session } from '../../../src/shared/session/types'

function snap(
  partial: Partial<RunSnapshot> & Pick<RunSnapshot, 'runId' | 'sessionId' | 'sequence' | 'status'>
): RunSnapshot {
  return {
    kind: 'agent',
    workspaceId: '/ws',
    messageId: 'm',
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial
  }
}

function primarySession(id: string): Session {
  return {
    id,
    workspaceRoot: 'w',
    mode: 'default',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    kind: 'primary'
  }
}

function subagentSession(id: string, parentId: string): Session {
  return {
    id,
    workspaceRoot: 'w',
    mode: 'default',
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    kind: 'subagent',
    subagent: {
      lineage: { parentSessionId: parentId, depth: 1 },
      profile: { profileId: 'explore', name: 'Explore', permissionCeiling: 'read_only' }
    }
  }
}

function childPermissionSnapshot(overrides: {
  status?: RunSnapshot['status']
  interactionStatus?: 'pending' | 'submitting' | 'answered'
} = {}): RunSnapshot {
  return snap({
    runId: 'run-child',
    sessionId: 's-child',
    sequence: 5,
    status: overrides.status ?? 'waiting_user',
    messageId: 'msg-child',
    pendingInteractions: [
      {
        interactionId: 'perm-child',
        runId: 'run-child',
        sessionId: 's-child',
        messageId: 'msg-child',
        type: 'permission',
        status: overrides.interactionStatus ?? 'pending',
        createdAt: 1,
        version: 3,
        payload: {
          requestId: 'perm-child',
          toolName: 'bash',
          args: { command: 'pwd' },
          riskLevel: 'low',
          reason: '子代理请求执行命令'
        }
      }
    ]
  })
}

describe('子代理权限请求：重启/切回恢复与响应送达', () => {
  beforeEach(() => {
    resetChatStoreForTests()
    resetAgentStoreForTests()
    useRunStore.getState().resetForTests()
    global.window = {
      ...global.window,
      api: {
        invoke: vi.fn(() => Promise.resolve(undefined)),
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    } as unknown as Window & typeof globalThis
  })

  it('重启/切回后从后代会话 snapshot 恢复权限请求到父会话权限条', async () => {
    useChatStore.setState({
      currentSessionId: 's-parent',
      sessions: [primarySession('s-parent'), subagentSession('s-child', 's-parent')]
    })
    useRunStore.setState({
      selectedSessionId: 's-parent',
      activeRunIdBySessionId: { 's-child': 'run-child' },
      snapshotsByRunId: { 'run-child': childPermissionSnapshot() }
    })

    await projectDescendantPendingPermissions('s-parent')

    const request = useAgentStore.getState().pendingPermissionRequest
    expect(request).not.toBeNull()
    expect(request?.sessionId).toBe('s-child')
    expect(request?.requestId).toBe('perm-child')
    expect(request?.toolName).toBe('bash')
    expect(request?.reason).toBe('子代理请求执行命令')
    expect(request?.version).toBe(3)
    expect(request?.interactionId).toBe('perm-child')
    expect(request?.messageId).toBe('msg-child')
  })

  it('回复送达按子 run 原始 requestId/interactionId/version 组装', async () => {
    useAgentStore.getState().handlePermissionRequest({
      messageId: 'msg-child',
      requestId: 'perm-child',
      toolName: 'bash',
      args: { command: 'pwd' },
      riskLevel: 'low',
      reason: '',
      sessionId: 's-child',
      interactionId: 'perm-child',
      version: 3
    })

    await useAgentStore.getState().respondPermissionRequest('allow')

    expect(vi.mocked(window.api.invoke)).toHaveBeenCalledWith('respond-permission', {
      requestId: 'perm-child',
      decision: 'allow',
      commandId: expect.any(String),
      expectedVersion: 3,
      interactionId: 'perm-child'
    })
    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
  })

  it('父会话已有自身权限请求时不覆盖为后代请求', async () => {
    useChatStore.setState({
      currentSessionId: 's-parent',
      sessions: [primarySession('s-parent'), subagentSession('s-child', 's-parent')]
    })
    useRunStore.setState({
      selectedSessionId: 's-parent',
      activeRunIdBySessionId: { 's-child': 'run-child' },
      snapshotsByRunId: { 'run-child': childPermissionSnapshot() }
    })
    useAgentStore.getState().handlePermissionRequest({
      messageId: 'msg-parent',
      requestId: 'perm-parent',
      toolName: 'bash',
      args: {},
      riskLevel: 'low',
      reason: '父会话自身请求',
      sessionId: 's-parent'
    })

    await projectDescendantPendingPermissions('s-parent')

    const request = useAgentStore.getState().pendingPermissionRequest
    expect(request?.requestId).toBe('perm-parent')
    expect(request?.sessionId).toBe('s-parent')
  })

  it('非后代会话的运行快照不投影到当前会话', async () => {
    useChatStore.setState({
      currentSessionId: 's-parent',
      sessions: [
        primarySession('s-parent'),
        subagentSession('s-other', 's-unrelated')
      ]
    })
    useRunStore.setState({
      selectedSessionId: 's-parent',
      activeRunIdBySessionId: { 's-other': 'run-other' },
      snapshotsByRunId: { 'run-other': childPermissionSnapshot() }
    })

    await projectDescendantPendingPermissions('s-parent')

    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
  })

  it('深层后代（孙代理）权限请求同样恢复', async () => {
    useChatStore.setState({
      currentSessionId: 's-parent',
      sessions: [
        primarySession('s-parent'),
        subagentSession('s-child', 's-parent'),
        subagentSession('s-grandchild', 's-child')
      ]
    })
    useRunStore.setState({
      selectedSessionId: 's-parent',
      activeRunIdBySessionId: { 's-grandchild': 'run-grandchild' },
      snapshotsByRunId: {
        'run-grandchild': snap({
          runId: 'run-grandchild',
          sessionId: 's-grandchild',
          sequence: 7,
          status: 'waiting_user',
          messageId: 'msg-grandchild',
          pendingInteractions: [
            {
              interactionId: 'perm-grandchild',
              runId: 'run-grandchild',
              sessionId: 's-grandchild',
              messageId: 'msg-grandchild',
              type: 'permission',
              status: 'pending',
              createdAt: 1,
              version: 1,
              payload: { requestId: 'perm-grandchild', toolName: 'read', args: {}, riskLevel: 'low', reason: '' }
            }
          ]
        })
      }
    })

    await projectDescendantPendingPermissions('s-parent')

    const request = useAgentStore.getState().pendingPermissionRequest
    expect(request?.sessionId).toBe('s-grandchild')
    expect(request?.requestId).toBe('perm-grandchild')
  })

  it('交互已 answered 时不投影', async () => {
    useChatStore.setState({
      currentSessionId: 's-parent',
      sessions: [primarySession('s-parent'), subagentSession('s-child', 's-parent')]
    })
    useRunStore.setState({
      selectedSessionId: 's-parent',
      activeRunIdBySessionId: { 's-child': 'run-child' },
      snapshotsByRunId: {
        'run-child': childPermissionSnapshot({ interactionStatus: 'answered' })
      }
    })

    await projectDescendantPendingPermissions('s-parent')

    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
  })
})
