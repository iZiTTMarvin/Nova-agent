/**
 * composePlanApprovalHandler（compose:approve-plan）
 *
 * mock 掉 electron / SessionStoreHost / 主窗口引用，捕获 secureIpc 注册的监听函数，
 * 直接以「主窗口主 frame」的伪造 event 调用，断言：
 * - 计划阶段 + 有 active plan 时批准成功，落盘并推送 agent:compose-plan-approval-updated
 * - 非 compose 主会话、无 active plan、非计划阶段均被边界拒绝，不进入存储层写入
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { ComposeStageEntry } from '../../../src/shared/composeLifecycle'
import { createInitialStageTable } from '../../../src/shared/composeLifecycle'

const mockHandle = vi.fn()
const mockSend = vi.fn()

const fakeMainFrame = {}
const fakeWebContents = {
  isDestroyed: () => false,
  send: mockSend,
  mainFrame: fakeMainFrame
}
const fakeWindow = {
  isDestroyed: () => false,
  webContents: fakeWebContents
}

function makeTrustedEvent(): IpcMainInvokeEvent {
  return { sender: fakeWebContents, senderFrame: fakeMainFrame } as unknown as IpcMainInvokeEvent
}

let sessionExists = true
let sessionMode = 'compose'
let sessionKind = 'primary'
let sessionActivePlan: { path: string; title: string; updatedAt: number } | undefined
let sessionStages: ComposeStageEntry[] | undefined
let approveResult: { status: 'approved'; approvedAt: number; auto: boolean } | null

const mockStore = {
  load: vi.fn((sessionId: string) => {
    if (!sessionExists || sessionId !== 'sess_1') return null
    return {
      id: 'sess_1',
      workspaceRoot: '/tmp/project',
      mode: sessionMode,
      kind: sessionKind,
      createdAt: 1,
      updatedAt: 2,
      messageCount: 0,
      messages: [],
      currentLeafId: null,
      activePlan: sessionActivePlan,
      composeStages: sessionStages
    }
  }),
  getComposeStages: vi.fn((sessionId: string) => {
    if (!sessionExists || sessionId !== 'sess_1') return null
    return sessionStages ?? null
  }),
  approveComposePlan: vi.fn((sessionId: string) => {
    if (!sessionExists || sessionId !== 'sess_1') return null
    return approveResult
  })
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/nova-test' },
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) }
}))

vi.mock('../../../src/main/services/SessionStoreHost', () => ({
  initSessionStoreHost: () => mockStore,
  getSessionStore: () => mockStore
}))

vi.mock('../../../src/main/mainWindowRef', () => ({
  getMainWindow: () => fakeWindow
}))

import { registerComposePlanApprovalHandler } from '../../../src/main/ipc/composePlanApprovalHandler'

type HandlerFn = (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>

function registeredHandler(channel: string): HandlerFn {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`channel ${channel} 未注册`)
  return call[1] as HandlerFn
}

describe('composePlanApprovalHandler（compose:approve-plan）', () => {
  beforeEach(() => {
    mockHandle.mockClear()
    mockSend.mockClear()
    mockStore.approveComposePlan.mockClear()
    sessionExists = true
    sessionMode = 'compose'
    sessionKind = 'primary'
    sessionActivePlan = { path: '.nova/plans/demo.md', title: '演示计划', updatedAt: 1 }
    sessionStages = (() => {
      const stages = createInitialStageTable()
      stages[0] = { id: 'brainstorm', status: 'completed', completedAt: 1 }
      stages[1] = { id: 'plan', status: 'in_progress' }
      return stages
    })()
    approveResult = { status: 'approved', approvedAt: 1_000, auto: false }
    registerComposePlanApprovalHandler()
  })

  it('计划阶段 + 有 active plan：批准成功并推送 agent:compose-plan-approval-updated', async () => {
    const handler = registeredHandler('compose:approve-plan')
    const result = await handler(makeTrustedEvent(), { sessionId: 'sess_1' })

    expect(result).toEqual({ ok: true, approval: approveResult })
    expect(mockStore.approveComposePlan).toHaveBeenCalledWith('sess_1', { auto: false })
    expect(mockSend).toHaveBeenCalledWith('agent:compose-plan-approval-updated', {
      sessionId: 'sess_1',
      approval: approveResult
    })
  })

  it('缺少 sessionId：边界拒绝', async () => {
    const handler = registeredHandler('compose:approve-plan')
    const result = await handler(makeTrustedEvent(), {})
    expect(result).toEqual({ ok: false, error: '缺少会话 ID' })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
  })

  it('会话不存在：边界拒绝', async () => {
    sessionExists = false
    const handler = registeredHandler('compose:approve-plan')
    const result = await handler(makeTrustedEvent(), { sessionId: 'sess_1' })
    expect(result).toEqual({ ok: false, error: '会话不存在或已被删除' })
  })

  it('非 compose 主会话：边界拒绝，不进入存储层', async () => {
    sessionMode = 'default'
    const handler = registeredHandler('compose:approve-plan')
    const result = await handler(makeTrustedEvent(), { sessionId: 'sess_1' })
    expect(result).toEqual({ ok: false, error: '仅 compose 主会话可批准计划' })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
  })

  it('子代理会话：边界拒绝', async () => {
    sessionKind = 'subagent'
    const handler = registeredHandler('compose:approve-plan')
    const result = await handler(makeTrustedEvent(), { sessionId: 'sess_1' })
    expect(result).toEqual({ ok: false, error: '仅 compose 主会话可批准计划' })
  })

  it('尚无 active plan：边界拒绝', async () => {
    sessionActivePlan = undefined
    const handler = registeredHandler('compose:approve-plan')
    const result = await handler(makeTrustedEvent(), { sessionId: 'sess_1' })
    expect(result).toEqual({ ok: false, error: '当前会话尚无可批准的计划' })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
  })

  it('当前阶段不是计划：边界拒绝', async () => {
    sessionStages = (() => {
      const stages = createInitialStageTable()
      stages[0] = { id: 'brainstorm', status: 'completed', completedAt: 1 }
      stages[1] = { id: 'plan', status: 'completed', completedAt: 2 }
      stages[2] = { id: 'implement', status: 'in_progress' }
      return stages
    })()
    const handler = registeredHandler('compose:approve-plan')
    const result = await handler(makeTrustedEvent(), { sessionId: 'sess_1' })
    expect(result).toEqual({ ok: false, error: '仅计划阶段可批准计划' })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
  })
})
