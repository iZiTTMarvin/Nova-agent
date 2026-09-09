import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'
import { resetAgentStoreForTests, useAgentStore } from '../../../src/renderer/stores/useAgentStore'
import type { RunSnapshot } from '../../../src/shared/run/types'
import type { Session } from '../../../src/shared/session/types'

function session(id: string, parentId?: string): Session {
  const base = { id, workspaceRoot: 'w', mode: 'default' as const, createdAt: 1, updatedAt: 1, messageCount: 0 }
  return parentId ? {
    ...base, kind: 'subagent', subagent: {
      lineage: { parentSessionId: parentId, depth: 1 },
      profile: { profileId: 'explore', name: 'Explore', permissionCeiling: 'read_only' }
    }
  } : { ...base, kind: 'primary' }
}

function snapshot(sessionId: string, requestId?: string, sequence = 1): RunSnapshot {
  const runId = `run-${sessionId}`
  const messageId = `msg-${sessionId}`
  return {
    runId, sessionId, messageId, kind: 'agent', workspaceId: 'w',
    status: requestId ? 'waiting_user' : 'running', sequence,
    currentAttempt: null, progress: null, lastHeartbeatAt: 1, createdAt: 1, updatedAt: sequence,
    pendingInteractions: requestId ? [{
      interactionId: requestId, runId, sessionId, messageId,
      type: 'permission', status: 'pending', createdAt: 1, version: 3,
      payload: {
        requestId, toolName: 'bash', args: { command: 'pwd' }, riskLevel: 'low',
        reason: '执行命令', commands: ['pwd', 'ls'], toolCallIds: ['tc-1', 'tc-2'],
        externalPaths: ['/external'], pathAccess: 'read'
      }
    }] : []
  }
}

async function publish(s: RunSnapshot): Promise<void> {
  useRunStore.getState().handleSnapshotEvent(s, { sequence: s.sequence, type: 'interaction', at: s.updatedAt })
  await useRunStore.getState().refreshInteractionProjection()
}

const invoke = vi.fn()

beforeEach(() => {
  resetChatStoreForTests()
  resetAgentStoreForTests()
  useRunStore.getState().resetForTests()
  invoke.mockReset().mockImplementation(async channel => channel === 'run:list-waiting' ? [] : undefined)
  global.window = { ...global.window, api: { invoke, on: vi.fn(), removeAllListeners: vi.fn() } } as unknown as Window & typeof globalThis
  useChatStore.setState({
    currentSessionId: 'parent',
    sessions: [session('parent'), session('child', 'parent'), session('sibling', 'parent'), session('grandchild', 'child'), session('other', 'unrelated')]
  })
  useRunStore.getState().selectSession('parent')
})

describe('子代理权限请求的权威快照投影', () => {
  it('重启/切回恢复完整的子请求身份与批量命令，不改变焦点', async () => {
    const child = snapshot('child', 'perm-child')
    invoke.mockImplementation(async channel => channel === 'run:get-snapshot'
      ? { snapshot: child, waitingSessions: [] } : [])
    await useRunStore.getState().pullSnapshot('child')
    expect(useRunStore.getState().selectedSessionId).toBe('parent')
    expect(useAgentStore.getState().pendingPermissionRequest).toEqual({
      messageId: child.messageId, requestId: 'perm-child', runId: child.runId, sessionId: 'child',
      interactionId: 'perm-child', version: 3, toolName: 'bash', args: { command: 'pwd' },
      riskLevel: 'low', reason: '执行命令', commands: ['pwd', 'ls'], toolCallIds: ['tc-1', 'tc-2'],
      externalPaths: ['/external'], pathAccess: 'read'
    })
  })

  it('父快照持续更新不会清除子权限，父请求结束后自动显示后代请求', async () => {
    await publish(snapshot('child', 'perm-child'))
    await publish(snapshot('parent', undefined, 2))
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm-child')
    await publish(snapshot('parent', 'perm-parent', 3))
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm-parent')
    await publish(snapshot('parent', undefined, 4))
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm-child')
  })

  it('按子请求版本提交，权威答复后连续显示下一条，不等待父快照', async () => {
    const child = snapshot('child', 'perm-a')
    const sibling = snapshot('sibling', 'perm-b')
    await publish(child)
    await publish(sibling)
    invoke.mockImplementation(async channel => {
      if (channel === 'respond-permission') return { ok: true }
      if (channel === 'run:get-snapshot') return { snapshot: snapshot('child', undefined, 2), waitingSessions: [] }
      return []
    })
    await useAgentStore.getState().respondPermissionRequest('allow')
    expect(invoke).toHaveBeenCalledWith('respond-permission', {
      requestId: 'perm-a', decision: 'allow', commandId: expect.any(String), expectedVersion: 3, interactionId: 'perm-a'
    })
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm-b')
    expect(useRunStore.getState().selectedSessionId).toBe('parent')
  })

  it.each(['success', 'error'] as const)('旧请求迟到的 %s 回执不清除新请求的提交状态', async result => {
    await publish(snapshot('child', 'perm-a'))
    let resolveFirst!: (value: unknown) => void
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (value: unknown) => void
    const firstResponse = new Promise((resolve, reject) => { resolveFirst = resolve; rejectFirst = reject })
    const secondResponse = new Promise(resolve => { resolveSecond = resolve })
    invoke.mockImplementation((channel, params) => {
      if (channel === 'respond-permission') return params.requestId === 'perm-a' ? firstResponse : secondResponse
      if (channel === 'run:get-snapshot') return Promise.resolve({ snapshot: snapshot('child', 'perm-b', 2), waitingSessions: [] })
      return Promise.resolve([])
    })
    const first = useAgentStore.getState().respondPermissionRequest('allow')
    await publish(snapshot('child', 'perm-b', 2))
    const second = useAgentStore.getState().respondPermissionRequest('allow')
    if (result === 'success') resolveFirst({ ok: true })
    else rejectFirst(new Error('旧请求失败'))
    await first
    expect(useAgentStore.getState().pendingPermissionRequest?.requestId).toBe('perm-b')
    expect(useAgentStore.getState().isSubmittingPermission).toBe(true)
    expect(useAgentStore.getState().permissionError).toBeNull()
    resolveSecond({ ok: true })
    await second
  })

  it('同一请求的心跳快照不解除本地提交锁', async () => {
    await publish(snapshot('child', 'perm-a'))
    useAgentStore.setState({ isSubmittingPermission: true })
    await publish(snapshot('child', 'perm-a', 8))
    expect(useAgentStore.getState().isSubmittingPermission).toBe(true)
  })

  it('不投影非后代请求，深层后代权限仍可见，已回答或终态请求不可见', async () => {
    await publish(snapshot('other', 'perm-other'))
    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
    const grandchild = snapshot('grandchild', 'perm-grandchild')
    await publish(grandchild)
    expect(useAgentStore.getState().pendingPermissionRequest?.sessionId).toBe('grandchild')
    await publish({ ...grandchild, sequence: 2, pendingInteractions: grandchild.pendingInteractions.map(i => ({ ...i, status: 'answered' })) })
    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
    await publish({ ...grandchild, sequence: 3, status: 'cancelled' })
    expect(useAgentStore.getState().pendingPermissionRequest).toBeNull()
  })
})
