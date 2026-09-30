// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetWorkspaceStoreForTests, useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import { dispatchWorkspaceChange } from '../../../src/renderer/stores/workspaceDispatcher'
import type { WorkspaceState } from '../../../src/shared/workspace/types'

vi.mock('../../../src/renderer/stores/workspaceDispatcher', () => ({
  dispatchWorkspaceChange: vi.fn()
}))

const invoke = vi.fn()
const state: WorkspaceState = {
  currentSessionId: 'session-1', currentProjectPath: null, currentMode: 'default',
  reasoningEffortOverride: 'max', activeModelRef: { providerId: 'provider', modelEntryId: 'model' },
  availableSessions: [], messagesRevision: 0, tier1BranchContext: null, tier1StaleDiffMessageIds: []
}

function deferred() {
  let resolve!: (value: WorkspaceState) => void
  const promise = new Promise<WorkspaceState>(done => { resolve = done })
  return { promise, resolve }
}

describe('思考强度写回', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoke.mockReset()
    resetWorkspaceStoreForTests()
    useWorkspaceStore.setState({ currentSessionId: state.currentSessionId, activeModelRef: state.activeModelRef })
    Object.assign(window, { api: { invoke } })
  })

  it('绑定发起时的会话，保存失败向调用方传递错误', async () => {
    const error = new Error('write failed')
    invoke.mockRejectedValueOnce(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(useWorkspaceStore.getState().setReasoningEffortOverride('max')).rejects.toBe(error)
    expect(invoke).toHaveBeenCalledWith('workspace:set-reasoning-effort', { effort: 'max', sessionId: 'session-1' })
    expect(dispatchWorkspaceChange).not.toHaveBeenCalled()
    log.mockRestore()
  })

  it('较早的回复晚到时，不覆盖较新的提交结果', async () => {
    const first = deferred()
    const second = deferred()
    invoke.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const write = useWorkspaceStore.getState().setReasoningEffortOverride
    const firstWrite = write('max')
    const secondWrite = write(null)
    const latest = { ...state, reasoningEffortOverride: null }
    second.resolve(latest)
    await secondWrite
    first.resolve(state)
    await firstWrite
    expect(vi.mocked(dispatchWorkspaceChange).mock.calls).toEqual([[latest]])
  })

  it.each(['session', 'model'])('切换 %s 后不分发旧回复', async scope => {
    const request = deferred()
    invoke.mockReturnValueOnce(request.promise)
    const write = useWorkspaceStore.getState().setReasoningEffortOverride('max')
    useWorkspaceStore.setState(scope === 'session'
      ? { currentSessionId: 'session-2' }
      : { activeModelRef: { providerId: 'provider', modelEntryId: 'model-2' } })
    request.resolve(state)
    await write
    expect(dispatchWorkspaceChange).not.toHaveBeenCalled()
  })
})
