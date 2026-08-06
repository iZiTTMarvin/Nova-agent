/**
 * ATIF 逐步构造单测。
 *
 * 锁定：
 * - usage 事件标记模型调用完成：每轮（流）一个 agent step，llm_call_count 按步统计
 * - 新一轮模型输出（usage 之后到达的正文/tool_call）开新 step
 * - tool_result 通过 toolCallId 回溯归属产生调用的 step
 * - 停止策略合成通知（无模型调用的残留正文步）在 message_end 时并入前一步
 */
import { describe, expect, it } from 'vitest'
import { buildAtifTrajectory } from '../../../src/headless/atif'
import type { AgentEvent } from '../../../src/runtime/agent/types'

function usageEvent(messageId: string): AgentEvent {
  return {
    type: 'usage',
    messageId,
    usage: {
      uncachedInputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
      rawUsage: {},
      usageDialect: 'deepseek',
      promptTokens: 10,
      completionTokens: 5,
      cachedTokens: 0
    },
    cacheProfileId: 'deepseek'
  }
}

const base = {
  instruction: 'fix the bug',
  startedAt: '2026-08-05T00:00:00.000Z',
  finishedAt: '2026-08-05T00:01:00.000Z'
}

describe('buildAtifTrajectory', () => {
  it('无工具调用时单 agent step，total_steps=2', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      { type: 'text_delta', messageId: 'm1', delta: 'done' },
      usageEvent('m1'),
      { type: 'message_end', messageId: 'm1' }
    ]
    const result = buildAtifTrajectory({ ...base, events })

    expect(result.totalSteps).toBe(2)
    expect(result.llmCallCount).toBe(1)
    expect(result.steps[1].source).toBe('agent')
    expect(result.steps[1].message).toBe('done')
    expect(result.steps[1].llm_call_count).toBe(1)
  })

  it('一轮工具调用：tool_call 与 tool_result 归属同一 agent step', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      {
        type: 'tool_call',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { command: 'ls' }
      },
      usageEvent('m1'),
      {
        type: 'tool_result',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'bash',
        result: 'file.txt'
      },
      { type: 'text_delta', messageId: 'm1', delta: 'saw it' },
      usageEvent('m1'),
      { type: 'message_end', messageId: 'm1' }
    ]
    const result = buildAtifTrajectory({ ...base, events })

    expect(result.totalSteps).toBe(3)
    expect(result.llmCallCount).toBe(2)
    const toolStep = result.steps[1]
    expect(toolStep.tool_calls).toEqual([
      { tool_call_id: 'tc1', function_name: 'bash', arguments: { command: 'ls' } }
    ])
    expect(toolStep.observation).toEqual({
      results: [{ source_call_id: 'tc1', content: 'file.txt' }]
    })
    // 第二轮正文（usage 之后到达）归属新 step
    expect(result.steps[2].message).toBe('saw it')
    expect(result.steps[2].llm_call_count).toBe(1)
  })

  it('reasoning_content 归入产生它的 step', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      { type: 'thinking_delta', messageId: 'm1', delta: 'think...' },
      usageEvent('m1'),
      { type: 'message_end', messageId: 'm1' }
    ]
    const result = buildAtifTrajectory({ ...base, events })

    expect(result.steps[1].reasoning_content).toBe('think...')
  })

  it('无 usage 事件（provider 未回报）时，终态保留残留 step 不丢正文', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      { type: 'text_delta', messageId: 'm1', delta: 'final answer' },
      { type: 'message_end', messageId: 'm1' }
    ]
    const result = buildAtifTrajectory({ ...base, events })

    expect(result.totalSteps).toBe(2)
    expect(result.llmCallCount).toBe(0)
    expect(result.steps[1].message).toBe('final answer')
  })

  it('停止策略通知文本在 message_end 并入最近模型步，不撑出独立 step', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      {
        type: 'tool_call',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'ls',
        args: { path: '.' }
      },
      usageEvent('m1'),
      {
        type: 'tool_result',
        messageId: 'm1',
        toolCallId: 'tc1',
        toolName: 'ls',
        result: 'file.txt'
      },
      // 停止策略通知（新 step：无 usage、无工具调用）
      { type: 'text_delta', messageId: 'm1', delta: '[已达到最大工具调用轮数 2]' },
      { type: 'message_end', messageId: 'm1' }
    ]
    const result = buildAtifTrajectory({ ...base, events })

    expect(result.totalSteps).toBe(2)
    expect(result.llmCallCount).toBe(1)
    // 通知文本并入唯一的 agent step（含工具调用的那步）
    expect(result.steps[1].message).toBe('[已达到最大工具调用轮数 2]')
    expect(result.steps[1].tool_calls).toHaveLength(1)
  })

  it('两次模型调用各占一个 agent step（真实事件序）', () => {
    const events: AgentEvent[] = [
      { type: 'message_start', messageId: 'm1' },
      { type: 'text_delta', messageId: 'm1', delta: 'first' },
      usageEvent('m1'),
      { type: 'text_delta', messageId: 'm1', delta: 'second' },
      usageEvent('m1'),
      { type: 'message_end', messageId: 'm1' }
    ]
    const result = buildAtifTrajectory({ ...base, events })

    expect(result.totalSteps).toBe(3)
    expect(result.steps[1].message).toBe('first')
    expect(result.steps[1].llm_call_count).toBe(1)
    expect(result.steps[2].message).toBe('second')
    expect(result.steps[2].llm_call_count).toBe(1)
  })
})
