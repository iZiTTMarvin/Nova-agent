import { describe, expect, it } from 'vitest'
import {
  MAX_SUBAGENT_SUMMARY_CHARS,
  projectSubagentExecutionResult
} from '../../../../src/runtime/subagents'
import type { RunSnapshot } from '../../../../src/shared/run/types'
import type { SessionData } from '../../../../src/runtime/sessions/types'

function session(content: string): SessionData {
  return {
    schemaVersion: 10,
    kind: 'primary',
    id: 'sess-child',
    workspaceRoot: '/workspace',
    mode: 'plan',
    messages: [{
      id: 'msg-final',
      parentId: null,
      role: 'assistant',
      content,
      toolCalls: [
        { id: 'one', name: 'read', arguments: '{}', artifactId: 'artifact-1' },
        { id: 'two', name: 'grep', arguments: '{}', artifactId: 'artifact-1' }
      ],
      timestamp: 2
    }],
    currentLeafId: 'msg-final',
    createdAt: 1,
    updatedAt: 2
  }
}

function run(
  status: RunSnapshot['status'],
  reason?: string,
  incompleteReason?: RunSnapshot['incompleteReason']
): RunSnapshot {
  return {
    runId: 'run-child',
    kind: 'agent',
    workspaceId: '/workspace',
    sessionId: 'sess-child',
    messageId: 'msg-final',
    status,
    sequence: 1,
    pendingInteractions: [],
    currentAttempt: null,
    progress: null,
    lastHeartbeatAt: 2,
    createdAt: 1,
    updatedAt: 3,
    turnStartedAt: 2,
    ...(reason ? { terminalReason: reason } : {}),
    ...(incompleteReason ? { incompleteReason } : {})
  }
}

describe('projectSubagentExecutionResult', () => {
  it('从原始 spawn run 的最终 assistant message 生成有界摘要与去重 artifact', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session('x'.repeat(MAX_SUBAGENT_SUMMARY_CHARS + 50)),
      runSnapshot: run('completed')
    })

    expect(projected.status).toBe('completed')
    expect(projected.summary).toHaveLength(MAX_SUBAGENT_SUMMARY_CHARS)
    expect(projected.summary.endsWith('…')).toBe(true)
    expect(projected.artifactIds).toEqual(['artifact-1'])
    expect(projected.startedAt).toBe(2)
    expect(projected.completedAt).toBe(3)
  })

  it('失败原因有界且 failure code 可由宿主归类', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session(''),
      runSnapshot: run('failed', 'host setup failed'),
      failureCode: 'host'
    })
    expect(projected.summary).toBe('子代理执行出错')
    expect(projected.failure).toEqual({ code: 'host', message: 'host setup failed' })
  })

  it('非终态 run 不伪造成执行结果', () => {
    expect(() => projectSubagentExecutionResult({
      childSession: session('partial'),
      runSnapshot: run('running')
    })).toThrow(/尚未终止/)
  })

  it('completed + incompleteReason → 投影为 incomplete 并携带截断原因', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session('部分工作已做'),
      runSnapshot: run('completed', undefined, 'max_rounds')
    })

    expect(projected.status).toBe('incomplete')
    expect(projected.incompleteReason).toBe('max_rounds')
    expect(projected.failure).toBeUndefined()
  })

  it('completed 无截断字段 → 仍为 completed（旧记录兼容）', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session('done'),
      runSnapshot: run('completed')
    })

    expect(projected.status).toBe('completed')
    expect(projected.incompleteReason).toBeUndefined()
  })
})
