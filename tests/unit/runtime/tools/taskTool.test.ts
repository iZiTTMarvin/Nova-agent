import { describe, expect, it, vi } from 'vitest'
import { createTaskTool } from '../../../../src/runtime/tools/task'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { SpawnSubagentPort } from '../../../../src/runtime/subagents'
import type { ToolContext } from '../../../../src/runtime/tools/types'

const invocationRef = {
  sessionId: 'sess-parent',
  runId: 'run-parent',
  messageId: 'msg-parent',
  toolCallId: 'call-task'
} as const

function context(signal?: AbortSignal): ToolContext {
  return {
    workingDir: process.cwd(),
    workspaceRoot: process.cwd(),
    runId: invocationRef.runId,
    resourceOwnerRunId: invocationRef.runId,
    readState: createReadState(),
    invocationRef,
    ...(signal ? { abortSignal: signal } : {})
  }
}

function result(overrides: Record<string, unknown> = {}) {
  return {
    childSessionId: 'sess_sub_1234',
    childRunId: '11111111-2222-3333-4444-555555555555',
    status: 'completed' as const,
    summary: 'found todos',
    artifactIds: [],
    startedAt: 1,
    completedAt: 2,
    ...overrides
  }
}

function setup(port?: SpawnSubagentPort) {
  const spawn = vi.fn(async () => result())
  const resolvedPort = port ?? ({ spawn } as SpawnSubagentPort)
  return {
    spawn,
    tool: createTaskTool({ getSpawnSubagentPort: () => resolvedPort })
  }
}

