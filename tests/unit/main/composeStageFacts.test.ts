import { describe, expect, it } from 'vitest'
import { createComposeStageFactsProvider } from '../../../src/main/agent/runtime/composeStageWiring'
import type { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import type { SessionData, SessionMessage } from '../../../src/runtime/sessions/types'
import {
  createInitialStageTable,
  type ComposeStageEntry
} from '../../../src/shared/composeLifecycle'
import { BUILTIN_SUBAGENT_IDS } from '../../../src/shared/subagents/presetIdentity'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import { resolveSubagentProfileSnapshot } from '../../../src/runtime/subagents'

const PARENT = 'sess_parent'
const ENTERED_AT = 1_000

function blueprintStages(enteredAt: number): ComposeStageEntry[] {
  const stages = createInitialStageTable()
  stages[0] = { id: 'interview', status: 'completed', completedAt: 1 }
  stages[1] = { id: 'blueprint', status: 'in_progress', enteredAt }
  return stages
}

function inspectStages(enteredAt: number): ComposeStageEntry[] {
  const stages = createInitialStageTable()
  stages[0] = { id: 'interview', status: 'completed', completedAt: 1 }
  stages[1] = { id: 'blueprint', status: 'completed', completedAt: 2 }
  stages[2] = { id: 'build', status: 'completed', completedAt: 3 }
  stages[3] = { id: 'inspect', status: 'in_progress', enteredAt }
  return stages
}

function projection(opts: {
  profileId: string
  status: SubagentActivityProjection['status']
  childSessionId: string
  startedAt?: number
  completedAt?: number
}): SubagentActivityProjection {
  return {
    childSessionId: opts.childSessionId,
    childRunId: `run_${opts.childSessionId}`,
    parentSessionId: PARENT,
    profile: {
      profileId: opts.profileId,
      name: opts.profileId,
      permissionCeiling: 'read_only'
    },
    taskLabel: opts.profileId,
    status: opts.status,
    artifactCount: 0,
    ...(opts.startedAt !== undefined ? { startedAt: opts.startedAt } : {}),
    ...(opts.completedAt !== undefined ? { completedAt: opts.completedAt } : {})
  }
}

function childSession(
  id: string,
  messages: SessionMessage[]
): SessionData {
  return {
    schemaVersion: 19,
    kind: 'subagent',
    subagent: {
      lineage: {
        parentSessionId: PARENT, parentRunId: 'parent-run', rootRunId: 'parent-run', depth: 1,
        spawnKey: id, spawnRunId: `run_${id}`,
        origin: { kind: 'task_tool', parentMessageId: 'parent-message', parentToolCallId: id }
      },
      profile: resolveSubagentProfileSnapshot({
        id: 'inspector', name: 'inspector', description: '核验', prompt: '核验', allowedTools: ['bash']
      }, 'inspector')
    },
    id,
    workspaceRoot: '/tmp/ws',
    mode: 'default',
    permissionMode: 'request_approval',
    messages,
    currentLeafId: messages[messages.length - 1]?.id ?? null,
    createdAt: 1,
    updatedAt: 1
  }
}

function inspectorMessages(opts: {
  toolName: 'bash' | 'shell_session'
  result: string
  conclusion: string
  toolStatus?: 'success' | 'error'
  verdict?: 'pass' | 'fail' | null
}): SessionMessage[] {
  return [
    {
      id: 'u1',
      parentId: null,
      role: 'user',
      content: '按一页纸核验',
      timestamp: 1
    },
    {
      id: 'a1',
      parentId: 'u1',
      role: 'assistant',
      content: opts.conclusion,
      timestamp: ENTERED_AT + 1,
      blocks: [
        {
          type: 'tool',
          toolCallId: 't1',
          toolName: opts.toolName,
          arguments: {},
          status: opts.toolStatus ?? 'success',
          result: opts.result
        },
        { type: 'text', content: opts.conclusion },
        ...(opts.verdict === null ? [] : [{
          type: 'tool' as const, toolCallId: 'report', toolName: 'inspection_report',
          arguments: { verdict: opts.verdict ?? 'pass', summary: '实际核验结果' }, status: 'success' as const,
          result: JSON.stringify({
            verdict: opts.verdict ?? 'pass', summary: '实际核验结果', parentSessionId: PARENT,
            stageEnteredAt: ENTERED_AT, childRunId: 'run_child_insp', messageId: 'a1'
          })
        }])
      ]
    }
  ]
}

function provider(opts: {
  stages: ComposeStageEntry[] | null
  runs: SubagentActivityProjection[]
  children?: Record<string, SessionData>
}) {
  const sessionStore = {
    getComposeStages: () => opts.stages,
    load: (id: string) => opts.children?.[id] ?? null
  } as unknown as SessionStore
  return createComposeStageFactsProvider({
    sessionStore,
    projection: {
      listByParentSessionId: (parentId: string) =>
        opts.runs.filter(run => run.parentSessionId === parentId)
    }
  })
}

describe('createComposeStageFactsProvider', () => {
  it('后续损坏、串会话、旧阶段或未通过结果不能被先前 pass 掩盖', () => {
    const valid = {
      verdict: 'pass', summary: '核验记录', parentSessionId: PARENT,
      stageEnteredAt: ENTERED_AT, childRunId: 'run_child_insp', messageId: 'a1'
    }
    for (const result of [
      '{broken',
      ...[
        { parentSessionId: 'other' }, { childRunId: 'old-run' }, { stageEnteredAt: 0 },
        { messageId: 'other-message' }, { verdict: 'unknown' }, { verdict: 'fail' }
      ].map(change => JSON.stringify({ ...valid, ...change }))
    ]) {
      const messages = inspectorMessages({ toolName: 'bash', result: 'ok', conclusion: '报告措辞任意' })
      messages[1].blocks!.push({
        type: 'tool', toolCallId: 'later-report', toolName: 'inspection_report', arguments: {}, status: 'success', result
      })
      const facts = provider({
        stages: inspectStages(ENTERED_AT),
        runs: [projection({ profileId: BUILTIN_SUBAGENT_IDS.inspector, status: 'completed', childSessionId: 'child_insp', startedAt: ENTERED_AT + 1 })],
        children: { child_insp: childSession('child_insp', messages) }
      })(PARENT)
      expect(facts.inspectorPassed, result).toBe(false)
    }
  })
  it('正式核验结果不受报告措辞和冒号影响', () => {
    const childId = 'child_insp'
    const messages = inspectorMessages({ toolName: 'bash', result: 'ok', conclusion: '总体:通过', verdict: null })
    messages[1].blocks!.push({
      type: 'tool', toolCallId: 'report', toolName: 'inspection_report',
      arguments: { verdict: 'pass', summary: '实际操作通过' }, status: 'success',
      result: JSON.stringify({
        verdict: 'pass', summary: '实际操作通过', parentSessionId: PARENT,
        stageEnteredAt: ENTERED_AT, childRunId: `run_${childId}`,
        messageId: 'a1'
      })
    })
    const facts = provider({
      stages: inspectStages(ENTERED_AT),
      runs: [projection({ profileId: BUILTIN_SUBAGENT_IDS.inspector, status: 'completed', childSessionId: childId, startedAt: ENTERED_AT + 1 })],
      children: { [childId]: childSession(childId, messages) }
    })(PARENT)
    expect(facts.inspectorPassed).toBe(true)
  })
  it('批评者 run 在 enteredAt 之前不算完成', () => {
    const facts = provider({
      stages: blueprintStages(ENTERED_AT),
      runs: [
        projection({
          profileId: BUILTIN_SUBAGENT_IDS.critic,
          status: 'completed',
          childSessionId: 'child_critic',
          startedAt: ENTERED_AT - 1,
          completedAt: ENTERED_AT + 50
        })
      ]
    })(PARENT)
    expect(facts.criticCompleted).toBe(false)
  })

  it('批评者 run 在 enteredAt 当时或之后且 status=completed 才算', () => {
    const atBoundary = provider({
      stages: blueprintStages(ENTERED_AT),
      runs: [
        projection({
          profileId: BUILTIN_SUBAGENT_IDS.critic,
          status: 'completed',
          childSessionId: 'child_critic',
          startedAt: ENTERED_AT,
          completedAt: ENTERED_AT + 10
        })
      ]
    })(PARENT)
    expect(atBoundary.criticCompleted).toBe(true)

    const cancelled = provider({
      stages: blueprintStages(ENTERED_AT),
      runs: [
        projection({
          profileId: BUILTIN_SUBAGENT_IDS.critic,
          status: 'cancelled',
          childSessionId: 'child_critic',
          startedAt: ENTERED_AT + 1,
          completedAt: ENTERED_AT + 2
        })
      ]
    })(PARENT)
    expect(cancelled.criticCompleted).toBe(false)
  })

  it('核验：exitCode 0 且结论通过才算；非 0 或结论未通过都不算', () => {
    const childId = 'child_insp'
    const baseRun = projection({
      profileId: BUILTIN_SUBAGENT_IDS.inspector,
      status: 'completed',
      childSessionId: childId,
      startedAt: ENTERED_AT + 1,
      completedAt: ENTERED_AT + 2
    })

    const passed = provider({
      stages: inspectStages(ENTERED_AT),
      runs: [baseRun],
      children: {
        [childId]: childSession(
          childId,
          inspectorMessages({
            toolName: 'bash',
            result:
              '[命令退出码: 0（命令已执行完成；非 0 不一定是错误，请阅读下方输出判断）]\nhello',
            conclusion: '结论：通过'
          })
        )
      }
    })(PARENT)
    expect(passed.inspectorPassed).toBe(true)

    const bashSuccessNoMarker = provider({
      stages: inspectStages(ENTERED_AT),
      runs: [baseRun],
      children: {
        [childId]: childSession(
          childId,
          inspectorMessages({
            toolName: 'bash',
            result: '(命令执行成功，无输出)',
            conclusion: '结论：通过'
          })
        )
      }
    })(PARENT)
    expect(bashSuccessNoMarker.inspectorPassed).toBe(true)

    const nonZero = provider({
      stages: inspectStages(ENTERED_AT),
      runs: [baseRun],
      children: {
        [childId]: childSession(
          childId,
          inspectorMessages({
            toolName: 'bash',
            result:
              '[命令退出码: 1（命令已执行完成；非 0 不一定是错误，请阅读下方输出判断）]\nfail',
            conclusion: '结论：通过',
            toolStatus: 'success'
          })
        )
      }
    })(PARENT)
    expect(nonZero.inspectorPassed).toBe(false)

    const rejected = provider({
      stages: inspectStages(ENTERED_AT),
      runs: [baseRun],
      children: {
        [childId]: childSession(
          childId,
          inspectorMessages({
            toolName: 'shell_session',
            result: 'output\n[会话已终止，退出码: 0]',
            conclusion: '结论：未通过', verdict: 'fail'
          })
        )
      }
    })(PARENT)
    expect(rejected.inspectorPassed).toBe(false)
  })

  it('核验：shell_session 退出码 0 且结论通过算过', () => {
    const childId = 'child_insp'
    const facts = provider({
      stages: inspectStages(ENTERED_AT),
      runs: [
        projection({
          profileId: BUILTIN_SUBAGENT_IDS.inspector,
          status: 'completed',
          childSessionId: childId,
          startedAt: ENTERED_AT + 5
        })
      ],
      children: {
        [childId]: childSession(
          childId,
          inspectorMessages({
            toolName: 'shell_session',
            result: 'ok\n[会话已终止，退出码: 0]',
            conclusion: '逐条核验完毕。\n结论：通过'
          })
        )
      }
    })(PARENT)
    expect(facts.inspectorPassed).toBe(true)
  })
})
