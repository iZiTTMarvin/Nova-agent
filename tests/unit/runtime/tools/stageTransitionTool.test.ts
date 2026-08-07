import { describe, expect, it, vi } from 'vitest'
import { stageTransitionTool } from '../../../../src/runtime/tools/stageTransition'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import type { EventBus } from '../../../../src/runtime/agent/EventBus'
import type { ComposeStageEntry } from '../../../../src/shared/composeLifecycle'
import { createInitialStageTable } from '../../../../src/shared/composeLifecycle'
import type { Mode } from '../../../../src/shared/session/types'

type ApplyResult =
  | {
      status: 'applied'
      session: Record<string, unknown>
      stages: ComposeStageEntry[]
      previousStages: ComposeStageEntry[] | null
    }
  | { status: 'rejected'; error: string }
  | null

type MockSessionStore = {
  applyComposeStageTransition: (
    sessionId: string,
    action: unknown
  ) => ApplyResult
}

function createContext(opts: {
  mode?: Mode
  sessionStore?: MockSessionStore | null
  sessionId?: string | null
  eventBus?: { emit: (event: unknown) => void } | null
  applyResult?: ApplyResult
} = {}): { context: ToolContext; events: unknown[]; sessionStore: MockSessionStore } {
  const events: unknown[] = []
  const stages = createInitialStageTable()
  stages[0] = { id: 'brainstorm', status: 'completed', completedAt: 1 }
  stages[1] = { id: 'plan', status: 'in_progress' }

  const sessionStore: MockSessionStore =
    opts.sessionStore === null
      ? (undefined as unknown as MockSessionStore)
      : (opts.sessionStore ?? {
          applyComposeStageTransition: vi.fn(() =>
            opts.applyResult !== undefined
              ? opts.applyResult
              : {
                  status: 'applied' as const,
                  session: {},
                  stages,
                  previousStages: createInitialStageTable()
                }
          )
        })

  const eventBus =
    opts.eventBus === null
      ? undefined
      : (opts.eventBus ?? { emit: vi.fn((e: unknown) => events.push(e)) })

  const context: ToolContext = {
    workingDir: process.cwd(),
    mode: opts.mode,
    ...(opts.sessionStore === null ? {} : { sessionStore: sessionStore as ToolContext['sessionStore'] }),
    ...(opts.sessionId === null
      ? {}
      : { sessionId: opts.sessionId ?? 'sess_test' }),
    ...(eventBus ? { eventBus: eventBus as unknown as EventBus } : {})
  }

  return { context, events, sessionStore }
}

describe('stage_transition', () => {
  it('compose 模式 complete：调用 store、emit 事件、输出含中文阶段名', async () => {
    const { context, events, sessionStore } = createContext({ mode: 'compose' })
    const result = await stageTransitionTool.execute({ action: 'complete' }, context)

    expect(result.success).toBe(true)
    expect(sessionStore.applyComposeStageTransition).toHaveBeenCalledWith('sess_test', {
      type: 'complete'
    })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'compose_stages_updated',
      sessionId: 'sess_test'
    })
    expect(result.output).toContain('构思')
    expect(result.output).toContain('计划')
  })

  it('skip/return 参数缺失时返回中文可读原因', async () => {
    const { context } = createContext({ mode: 'compose' })

    const skipNoReason = await stageTransitionTool.execute({ action: 'skip' }, context)
    expect(skipNoReason.success).toBe(false)
    expect(skipNoReason.error).toMatch(/原因/)

    const returnNoTarget = await stageTransitionTool.execute(
      { action: 'return', reason: '返工' },
      context
    )
    expect(returnNoTarget.success).toBe(false)
    expect(returnNoTarget.error).toMatch(/targetStage/)

    const returnNoReason = await stageTransitionTool.execute(
      { action: 'return', targetStage: 'brainstorm' },
      context
    )
    expect(returnNoReason.success).toBe(false)
    expect(returnNoReason.error).toMatch(/原因/)
  })

  it('非 compose 模式在执行层拒绝', async () => {
    for (const mode of ['default', 'plan', undefined] as const) {
      const { context, sessionStore } = createContext({ mode })
      const result = await stageTransitionTool.execute({ action: 'complete' }, context)
      expect(result.success).toBe(false)
      expect(result.error).toContain('仅在 compose 模式可用')
      expect(sessionStore.applyComposeStageTransition).not.toHaveBeenCalled()
    }
  })

  it('store 返回 null / rejected 时透传失败', async () => {
    const nullStore: MockSessionStore = {
      applyComposeStageTransition: vi.fn(() => null)
    }
    const nullCtx = createContext({ mode: 'compose', sessionStore: nullStore })
    const nullResult = await stageTransitionTool.execute({ action: 'complete' }, nullCtx.context)
    expect(nullResult.success).toBe(false)
    expect(nullResult.error).toContain('会话不存在')

    const rejectedStore: MockSessionStore = {
      applyComposeStageTransition: vi.fn(() => ({
        status: 'rejected',
        error: '只能回退到当前进行中阶段之前的阶段'
      }))
    }
    const rejectedCtx = createContext({ mode: 'compose', sessionStore: rejectedStore })
    const rejected = await stageTransitionTool.execute(
      { action: 'return', targetStage: 'review', reason: '越级' },
      rejectedCtx.context
    )
    expect(rejected.success).toBe(false)
    expect(rejected.error).toBe('只能回退到当前进行中阶段之前的阶段')
  })

  it('超限回退：存储层 rejected 透传 success false 与可读原因', async () => {
    const limitStore: MockSessionStore = {
      applyComposeStageTransition: vi.fn(() => ({
        status: 'rejected',
        error: '修复-复审循环已达上限（3 次）。请向用户说明审查结论与阻塞点，停在审查阶段等待用户决定。'
      }))
    }
    const { context } = createContext({ mode: 'compose', sessionStore: limitStore })
    const result = await stageTransitionTool.execute(
      { action: 'return', targetStage: 'implement', reason: '第 4 次回退' },
      context
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('修复-复审循环已达上限')
    expect(result.error).toContain('停在审查阶段')
  })

  it('缺少 sessionStore/sessionId 时失败且可读', async () => {
    const noStore = createContext({ mode: 'compose', sessionStore: null })
    const r1 = await stageTransitionTool.execute({ action: 'complete' }, noStore.context)
    expect(r1.success).toBe(false)
    expect(r1.error).toMatch(/会话/)

    const noId = createContext({ mode: 'compose', sessionId: null })
    const r2 = await stageTransitionTool.execute({ action: 'complete' }, noId.context)
    expect(r2.success).toBe(false)
    expect(r2.error).toMatch(/会话/)
  })
})
