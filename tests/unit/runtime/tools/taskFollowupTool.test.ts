import { describe, expect, it, vi } from 'vitest'
import { createTaskFollowupTool } from '../../../../src/runtime/tools/task_followup'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { SpawnSubagentPort } from '../../../../src/runtime/subagents'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const invocationRef = {
  sessionId: 'sess-parent',
  runId: 'run-parent',
  messageId: 'msg-parent',
  toolCallId: 'call-followup'
} as const

function context(abortSignal?: AbortSignal): ToolContext {
  return {
    workingDir: process.cwd(),
    workspaceRoot: process.cwd(),
    runId: invocationRef.runId,
    resourceOwnerRunId: invocationRef.runId,
    readState: createReadState(),
    invocationRef,
    ...(abortSignal ? { abortSignal } : {})
  }
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    childSessionId: 'sess_sub_5678',
    childRunId: 'run-child-99',
    status: 'completed' as const,
    summary: 'continued evidence',
    artifactIds: [],
    startedAt: 1,
    completedAt: 2,
    ...overrides
  }
}

function setup() {
  const followup = vi.fn(async () => result())
  const port = { followup } as SpawnSubagentPort
  return {
    followup,
    tool: createTaskFollowupTool({ getSpawnSubagentPort: () => port })
  }
}

describe('task_followup tool', () => {
  it('保持工具名、schema 严格性与串行执行契约', () => {
    const { tool } = setup()
    expect(tool.name).toBe('task_followup')
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        child_session_id: {
          type: 'string',
          description: '既有子代理的会话 ID，来自此前 task / batch_task 结果'
        },
        task: { type: 'string', description: '追加指令：说明要继续、纠正或追问什么' }
      },
      required: ['child_session_id', 'task'],
      additionalProperties: false
    })
    expect(tool.executionMode).toBe('sequential')
  })

  it('拒绝未知字段与 trim 后为空的必填值', async () => {
    const { tool, followup } = setup()
    expect((await tool.execute(
      { child_session_id: 'sess', task: 'go', extra: 1 } as Record<string, unknown>,
      context()
    )).error).toContain('未知字段')
    expect((await tool.execute({ child_session_id: '', task: 'go' }, context())).error).toContain('子会话 ID')
    expect((await tool.execute({ child_session_id: '   ', task: 'go' }, context())).error).toContain('子会话 ID')
    expect((await tool.execute({ child_session_id: 'sess', task: '' }, context())).error).toContain('追加指令')
    expect((await tool.execute({ child_session_id: 'sess', task: '  ' }, context())).error).toContain('追加指令')
    expect(followup).not.toHaveBeenCalled()
  })

  it('缺少 durable 调用身份或执行服务未装配时 fail closed', async () => {
    const { tool } = setup()
    const withoutRef = await tool.execute(
      { child_session_id: 'sess', task: 'go' },
      { workingDir: process.cwd(), readState: createReadState() }
    )
    expect(withoutRef.success).toBe(false)
    expect(withoutRef.error).toContain('durable')

    const unavailable = createTaskFollowupTool({ getSpawnSubagentPort: () => undefined })
    const noPort = await unavailable.execute(
      { child_session_id: 'sess', task: 'go' },
      context()
    )
    expect(noPort.success).toBe(false)
    expect(noPort.error).toContain('尚未装配')
  })

  it('用完整 invocationRef 构造 followup 命令并透传 abortSignal', async () => {
    const { tool, followup } = setup()
    const controller = new AbortController()

    const output = await tool.execute(
      { child_session_id: 'sess_sub_5678', task: 'keep digging' },
      context(controller.signal)
    )

    expect(followup).toHaveBeenCalledTimes(1)
    expect(followup).toHaveBeenCalledWith(
      {
        parentSessionId: invocationRef.sessionId,
        parentRunId: invocationRef.runId,
        previousChildSessionId: 'sess_sub_5678',
        parentMessageId: invocationRef.messageId,
        parentToolCallId: invocationRef.toolCallId,
        task: 'keep digging'
      },
      { invocationRef, abortSignal: controller.signal }
    )
    expect(output).toEqual({
      success: true,
      output: '[子代理续跑 / 会话 sess_sub_5678 / run run-child-99]\ncontinued evidence'
    })
  })

  it('失败结果保留摘要文本并返回失败语义与 error 文案', async () => {
    const failed = vi.fn(async () => result({
      status: 'failed',
      summary: 'partial evidence',
      failure: { code: 'tool', message: 'tool failed' }
    }))
    const failedTool = createTaskFollowupTool({
      getSpawnSubagentPort: () => ({ followup: failed } as SpawnSubagentPort)
    })

    const output = await failedTool.execute(
      { child_session_id: 'sess_sub_5678', task: 'retry' },
      context()
    )

    expect(output.success).toBe(false)
    expect(output.output).toBe('[子代理续跑 / 会话 sess_sub_5678 / run run-child-99]\npartial evidence')
    expect(output.error).toBe('tool failed')
  })

  it.each([
    {
      status: 'incomplete' as const,
      incompleteReason: 'max_rounds' as const,
      expectedError: '子代理未完成任务（已达工具轮数上限）'
    },
    { status: 'cancelled' as const, expectedError: '子代理执行已取消' },
    { status: 'interrupted' as const, expectedError: '子代理执行已中断' }
  ])('非 completed 状态 %s 输出同构表头与状态文案', async ({ status, incompleteReason, expectedError }) => {
    const followup = vi.fn(async () => result({ status, summary: 'partial', incompleteReason }))
    const tool = createTaskFollowupTool({
      getSpawnSubagentPort: () => ({ followup } as SpawnSubagentPort)
    })

    const output = await tool.execute(
      { child_session_id: 'sess_sub_5678', task: 'continue' },
      context()
    )

    expect(output.success).toBe(false)
    expect(output.output).toContain('[子代理续跑 / 会话 sess_sub_5678 / run run-child-99]')
    expect(output.output).toContain('partial')
    expect(output.error).toBe(expectedError)
  })

  it('执行服务抛错时 catch 为 failure', async () => {
    const followup = vi.fn(async () => {
      throw new Error('子会话正忙')
    })
    const tool = createTaskFollowupTool({
      getSpawnSubagentPort: () => ({ followup } as SpawnSubagentPort)
    })

    const output = await tool.execute(
      { child_session_id: 'sess_sub_5678', task: 'go' },
      context()
    )

    expect(output).toEqual({ success: false, output: '', error: '子会话正忙' })
  })
})
