/**
 * 嵌套工具派发 seam 测试：run_code 沙箱内的工具调用必须重入统一执行流水线
 * （可用性闸门 / 权限 / 取消 / 事件父标识全部生效），且自身不能再嵌套派发。
 */
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult, NestedToolCallResult } from '../../../../src/runtime/tools/types'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import { executeToolBatch } from '../../../../src/runtime/agent/execution/toolBatchExecutor'
import { createReadState } from '../../../../src/runtime/tools/editTool'

interface HarnessOptions {
  checkPermission?: (toolName: string) => { allowed: boolean; reason: string }
  isToolAvailable?: (toolName: string) => boolean
  abortSignal?: AbortSignal
}

async function runHarness(options: HarnessOptions = {}): Promise<{
  hostOutcome: NestedToolCallResult | null
  nestedContextProbe: ToolContext | null
  events: AgentEvent[]
}> {
  const registry = new ToolRegistry()
  let nestedContextProbe: ToolContext | null = null
  let hostOutcome: NestedToolCallResult | null = null
  const events: AgentEvent[] = []

  registry.register({
    name: 'read',
    description: 'read',
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context): Promise<ToolResult> => {
      nestedContextProbe = context
      return { success: true, output: 'nested-read-output' }
    }
  })

  registry.register({
    name: 'host',
    description: 'host tool that dispatches a nested call',
    parameters: { type: 'object', properties: {} },
    execute: async (_args, context): Promise<ToolResult> => {
      const dispatch = context.dispatchNestedToolCall
      if (!dispatch) {
        return { success: false, output: '', error: '缺少嵌套派发入口' }
      }
      hostOutcome = await dispatch({ toolName: 'read', args: { path: 'a.ts' } })
      return { success: true, output: hostOutput(hostOutcome) }
    }
  })

  const permission = options.checkPermission ?? (() => ({ allowed: true, reason: '' }))
  await executeToolBatch({
    toolCalls: [{ id: 'tc_host', name: 'host', arguments: '{}' }],
    messageId: 'msg_nested',
    toolRegistry: registry,
    workingDir: process.cwd(),
    mode: 'default',
    supportsVision: true,
    checkpointManager: null,
    abortSignal: options.abortSignal,
    checkPermission: async (toolName) => permission(toolName),
    emit: event => {
      events.push(event)
    },
    applyTruncation: output => output,
    maxParallelToolCalls: 4,
    toolExecution: 'parallel',
    readState: createReadState(),
    ...(options.isToolAvailable ? { isToolAvailable: options.isToolAvailable } : {}),
    allowNestedToolDispatch: true
  })

  return { hostOutcome, nestedContextProbe, events }
}

function hostOutcome(outcome: NestedToolCallResult | null): string {
  return outcome ? `${outcome.success ? 'ok' : 'err'}:${outcome.output}` : 'none'
}

describe('嵌套工具派发 seam', () => {
  it('嵌套调用重入执行流水线成功执行，并带父标识事件', async () => {
    const { hostOutcome: outcome, nestedContextProbe, events } = await runHarness()

    expect(outcome).not.toBeNull()
    expect(outcome!.success).toBe(true)
    expect(outcome!.output).toBe('nested-read-output')
    expect(outcome!.toolCallId).toBe('tc_host#nested-1')

    // 嵌套工具自身不再携带派发入口（禁止递归派发）
    expect(nestedContextProbe!.dispatchNestedToolCall).toBeUndefined()

    // 合成的 tool_call 与流水线发出的 tool_result 都带父调用标识
    const nestedCall = events.find(e => e.type === 'tool_call' && e.toolCallId === 'tc_host#nested-1')
    const nestedResult = events.find(e => e.type === 'tool_result' && e.toolCallId === 'tc_host#nested-1')
    expect(nestedCall).toBeDefined()
    expect((nestedCall as Extract<AgentEvent, { type: 'tool_call' }>).parentToolCallId).toBe('tc_host')
    expect((nestedCall as Extract<AgentEvent, { type: 'tool_call' }>).args).toEqual({ path: 'a.ts' })
    expect(nestedResult).toBeDefined()
    expect((nestedResult as Extract<AgentEvent, { type: 'tool_result' }>).parentToolCallId).toBe('tc_host')

    // 父工具自身的事件不带父标识
    const hostResult = events.find(e => e.type === 'tool_result' && e.toolCallId === 'tc_host')
    expect((hostResult as Extract<AgentEvent, { type: 'tool_result' }>).parentToolCallId).toBeUndefined()
  })

  it('权限拒绝在嵌套路径与直调一致：结果 success=false 且含拒绝文案', async () => {
    const { hostOutcome: outcome } = await runHarness({
      checkPermission: toolName =>
        toolName === 'read'
          ? { allowed: false, reason: '需要用户确认' }
          : { allowed: true, reason: '' }
    })
    expect(outcome!.success).toBe(false)
    expect(outcome!.error).toContain('权限拒绝')
    expect(outcome!.error).toContain('需要用户确认')
  })

  it('可用性闸门在嵌套路径生效：未激活组工具被拦截', async () => {
    const { hostOutcome: outcome } = await runHarness({
      isToolAvailable: toolName => toolName !== 'read'
    })
    expect(outcome!.success).toBe(false)
    expect(outcome!.error).toContain('未激活')
    expect(outcome!.error).toContain('load_tools')
  })

  it('批次未开启派发入口时工具拿不到嵌套派发能力', async () => {
    const registry = new ToolRegistry()
    let sawDispatch = true
    registry.register({
      name: 'host',
      description: 'host',
      parameters: { type: 'object', properties: {} },
      execute: async (_args, context): Promise<ToolResult> => {
        sawDispatch = context.dispatchNestedToolCall !== undefined
        return { success: true, output: 'done' }
      }
    })
    await executeToolBatch({
      toolCalls: [{ id: 'tc_host', name: 'host', arguments: '{}' }],
      messageId: 'msg_plain',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: () => {},
      applyTruncation: output => output,
      maxParallelToolCalls: 4,
      toolExecution: 'parallel',
      readState: createReadState()
    })
    expect(sawDispatch).toBe(false)
  })
})
