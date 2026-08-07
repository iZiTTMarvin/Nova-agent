import { describe, expect, it } from 'vitest'
import {
  MAX_SUBAGENT_SUMMARY_CHARS,
  projectSubagentExecutionResult,
  selectStructuredResult
} from '../../../../src/runtime/subagents'
import type { RunSnapshot } from '../../../../src/shared/run/types'
import type { JsonSchema } from '../../../../src/shared/subagents'
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

  it('结构化结果取自未截断文本：超出摘要上限的合法 JSON 仍完整解析', () => {
    const plan = {
      version: 1,
      goal: '完成用户请求',
      tasks: Array.from({ length: 120 }, (_, index) => ({
        id: `task-${index}`,
        title: `任务 ${index}`,
        acceptance: ['x'.repeat(60)]
      }))
    }
    const finalText = [
      `已完成规划，共 ${plan.tasks.length} 个任务。`,
      '',
      '```json',
      JSON.stringify(plan, null, 2),
      '```'
    ].join('\n')
    const schema: JsonSchema = {
      type: 'object',
      required: ['version', 'goal', 'tasks']
    }
    expect(finalText.length).toBeGreaterThan(MAX_SUBAGENT_SUMMARY_CHARS)

    const projected = projectSubagentExecutionResult({
      childSession: session(finalText),
      runSnapshot: run('completed'),
      resultSchema: schema
    })

    expect(projected.structuredResult).toEqual(plan)
    expect(projected.summary).toHaveLength(MAX_SUBAGENT_SUMMARY_CHARS)
    expect(selectStructuredResult(schema, projected.summary)).toBeUndefined()
  })

  it('required 齐全的候选优先于散文中的示例对象', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session([
        '先说明取舍：示例结构如下。',
        '```json',
        '{"note":"这是示例，不是最终结论"}',
        '```',
        '最终结论：',
        '```json',
        '{"verdict":"pass","summary":"符合计划","issues":[]}',
        '```'
      ].join('\n')),
      runSnapshot: run('completed'),
      resultSchema: { type: 'object', required: ['verdict', 'summary', 'issues'] }
    })

    expect(projected.structuredResult).toEqual({
      verdict: 'pass',
      summary: '符合计划',
      issues: []
    })
  })

  it('未声明 required 时取第一个对象候选', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session('结论如下\n```json\n{"a":1}\n```'),
      runSnapshot: run('completed'),
      resultSchema: { type: 'object' }
    })

    expect(projected.structuredResult).toEqual({ a: 1 })
  })

  it('未请求 schema 时不产出结构化结果', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session('```json\n{"a":1}\n```'),
      runSnapshot: run('completed')
    })

    expect(projected.structuredResult).toBeUndefined()
  })

  it('无候选满足 required 时不写入结构化结果', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session('完全没有结构化输出'),
      runSnapshot: run('completed'),
      resultSchema: { type: 'object', required: ['verdict'] }
    })

    expect(projected.structuredResult).toBeUndefined()
    expect(projected.summary).toBe('完全没有结构化输出')
  })

  it('incomplete 且无最终消息 → 使用未完成 fallback 摘要', () => {
    const projected = projectSubagentExecutionResult({
      childSession: session(''),
      runSnapshot: run('completed', undefined, 'empty_args')
    })

    expect(projected.status).toBe('incomplete')
    expect(projected.incompleteReason).toBe('empty_args')
    expect(projected.summary).toBe('子代理未完成任务')
  })
})
