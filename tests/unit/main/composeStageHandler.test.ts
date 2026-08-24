/**
 * composeStageHandler（手动阶段转换 IPC）+ sessionHandler（composeStages 透出）
 *
 * mock 掉 electron / SessionStoreHost / 主窗口引用，捕获 secureIpc 注册的监听函数，
 * 直接以「主窗口主 frame」的伪造 event 调用，断言：
 * - 合法转换返回 ok 并推送 agent:compose-stages-updated（payload 与工具事件一致）
 * - 非法转换返回中文可读 error（与 stage_transition 工具同一套 applyStageTransition 校验）
 * - load-session 的 SessionDetail 透出 composeStages
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import {
  applyStageTransition,
  createInitialStageTable,
  type ComposePlanApproval,
  type ComposeStageAction,
  type ComposeStageEntry
} from '../../../src/shared/composeLifecycle'

const mockHandle = vi.fn()
const mockSend = vi.fn()
const mockSelectSession = vi.fn()
const mockCreateSession = vi.fn(() => ({ currentSessionId: 'sess_1' }))

// 主窗口主 frame 伪造链：secureIpc 要求 event.sender === mainWindow.webContents
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

// ── 会话存储 mock：转换校验用真实 applyStageTransition，保证与工具同一口径 ──
let currentStages: ComposeStageEntry[] | null = null
let currentApproval: ComposePlanApproval | null = null
let sessionExists = true
let sessionComposeStages: ComposeStageEntry[] | undefined
let sessionMode = 'compose'
let sessionKind = 'primary'
let pendingInteractions: Array<{ type: string }> = []

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
      composeStages: sessionComposeStages
    }
  }),
  save: vi.fn(),
  getSessionsDir: () => '/tmp/test-sessions',
  getComposeStages: vi.fn(() => currentStages),
  getComposePlanApproval: vi.fn(() => currentApproval),
  approveComposePlan: vi.fn((_sessionId: string, opts: { auto: boolean }) => {
    currentApproval = { status: 'approved' as const, approvedAt: 1_000, auto: opts.auto }
    return currentApproval
  }),
  applyComposeStageTransition: vi.fn((sessionId: string, action: ComposeStageAction) => {
    if (!sessionExists || sessionId !== 'sess_1') return null
    const result = applyStageTransition(currentStages, action, 1_000)
    if (!result.ok) return { status: 'rejected' as const, error: result.error }
    const previousStages = currentStages
    currentStages = result.stages
    return {
      status: 'applied' as const,
      session: {},
      stages: result.stages,
      previousStages,
      reviewLoops: result.reviewLoops
    }
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

vi.mock('../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => ({
    inbox: { listPendingForSession: () => pendingInteractions }
  })
}))

vi.mock('../../../src/main/mainWindowRef', () => ({
  getMainWindow: () => fakeWindow
}))

vi.mock('../../../src/main/index', () => ({
  setCurrentProjectPath: vi.fn(),
  setCurrentMode: vi.fn(),
  getMainWindow: () => fakeWindow
}))

// sessionHandler 的周边依赖：本测试只关心 composeStages 透出，其余全部收口
vi.mock('../../../src/runtime/agent', () => ({
  calculateContextBreakdown: vi.fn(() => ({ payload: {} }))
}))
vi.mock('../../../src/runtime/model/config', () => ({
  loadModelConfig: vi.fn(() => null)
}))
vi.mock('../../../src/main/services/SkillServiceHost', () => ({
  getSkillService: () => ({
    getWorkspaceRoot: () => '/tmp/project',
    load: vi.fn(),
    getRegistry: () => ({ listForContext: () => [] })
  })
}))
vi.mock('../../../src/main/services/WorkspaceService', () => ({
  getWorkspaceService: () => ({
    selectSession: mockSelectSession,
    createSession: mockCreateSession
  })
}))
vi.mock('../../../src/main/services/SubagentProjectionServiceHost', () => ({
  getSubagentProjectionService: () => ({ listByParentSessionId: () => [] })
}))
vi.mock('../../../src/runtime/checkpoints/restore', () => ({ rejectFile: vi.fn() }))
vi.mock('../../../src/runtime/checkpoints/diffState', () => ({ buildMessageDiffState: vi.fn() }))
vi.mock('../../../src/runtime/checkpoints/manifest', () => ({
  readManifest: vi.fn(),
  writeManifest: vi.fn()
}))

import { registerComposeStageHandler } from '../../../src/main/ipc/composeStageHandler'
import { registerSessionHandler } from '../../../src/main/ipc/sessionHandler'

type HandlerFn = (event: IpcMainInvokeEvent, params: unknown) => Promise<unknown>

function registeredHandler(channel: string): HandlerFn {
  const call = mockHandle.mock.calls.find((c) => c[0] === channel)
  if (!call) throw new Error(`channel ${channel} 未注册`)
  return call[1] as HandlerFn
}

/** 构思已完成、计划进行中的阶段表（触发计划确认门的场景） */
function planInProgressStages(): ComposeStageEntry[] {
  const stages = createInitialStageTable()
  stages[0] = { id: 'brainstorm', status: 'completed', completedAt: 1 }
  stages[1] = { id: 'plan', status: 'in_progress' }
  return stages
}

