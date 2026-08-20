import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceState } from '../../../src/shared/workspace/types'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  ensure: vi.fn(),
  getStatus: vi.fn(),
  getDisabledStatus: vi.fn(),
  rebuild: vi.fn(),
  getDirectory: vi.fn(),
  setBroadcaster: vi.fn(),
  openPath: vi.fn()
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
    mocks.handlers.set(channel, handler)
  }
}))

vi.mock('../../../src/main/services/CodeGraphHost', () => ({
  ensureCodeGraphForWorkspace: mocks.ensure,
  getCodeGraphStatusForWorkspace: mocks.getStatus,
  getDisabledCodeGraphStatus: mocks.getDisabledStatus,
  rebuildCodeGraphForWorkspace: mocks.rebuild,
  getCodeGraphDirectoryForWorkspace: mocks.getDirectory,
  setCodeGraphStatusBroadcaster: mocks.setBroadcaster
}))

vi.mock('electron', () => ({
  shell: { openPath: mocks.openPath }
}))

import { registerCodeIndexHandler } from '../../../src/main/ipc/codeIndexHandler'

describe('codeIndexHandler', () => {
  let state: WorkspaceState
  let session: { workspaceRoot: string; codeIndexEnabled: boolean } | null

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.handlers.clear()
    state = workspaceState('C:\\repo', 'sess-a')
    session = { workspaceRoot: 'C:\\repo', codeIndexEnabled: false }
    mocks.getDisabledStatus.mockReturnValue({ enabled: false })
    mocks.getStatus.mockResolvedValue({ enabled: true })
    mocks.rebuild.mockResolvedValue(true)
    mocks.getDirectory.mockResolvedValue('C:\\data\\code-graph\\a')
    mocks.openPath.mockResolvedValue('')

    registerCodeIndexHandler(
      { getState: () => state },
      () => ({ load: () => session }),
      () => null
    )
  })

  it('关闭能力时状态查询不启动 Runtime', async () => {
    const result = await invoke('codeindex:get-status')
    expect(result).toEqual({ enabled: false })
    expect(mocks.getDisabledStatus).toHaveBeenCalledWith('C:\\repo')
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.getStatus).not.toHaveBeenCalled()
  })

  it('只使用主进程当前会话绑定的工作区执行查询与重建', async () => {
    session = { workspaceRoot: 'C:\\repo', codeIndexEnabled: true }
    await invoke('codeindex:get-status')
    const rebuilt = await invoke('codeindex:rebuild')

    expect(mocks.ensure).toHaveBeenCalledWith('C:\\repo')
    expect(mocks.getStatus).toHaveBeenCalledWith('C:\\repo')
    expect(mocks.rebuild).toHaveBeenCalledWith('C:\\repo')
    expect(rebuilt).toEqual({ accepted: true })
  })

  it('会话与当前工作区不一致时拒绝控制命令', async () => {
    session = { workspaceRoot: 'C:\\other', codeIndexEnabled: true }
    await expect(invoke('codeindex:rebuild')).rejects.toThrow('当前会话未启用代码索引')
    expect(mocks.rebuild).not.toHaveBeenCalled()
  })

  it('打开目录允许未启用会话使用当前工作区路径', async () => {
    await invoke('codeindex:open-dir')
    expect(mocks.getDirectory).toHaveBeenCalledWith('C:\\repo')
    expect(mocks.openPath).toHaveBeenCalledWith('C:\\data\\code-graph\\a')
    expect(mocks.ensure).not.toHaveBeenCalled()
  })
})

async function invoke(channel: string): Promise<unknown> {
  const handler = mocks.handlers.get(channel)
  if (!handler) throw new Error(`handler 未注册: ${channel}`)
  return handler(undefined)
}

function workspaceState(root: string | null, sessionId: string | null): WorkspaceState {
  return {
    currentSessionId: sessionId,
    currentProjectPath: root,
    currentMode: 'default',
    reasoningEffortOverride: null,
    availableSessions: [],
    messagesRevision: 0,
    tier1BranchContext: null
  }
}
