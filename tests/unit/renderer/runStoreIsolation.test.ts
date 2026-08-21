/**
 * 护栏：Renderer RunStore 必须按 runId 隔离，禁止跨会话覆盖。
 *
 * 当前缺陷：单一 snapshot/lastSequence 接收所有 run 广播。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

const mockInvoke = vi.fn()

beforeEach(() => {
  global.window = {
    ...global.window,
    api: {
      invoke: mockInvoke,
      on: vi.fn(),
      removeAllListeners: vi.fn()
    }
  } as unknown as Window & typeof globalThis
  mockInvoke.mockResolvedValue({ snapshot: null, waitingSessions: [] })
})

function makeSnap(
  runId: string,
  sessionId: string,
  sequence: number,
  status: 'running' | 'completed' | 'cancelled' | 'interrupted' = 'running'
) {
  return {
    runId,
    kind: 'agent' as const,
    workspaceId: '/ws',
    sessionId,
    messageId: `msg_${runId}`,
    status,
    sequence,
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

describe('Renderer 按 runId 隔离 snapshot', () => {
  beforeEach(async () => {
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    useRunStore.getState().resetForTests()
  })

  it('A/B 会话事件互不覆盖；sequence 仅在同 runId 内比较', async () => {
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const store = useRunStore.getState()

    store.handleSnapshotEvent(makeSnap('runA', 'sessA', 1), {
      sequence: 1,
      type: 'running',
      at: Date.now()
    })
    store.handleSnapshotEvent(makeSnap('runB', 'sessB', 1), {
      sequence: 1,
      type: 'running',
      at: Date.now()
    })

    const state = useRunStore.getState() as {
      snapshotsByRunId?: Record<string, { runId: string; sessionId: string; sequence: number }>
      lastSequenceByRunId?: Record<string, number>
      snapshot?: { runId: string } | null
    }

    // 契约：必须按 runId 分桶，不能只剩最后一个 snapshot
    expect(state.snapshotsByRunId).toBeDefined()
    expect(state.snapshotsByRunId!['runA']?.sessionId).toBe('sessA')
    expect(state.snapshotsByRunId!['runB']?.sessionId).toBe('sessB')
    expect(state.lastSequenceByRunId!['runA']).toBe(1)
    expect(state.lastSequenceByRunId!['runB']).toBe(1)

    // 同 sequence 的不同 run 都能保留
    store.handleSnapshotEvent(makeSnap('runA', 'sessA', 2, 'completed'), {
      sequence: 2,
      type: 'terminal',
      at: Date.now()
    })
    const after = useRunStore.getState() as typeof state
    expect(after.snapshotsByRunId!['runA']?.sequence).toBe(2)
    expect(after.snapshotsByRunId!['runB']?.sequence).toBe(1)
  })

  it('pullSnapshot 旧请求晚到不得覆盖新会话（pullToken）', async () => {
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')

    let resolveA!: (v: unknown) => void
    const promiseA = new Promise((r) => {
      resolveA = r
    })

    mockInvoke.mockImplementation(async (channel: string, params?: { sessionId?: string }) => {
      if (channel === 'run:get-snapshot') {
        if (params?.sessionId === 'sessA') {
          await promiseA
          return { snapshot: makeSnap('runA', 'sessA', 9), waitingSessions: [] }
        }
        return { snapshot: makeSnap('runB', 'sessB', 1), waitingSessions: [] }
      }
      if (channel === 'run:list-waiting') return []
      return null
    })

    const pullA = useRunStore.getState().pullSnapshot('sessA')
    await useRunStore.getState().pullSnapshot('sessB')

    // B 已就位后，A 的旧响应才到达
    resolveA(undefined)
    await pullA

    const state = useRunStore.getState() as {
      snapshotsByRunId?: Record<string, { sessionId: string }>
      selectedSessionId?: string | null
      activeRunIdBySessionId?: Record<string, string>
      snapshot?: { sessionId: string } | null
    }

    expect(state.snapshotsByRunId).toBeDefined()
    expect(state.snapshotsByRunId!['runB']?.sessionId).toBe('sessB')
    // 当前选择器若指向 B，展示不得被 A 覆盖
    if (state.selectedSessionId === 'sessB' || state.activeRunIdBySessionId?.['sessB']) {
      expect(state.activeRunIdBySessionId!['sessB']).toBe('runB')
    }
    // A 的事实仍保留在分桶中，但不得抹掉 B
    expect(state.snapshotsByRunId!['runA']?.sessionId).toBe('sessA')
  })

  it('活动 runId 尚未投影时，当前会话终态 snapshot 仍能结束 cancelling', async () => {
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const { useChatStore, resetChatStoreForTests } = await import('../../../src/renderer/stores/useChatStore')
    resetChatStoreForTests()
    useChatStore.setState({
      currentSessionId: 'sessA',
      isGenerating: true,
      currentGeneratingMessageId: 'msg_runA'
    })

    useRunStore.getState().beginLocalCancel(null)
    expect(useRunStore.getState().cancelling).toBe(true)

    useRunStore.getState().handleSnapshotEvent(makeSnap('runA', 'sessA', 2, 'cancelled'), {
      sequence: 2,
      type: 'cancelled',
      at: Date.now()
    })

    await vi.waitFor(() => {
      expect(useRunStore.getState().cancelling).toBe(false)
      expect(useChatStore.getState().isGenerating).toBe(false)
    })

    useRunStore.getState().beginLocalCancel('runA')
    expect(useRunStore.getState().cancelling).toBe(false)
  })

  it('pull 到其他会话的终态不提前清空取消；本会话终态才收敛', async () => {
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const { useChatStore, resetChatStoreForTests } = await import('../../../src/renderer/stores/useChatStore')
    resetChatStoreForTests()
    useChatStore.setState({ currentSessionId: 'sessA' })
    useRunStore.setState({ selectedSessionId: 'sessA' })

    useRunStore.getState().beginLocalCancel(null)
    expect(useRunStore.getState().cancelling).toBe(true)
    expect(useRunStore.getState().cancellingSessionId).toBe('sessA')

    // B 的 pull 返回 B 的终态 run：不得提前清空 A 的取消
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') {
        return { snapshot: makeSnap('runB', 'sessB', 9, 'completed'), waitingSessions: [] }
      }
      return { snapshot: null, waitingSessions: [] }
    })
    await useRunStore.getState().pullSnapshot('sessB')
    expect(useRunStore.getState().cancelling).toBe(true)

    // A 的 pull 返回 A 的取消终态：取消收敛
    mockInvoke.mockImplementation(async (channel: string) => {
      if (channel === 'run:get-snapshot') {
        return { snapshot: makeSnap('runA', 'sessA', 9, 'cancelled'), waitingSessions: [] }
      }
      return { snapshot: null, waitingSessions: [] }
    })
    await useRunStore.getState().pullSnapshot('sessA')
    expect(useRunStore.getState().cancelling).toBe(false)
    expect(useRunStore.getState().cancellingSessionId).toBeNull()
  })

  it('interrupted 归属会话：跨会话事件不覆盖，run 离开 interrupted 后清理', async () => {
    const { useRunStore } = await import('../../../src/renderer/stores/useRunStore')
    const store = useRunStore.getState()

    store.handleSnapshotEvent(makeSnap('runA', 'sessA', 1, 'interrupted'), {
      sequence: 1,
      type: 'interrupted',
      at: Date.now()
    })
    expect(useRunStore.getState().interruptedRunId).toBe('runA')
    expect(useRunStore.getState().interruptedSessionId).toBe('sessA')

    // B 的普通运行事件不动 A 的中断横幅归属
    store.handleSnapshotEvent(makeSnap('runB', 'sessB', 1), {
      sequence: 1,
      type: 'running',
      at: Date.now()
    })
    expect(useRunStore.getState().interruptedRunId).toBe('runA')
    expect(useRunStore.getState().interruptedSessionId).toBe('sessA')

    // runA 离开 interrupted（恢复/完成）→ 横幅连同归属一起清理
    store.handleSnapshotEvent(makeSnap('runA', 'sessA', 2, 'completed'), {
      sequence: 2,
      type: 'terminal',
      at: Date.now()
    })
    expect(useRunStore.getState().interruptedRunId).toBeNull()
    expect(useRunStore.getState().interruptedSessionId).toBeNull()
  })
})
