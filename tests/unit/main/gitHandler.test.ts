/**
 * gitHandler：参数校验与 workspace-busy 守卫。
 *
 * mock electron / 主窗口引用 / WorkspaceService / agent 状态，捕获 secureIpc 注册的
 * 监听函数并以可信伪造 event 直接调用。Git 真源由 gitService 单测覆盖，这里只保护
 * 「目录校验 fail-closed」「同工作区有会话运行时不执行分支变更」两条边界。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { IpcMainInvokeEvent } from 'electron'

const { mockState, handlers, fakeMainFrame, fakeWebContents, fakeWindow } = vi.hoisted(() => {
  const fakeMainFrame = {}
  const fakeWebContents = {
    isDestroyed: () => false,
    send: () => {},
    mainFrame: fakeMainFrame
  }
  const fakeWindow = { isDestroyed: () => false, webContents: fakeWebContents }
  return {
    mockState: {
      sessions: [] as Array<{ id: string; workspaceRoot: string }>,
      busyIds: new Set<string>()
    },
    handlers: new Map<string, (event: IpcMainInvokeEvent, params: unknown) => unknown>(),
    fakeMainFrame,
    fakeWebContents,
    fakeWindow
  }
})

/** 主窗口主 frame 的可信事件（与 secureIpc 的校验口径一致） */
function makeTrustedEvent(): IpcMainInvokeEvent {
  return { sender: fakeWebContents, senderFrame: fakeMainFrame } as unknown as IpcMainInvokeEvent
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nova-test' },
  ipcMain: {
    handle: (channel: string, listener: (event: IpcMainInvokeEvent, params: unknown) => unknown) => {
      handlers.set(channel, listener)
    }
  }
}))

vi.mock('../../../src/main/mainWindowRef', () => ({
  getMainWindow: () => fakeWindow
}))

vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({
    getState: () => ({ availableSessions: mockState.sessions })
  })
}))

vi.mock('../../../src/main/agent/state', () => ({
  isSessionTurnInProgress: (sessionId: string) => mockState.busyIds.has(sessionId)
}))

import { registerGitHandler } from '../../../src/main/ipc/gitHandler'

describe('gitHandler 守卫', () => {
  let workspaceDir: string

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), 'nova-git-handler-'))
    mockState.sessions = []
    mockState.busyIds = new Set()
    handlers.clear()
    registerGitHandler()
  })

  it('工作区路径缺失或不存在时拒绝（fail-closed）', async () => {
    const switchHandler = handlers.get('git:switch-branch')!
    await expect(switchHandler(makeTrustedEvent(), { workspaceRoot: '' })).rejects.toThrow(
      '缺少工作区路径'
    )
    await expect(
      switchHandler(makeTrustedEvent(), { workspaceRoot: join(workspaceDir, 'missing') })
    ).rejects.toThrow('工作区目录不存在或不可访问')

    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('同工作区有会话运行时返回 workspace-busy，且不执行分支变更', async () => {
    mockState.sessions = [
      { id: 's1', workspaceRoot: workspaceDir },
      { id: 's2', workspaceRoot: '/other/ws' }
    ]
    mockState.busyIds = new Set(['s1'])

    const switchHandler = handlers.get('git:switch-branch')!
    const result = await switchHandler(makeTrustedEvent(), {
      workspaceRoot: workspaceDir,
      branchName: 'main'
    })
    expect(result).toEqual({ ok: false, issue: { code: 'workspace-busy' } })

    const createHandler = handlers.get('git:create-branch')!
    const createResult = await createHandler(makeTrustedEvent(), {
      workspaceRoot: workspaceDir,
      branchName: 'feature/x'
    })
    expect(createResult).toEqual({ ok: false, issue: { code: 'workspace-busy' } })

    rmSync(workspaceDir, { recursive: true, force: true })
  })

  it('其他工作区的忙碌会话不阻塞当前目录', async () => {
    mockState.sessions = [{ id: 's2', workspaceRoot: '/other/ws' }]
    mockState.busyIds = new Set(['s2'])

    // 非仓库目录：守卫放行后由 gitService 判定 not-a-repository，而不是 workspace-busy
    const switchHandler = handlers.get('git:switch-branch')!
    const result = (await switchHandler(makeTrustedEvent(), {
      workspaceRoot: workspaceDir,
      branchName: 'main'
    })) as { ok: boolean; issue?: { code: string } }
    expect(result.ok).toBe(false)
    expect(result.issue?.code).toBe('not-a-repository')

    rmSync(workspaceDir, { recursive: true, force: true })
  })
})
