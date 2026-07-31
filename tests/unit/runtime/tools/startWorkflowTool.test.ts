import { describe, expect, it, vi } from 'vitest'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { createStartWorkflowTool } from '../../../../src/runtime/tools/startWorkflow'
import type { ToolContext } from '../../../../src/runtime/tools/types'

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: 'D:/workspace',
    workspaceRoot: 'D:/workspace',
    readState: createReadState(),
    eventBus: new EventBus(),
    modelClient: {} as ToolContext['modelClient'],
    resolveTool: vi.fn(),
    sessionId: 'session-1',
    autoMode: true,
    mode: 'compose',
    abortSignal: new AbortController().signal,
    assertExecutionCurrent: () => true,
    ...overrides
  }
}

describe('start_workflow tool', () => {
  it('校验参数后只委托 orchestrator，并透传宿主能力与 Auto 快照', async () => {
    const start = vi.fn(async () => ({
      status: 'completed' as const,
      runId: 'wf-1',
      summary: '完成摘要'
    }))
    const tool = createStartWorkflowTool({
      getOrchestrator: () => ({ start } as never),
      getPermissionBridge: () => ({ } as never),
      resolveSkill: vi.fn()
    })
    const ctx = context()

    const result = await tool.execute({
      workflow: 'compose',
      startStage: 'plan',
      reason: '实现登录功能'
    }, ctx)

    expect(result).toEqual({ success: true, output: '完成摘要' })
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'compose',
      startStage: 'plan',
      request: '实现登录功能',
      autoMode: true,
      abortSignal: ctx.abortSignal,
      host: expect.objectContaining({
        workspaceRoot: 'D:/workspace',
        sessionId: 'session-1',
        eventBus: ctx.eventBus,
        modelClient: ctx.modelClient,
        resolveTool: ctx.resolveTool,
        assertExecutionCurrent: ctx.assertExecutionCurrent
      })
    }))
  })

  it('缺少 workflow、startStage 或 reason 时拒绝，不启动 orchestrator', async () => {
    const start = vi.fn()
    const tool = createStartWorkflowTool({ getOrchestrator: () => ({ start } as never) })

    for (const args of [
      { startStage: 'plan', reason: 'x' },
      { workflow: 'compose', reason: 'x' },
      { workflow: 'compose', startStage: 'plan' }
    ]) {
      const result = await tool.execute(args, context())
      expect(result.success).toBe(false)
    }
    expect(start).not.toHaveBeenCalled()
  })

  it('orchestrator 失败或取消时返回失败结果', async () => {
    const failedTool = createStartWorkflowTool({
      getOrchestrator: () => ({
        start: vi.fn(async () => ({ status: 'failed' as const, runId: 'wf-1', error: '失败原因' }))
      } as never)
    })
    await expect(
      failedTool.execute({ workflow: 'compose', startStage: 'plan', reason: 'x' }, context())
    ).resolves.toEqual({ success: false, output: '', error: '失败原因' })

    const cancelledTool = createStartWorkflowTool({
      getOrchestrator: () => ({
        start: vi.fn(async () => ({ status: 'cancelled' as const, runId: 'wf-1' }))
      } as never)
    })
    const result = await cancelledTool.execute(
      { workflow: 'compose', startStage: 'plan', reason: 'x' },
      context()
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('已取消')
  })
})