describe('task tool spawn adapter', () => {
  it('保持工具名、描述、schema 与串行执行契约', () => {
    const { tool } = setup()
    expect(tool.name).toBe('task')
    expect(tool.description).toBe(
      '启动子代理完成子任务。子代理在干净上下文中运行，结果以摘要形式返回。优先用 explore/code/review 匹配专业任务，general-purpose 仅用于不适合纯探索/编码/审查的混合任务。'
    )
    expect(tool.parameters).toEqual({
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: '子代理类型，如 explore / code / review / general-purpose' },
        task: { type: 'string', description: '子任务描述' },
        model: {
          type: 'object',
          description: '可选 canonical 模型覆盖，仅改变模型路由，不改变 profile prompt/工具/权限/isolation',
          properties: {
            providerId: { type: 'string', description: '目标 providerId' },
            modelEntryId: { type: 'string', description: '目标 modelEntryId' }
          },
          required: ['providerId', 'modelEntryId'],
          additionalProperties: false
        },
        reasoningEffort: {
          type: 'string',
          description: '可选思考强度覆盖（auto/low/medium/high/max），仅改变推理强度',
          enum: ['auto', 'low', 'medium', 'high', 'max']
        }
      },
      required: ['subagent_type', 'task'],
      additionalProperties: false
    })
    expect(tool.executionMode).toBe('sequential')
  })

  it('用完整 invocationRef 构造 task_tool origin 并提交 spawn 命令', async () => {
    const { tool, spawn } = setup()
    const executionContext = context()

    const output = await tool.execute(
      { subagent_type: 'explore', task: 'find TODOs' },
      executionContext
    )

    expect(spawn).toHaveBeenCalledWith(
      {
        parentSessionId: invocationRef.sessionId,
        parentRunId: invocationRef.runId,
        invocation: {
          kind: 'task_tool',
          parentMessageId: invocationRef.messageId,
          parentToolCallId: invocationRef.toolCallId
        },
        profileId: 'explore',
        task: 'find TODOs',
        workingDirectory: process.cwd(),
        isolation: 'readonly'
      },
      { invocationRef }
    )
    expect(output).toEqual({
      success: true,
      output:
        '[子代理 explore / 11111111-2222-3333-4444-555555555555]\nfound todos'
    })
  })

  it('code 与自定义 profile 默认沿 shared isolation，权限上限由服务校验', async () => {
    const { tool, spawn } = setup()
    await tool.execute({ subagent_type: 'code', task: 'edit file' }, context())
    await tool.execute({ subagent_type: 'custom', task: 'inspect' }, context())

    expect(spawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ isolation: 'shared' })
    )
    expect(spawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ isolation: 'shared' })
    )
  })

  it('父 abortSignal 原样传给执行服务', async () => {
    const controller = new AbortController()
    const { tool, spawn } = setup()
    await tool.execute({ subagent_type: 'explore', task: 'wait' }, context(controller.signal))
    expect(spawn.mock.calls[0]?.[1]).toEqual({
      invocationRef,
      abortSignal: controller.signal
    })
  })

  it('失败结果仍保留兼容的父模型文本，同时返回失败语义', async () => {
    const spawn = vi.fn(async () => result({
      status: 'failed',
      summary: 'partial evidence',
      failure: { code: 'tool', message: 'tool failed' }
    }))
    const tool = createTaskTool({
      getSpawnSubagentPort: () => ({ spawn } as SpawnSubagentPort)
    })

    const output = await tool.execute(
      { subagent_type: 'code', task: 'change file' },
      context()
    )

    expect(output.success).toBe(false)
    expect(output.output).toContain('[子代理 code / 11111111-2222-3333-4444-555555555555]')
    expect(output.output).toContain('partial evidence')
    expect(output.error).toBe('tool failed')
  })

  it('incomplete 子代理 → 失败语义，保留部分摘要并说明截断原因', async () => {
    const spawn = vi.fn(async () => result({
      status: 'incomplete',
      summary: '部分工作已做',
      incompleteReason: 'max_rounds'
    }))
    const tool = createTaskTool({
      getSpawnSubagentPort: () => ({ spawn } as SpawnSubagentPort)
    })

    const output = await tool.execute(
      { subagent_type: 'code', task: 'keep going' },
      context()
    )

    expect(output.success).toBe(false)
    expect(output.output).toContain('部分工作已做')
    expect(output.error).toBe('子代理未完成任务（已达工具轮数上限）')
  })

  it('缺少参数、durable 调用身份或服务装配时 fail closed', async () => {
    const { tool } = setup()
    expect((await tool.execute({ subagent_type: '', task: 'x' }, context())).success).toBe(false)
    expect((await tool.execute({ subagent_type: 'explore', task: '' }, context())).success).toBe(false)
    expect((await tool.execute(
      { subagent_type: 'explore', task: 'x' },
      { workingDir: process.cwd(), readState: createReadState() }
    )).error).toContain('durable')

    const unavailable = createTaskTool({ getSpawnSubagentPort: () => undefined })
    expect((await unavailable.execute(
      { subagent_type: 'explore', task: 'x' },
      context()
    )).error).toContain('尚未装配')
  })

  it('支持可选 canonical 模型覆盖与 effort，严格拒绝非法 effort 与未知字段', async () => {
    const { tool, spawn } = setup()
    const withOverride = await tool.execute(
      {
        subagent_type: 'explore',
        task: 'inspect',
        model: { providerId: 'glm', modelEntryId: 'glm-52' },
        reasoningEffort: 'max'
      },
      context()
    )
    expect(withOverride.success).toBe(true)
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        profileId: 'explore',
        modelOverride: { providerId: 'glm', modelEntryId: 'glm-52' },
        reasoningEffort: 'max'
      }),
      expect.anything()
    )

    expect((await tool.execute(
      { subagent_type: 'explore', task: 'inspect', reasoningEffort: 'ultra' },
      context()
    )).error).toContain('reasoningEffort')

    expect((await tool.execute(
      { subagent_type: 'explore', task: 'inspect', unknownField: 1 } as Record<string, unknown>,
      context()
    )).error).toContain('未知字段')

    expect((await tool.execute(
      { subagent_type: 'explore', task: 'inspect', model: { providerId: '', modelEntryId: '' } },
      context()
    )).error).toContain('model')
  })

  it('模型覆盖不改变 profile 的 tool/权限/isolation', async () => {
    const { tool, spawn } = setup()
    // explore 覆盖 GLM 仍保持 readonly isolation；code 覆盖仍保持 shared
    await tool.execute(
      { subagent_type: 'explore', task: 'inspect', model: { providerId: 'glm', modelEntryId: 'm1' } },
      context()
    )
    expect(spawn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ profileId: 'explore', isolation: 'readonly', modelOverride: expect.any(Object) })
    )
    await tool.execute(
      { subagent_type: 'code', task: 'edit', model: { providerId: 'glm', modelEntryId: 'm1' } },
      context()
    )
    expect(spawn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ profileId: 'code', isolation: 'shared', modelOverride: expect.any(Object) })
    )
  })
})