describe('composeStageHandler（compose:apply-stage-transition）', () => {
  beforeEach(() => {
    mockHandle.mockClear()
    mockSend.mockClear()
    mockStore.applyComposeStageTransition.mockClear()
    mockStore.getComposeStages.mockClear()
    mockStore.getComposePlanApproval.mockClear()
    mockStore.approveComposePlan.mockClear()
    currentStages = null
    currentApproval = null
    sessionExists = true
    sessionMode = 'compose'
    sessionKind = 'primary'
    pendingInteractions = []
    registerComposeStageHandler()
  })

  it('合法 complete：返回 ok 与最新阶段表，并推送 agent:compose-stages-updated', async () => {
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(result).toMatchObject({ ok: true })
    const stages = (result as { ok: true; stages: ComposeStageEntry[] }).stages
    expect(stages[0]).toMatchObject({ id: 'brainstorm', status: 'completed', completedAt: 1_000 })
    expect(stages[1]).toMatchObject({ id: 'plan', status: 'in_progress' })

    // 推送 payload 与工具事件一致，renderer 阶段条只订阅这一个事件源
    expect(mockSend).toHaveBeenCalledWith('agent:compose-stages-updated', {
      sessionId: 'sess_1',
      stages,
      reviewLoops: 0
    })
  })

  it('非法转换（构思直接回退到审查）：返回中文可读 error，不推送事件', async () => {
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'return', targetStage: 'review', reason: '想跳回审查' }
    })

    expect(result).toEqual({ ok: false, error: '只能回退到当前进行中阶段之前的阶段' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('跳过无原因：返回中文 error', async () => {
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'skip', reason: '   ' }
    })

    expect(result).toEqual({ ok: false, error: '跳过阶段必须提供原因' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('会话不存在：返回 error', async () => {
    sessionExists = false
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(result).toEqual({ ok: false, error: '会话不存在或已被删除' })
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('非 compose 会话：边界拒绝，不建表、不进存储层', async () => {
    sessionMode = 'default'
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(result).toEqual({ ok: false, error: '仅 compose 主会话支持调整生命周期阶段' })
    expect(mockStore.applyComposeStageTransition).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalled()
  })

  it('子代理会话：边界拒绝（阶段表只属于主会话）', async () => {
    sessionKind = 'subagent'
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(result).toEqual({ ok: false, error: '仅 compose 主会话支持调整生命周期阶段' })
    expect(mockStore.applyComposeStageTransition).not.toHaveBeenCalled()
  })

  it('action 形状非法（未知 type / 缺字段）：边界拒绝，不进存储层', async () => {
    const handler = registeredHandler('compose:apply-stage-transition')

    const badType = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'teleport' }
    })
    expect(badType).toEqual({ ok: false, error: '非法的阶段操作' })

    const badReturn = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'return', targetStage: 'not-a-stage', reason: 'x' }
    })
    expect(badReturn).toEqual({ ok: false, error: '非法的阶段操作' })

    expect(mockStore.applyComposeStageTransition).not.toHaveBeenCalled()
  })

  it('已有阶段表上合法 skip：原因写入 note 并推送', async () => {
    currentStages = createInitialStageTable()
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'skip', reason: '需求已澄清，无需构思' }
    })

    expect(result).toMatchObject({ ok: true })
    const stages = (result as { ok: true; stages: ComposeStageEntry[] }).stages
    expect(stages[0]).toMatchObject({ status: 'skipped', note: '需求已澄清，无需构思' })
    expect(mockSend).toHaveBeenCalledWith('agent:compose-stages-updated', {
      sessionId: 'sess_1',
      stages,
      reviewLoops: 0
    })
  })

  it('活动计划 waiter 存在时手动阶段操作不得绕过审批卡', async () => {
    currentStages = planInProgressStages()
    pendingInteractions = [{ type: 'planApproval' }]
    const handler = registeredHandler('compose:apply-stage-transition')
    const complete = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })
    const skip = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'skip', reason: '绕过审批' }
    })

    expect(complete).toEqual({ ok: false, error: '当前计划正在等待审批，请在计划审批卡中处理。' })
    expect(skip).toEqual({ ok: false, error: '当前计划正在等待审批，请在计划审批卡中处理。' })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
    expect(mockStore.applyComposeStageTransition).not.toHaveBeenCalled()
  })

  it('存在其他 pending 交互时手动阶段操作不得推进', async () => {
    currentStages = planInProgressStages()
    pendingInteractions = [{ type: 'permission' }]
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(result).toEqual({ ok: false, error: '当前会话仍有未处理的交互请求，无法手动推进阶段。' })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
    expect(mockStore.applyComposeStageTransition).not.toHaveBeenCalled()
  })

  it('手动完成计划阶段：未批准时写批准留痕（auto:false）并推送批准事件，随后正常推进', async () => {
    currentStages = planInProgressStages()
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(mockStore.approveComposePlan).toHaveBeenCalledWith('sess_1', { auto: false })
    expect(mockSend).toHaveBeenCalledWith('agent:compose-plan-approval-updated', {
      sessionId: 'sess_1',
      approval: { status: 'approved', approvedAt: 1_000, auto: false }
    })
    const stages = (result as { ok: true; stages: ComposeStageEntry[] }).stages
    expect(stages[1]).toMatchObject({ id: 'plan', status: 'completed' })
    expect(stages[2]).toMatchObject({ id: 'implement', status: 'in_progress' })
  })

  it('计划已批准时手动 complete 不再重复写批准', async () => {
    currentStages = planInProgressStages()
    currentApproval = { status: 'approved', approvedAt: 1, auto: false }
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(result).toMatchObject({ ok: true })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalledWith('agent:compose-plan-approval-updated', expect.anything())
  })

  it('手动跳过计划阶段：不写批准留痕（跳过即放弃审批流，与工具语义一致）', async () => {
    currentStages = planInProgressStages()
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'skip', reason: '需求简单，直接开发' }
    })

    expect(result).toMatchObject({ ok: true })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalledWith('agent:compose-plan-approval-updated', expect.anything())
    const stages = (result as { ok: true; stages: ComposeStageEntry[] }).stages
    expect(stages[1]).toMatchObject({ id: 'plan', status: 'skipped' })
  })

  it('非计划阶段（构思进行中）complete 不触碰批准状态', async () => {
    currentStages = createInitialStageTable()
    const handler = registeredHandler('compose:apply-stage-transition')
    const result = await handler(makeTrustedEvent(), {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })

    expect(result).toMatchObject({ ok: true })
    expect(mockStore.approveComposePlan).not.toHaveBeenCalled()
    expect(mockSend).not.toHaveBeenCalledWith('agent:compose-plan-approval-updated', expect.anything())
  })
})

