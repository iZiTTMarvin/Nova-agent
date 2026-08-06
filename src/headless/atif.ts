/**
 * 把 AgentEvent 流按模型调用切分为 ATIF trajectory 的逐步记录。
 *
 * 事件归属规则（每轮流 = thinking/text/tool_call … usage，工具执行的
 * tool_result 在流外到达）：
 * - usage 标记一次模型调用完成；之后到达的正文/tool_call 归属新的一步
 * - tool_result 按 toolCallId 回溯归属到产生该调用的 step
 * - message_end 时，若末尾残留一个无模型调用、无工具调用的通知性文本步
 *   （如停止策略提示语），并入前一个 agent step，避免撑出虚假的独立步
 *
 * 已知简化：被跳过/未执行的 tool_call 没有对应 tool_result；所有 step
 * 的时间戳取轮次结束时刻，不追踪步内精确时间。
 */
import type { AgentEvent } from '../runtime/agent/types'

export interface AtifToolCall {
  tool_call_id: string
  function_name: string
  arguments: Record<string, unknown>
}

export interface AtifObservation {
  source_call_id: string
  content: string
}

export interface AtifStep {
  step_id: number
  source: 'user' | 'agent'
  message?: string
  timestamp: string
  llm_call_count?: number
  reasoning_content?: string
  tool_calls?: AtifToolCall[]
  observation?: { results: AtifObservation[] }
}

export interface AtifTrajectoryInput {
  instruction: string
  startedAt: string
  finishedAt: string
  events: AgentEvent[]
}

/** 逐步构造 ATIF trajectory。纯函数：不持有状态，便于单测。 */
export function buildAtifTrajectory(input: AtifTrajectoryInput): {
  steps: AtifStep[]
  totalSteps: number
  llmCallCount: number
} {
  const steps: AtifStep[] = [
    { step_id: 1, source: 'user', message: input.instruction, timestamp: input.startedAt }
  ]

  let nextStepId = 2
  let current: AtifStep | null = null
  const toolCallStep = new Map<string, AtifStep>()

  const startStep = (): AtifStep => {
    const step: AtifStep = {
      step_id: nextStepId,
      source: 'agent',
      timestamp: input.finishedAt
    }
    nextStepId += 1
    steps.push(step)
    return step
  }

  /** 当前步已计过模型调用（上一轮流已结束）→ 新一轮内容应开新步 */
  const stepForNewModelContent = (): AtifStep => {
    if (current !== null && (current.llm_call_count ?? 0) > 0) {
      current = startStep()
    }
    if (current === null) current = startStep()
    const step: AtifStep = current
    return step
  }

  for (const event of input.events) {
    switch (event.type) {
      case 'thinking_delta': {
        const step = stepForNewModelContent()
        step.reasoning_content = (step.reasoning_content ?? '') + event.delta
        break
      }
      case 'text_delta': {
        const step = stepForNewModelContent()
        step.message = (step.message ?? '') + event.delta
        break
      }
      case 'tool_call': {
        const step = stepForNewModelContent()
        step.tool_calls = step.tool_calls ?? []
        step.tool_calls.push({
          tool_call_id: event.toolCallId,
          function_name: event.toolName,
          arguments: event.args
        })
        toolCallStep.set(event.toolCallId, step)
        break
      }
      case 'tool_result': {
        const owner = toolCallStep.get(event.toolCallId)
        if (owner) {
          owner.observation = owner.observation ?? { results: [] }
          owner.observation.results.push({
            source_call_id: event.toolCallId,
            content: event.result
          })
        }
        break
      }
      case 'usage': {
        const lastAgent = steps[steps.length - 1]
        if (lastAgent && lastAgent.source === 'agent') {
          lastAgent.llm_call_count = (lastAgent.llm_call_count ?? 0) + 1
        }
        break
      }
      case 'message_end':
      case 'error': {
        // 停止策略合成通知（无模型调用、无工具调用的残留正文步）并入前一个
        // agent step，避免撑出虚假的独立模型步。
        const last = steps[steps.length - 1]
        if (last && last.source === 'agent' && (last.llm_call_count ?? 0) === 0 && !last.tool_calls) {
          const prev = steps[steps.length - 2]
          if (prev && prev.source === 'agent') {
            if (last.message) {
              prev.message = (prev.message ?? '') + last.message
            }
            if (last.reasoning_content) {
              prev.reasoning_content = (prev.reasoning_content ?? '') + last.reasoning_content
            }
            steps.pop()
          }
        }
        current = null
        break
      }
      default:
        break
    }
  }

  return {
    steps,
    totalSteps: steps.length,
    llmCallCount: steps.reduce((sum, step) => sum + (step.llm_call_count ?? 0), 0)
  }
}
