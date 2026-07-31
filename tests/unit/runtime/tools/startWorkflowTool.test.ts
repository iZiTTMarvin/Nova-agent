import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
      getPermissionBridge: () => ({ } as never)
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

  it('有可读取 active plan 时把只读正文注入 plan 阶段上下文', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-start-workflow-plan-'))
    try {
      const planPath = '.nova/plans/current.md'
      mkdirSync(join(root, '.nova', 'plans'), { recursive: true })
      writeFileSync(join(root, planPath), '# 当前计划\n\n- 完成入口\n', 'utf-8')
      const start = vi.fn(async () => ({
        status: 'completed' as const,
        runId: 'wf-plan',
        summary: '完成'
      }))
      const tool = createStartWorkflowTool({ getOrchestrator: () => ({ start } as never) })
      const ctx = context({
        workingDir: root,
        workspaceRoot: root,
        sessionStore: {
          load: () => ({
            workspaceRoot: root,
            activePlan: { path: planPath, title: '当前计划', updatedAt: Date.now() }
          })
        } as ToolContext['sessionStore']
      })

      await tool.execute({ workflow: 'compose', startStage: 'plan', reason: '继续实施' }, ctx)

      expect(start).toHaveBeenCalledWith(expect.objectContaining({
        injectedContext: {
          activePlan: {
            path: planPath,
            title: '当前计划',
            content: '# 当前计划\n\n- 完成入口\n'
          }
        }
      }))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('传入 runId 时把恢复标识交给同一个 orchestrator 主路径', async () => {
    const start = vi.fn(async () => ({
      status: 'completed' as const,
      runId: 'wf-resume',
      summary: '恢复完成'
    }))
    const tool = createStartWorkflowTool({ getOrchestrator: () => ({ start } as never) })

    await tool.execute(
      {
        workflow: 'compose',
        startStage: 'brainstorm',
        reason: '继续原编排',
        runId: 'wf-resume'
      },
      context()
    )

    expect(start).toHaveBeenCalledWith(expect.objectContaining({ runId: 'wf-resume' }))
  })

  it('orchestrator 失败或取消时返回失败结果', async () => {
    const failedTool = createStartWorkflowTool({
      getOrchestrator: () => ({
        start: vi.fn(async () => ({ status: 'failed' as const, runId: 'wf-1', error: '失败原因' }))
      } as never)
    })
    await expect(
      failedTool.execute({ workflow: 'compose', startStage: 'plan', reason: 'x' }, context())
    ).resolves.toEqual({ success: false, output: '', error: '失败原因（runId=wf-1）' })

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