describe('sessionHandler（load-session 透出 composeStages）', () => {
  beforeEach(() => {
    mockHandle.mockClear()
    mockSend.mockClear()
    mockSelectSession.mockClear()
    mockCreateSession.mockClear()
    sessionExists = true
    sessionComposeStages = undefined
    registerSessionHandler()
  })

  it('会话详情透出持久化的 compose 阶段表', async () => {
    sessionComposeStages = createInitialStageTable()
    const handler = registeredHandler('load-session')
    const detail = await handler(makeTrustedEvent(), { sessionId: 'sess_1' }) as {
      id: string
      composeStages?: ComposeStageEntry[]
    }

    expect(detail.id).toBe('sess_1')
    expect(detail.composeStages).toEqual(sessionComposeStages)
    expect(mockSelectSession).toHaveBeenCalledWith('sess_1')
  })

  it('旧会话无 composeStages 字段时透出 undefined，由 renderer 按初始表投影', async () => {
    sessionComposeStages = undefined
    const handler = registeredHandler('load-session')
    const detail = await handler(makeTrustedEvent(), { sessionId: 'sess_1' }) as {
      composeStages?: ComposeStageEntry[]
    }

    expect(detail.composeStages).toBeUndefined()
  })

  it('创建会话经过 WorkspaceService 并保持默认模式语义', async () => {
    const handler = registeredHandler('create-session')
    const detail = await handler(makeTrustedEvent(), {
      workspaceRoot: '/tmp/project'
    }) as { id: string }

    expect(detail.id).toBe('sess_1')
    expect(mockCreateSession).toHaveBeenCalledWith({
      workspaceRoot: '/tmp/project',
      mode: 'default'
    })
  })
})
