import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectionReportTool } from '../../../../src/runtime/tools/inspection_report'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { SessionStore, deriveChildSessionId } from '../../../../src/runtime/sessions'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { resolveSubagentProfileSnapshot } from '../../../../src/runtime/subagents'
import { createComposeStageFactsProvider } from '../../../../src/main/agent/runtime/composeStageFacts'
import { getStageCompleteDenial } from '../../../../src/shared/composeLifecycle'
import type { ToolContext } from '../../../../src/runtime/tools/types'
import type { MessageBlock } from '../../../../src/shared/session'
import type { SubagentActivityProjection } from '../../../../src/shared/subagents'

let root: string
let store: SessionStore
let parentId: string
let childId: string
let enteredAt: number
let run: SubagentActivityProjection

beforeEach(() => {
  resetSessionIndexHostForTests()
  root = mkdtempSync(join(tmpdir(), 'nova-inspection-report-'))
  store = new SessionStore(root)
  parentId = store.create(root, 'compose').id
  for (let i = 0; i < 3; i++) store.applyComposeStageTransition(parentId, { type: 'complete' })
  enteredAt = store.getComposeStages(parentId)!.find(stage => stage.id === 'inspect')!.enteredAt!
  childId = deriveChildSessionId('inspection-test')
  store.createChildIfAbsent({
    childSessionId: childId, workspaceRoot: root, mode: 'default', permissionMode: 'auto', task: '核验',
    subagent: {
      lineage: {
        parentSessionId: parentId, parentRunId: 'parent-run', rootRunId: 'parent-run',
        depth: 1, spawnKey: 'inspection-test', spawnRunId: 'child-run',
        origin: { kind: 'task_tool', parentMessageId: 'parent-message', parentToolCallId: 'task-call' }
      },
      profile: resolveSubagentProfileSnapshot({ id: 'inspector', name: 'inspector', description: '核验', prompt: '核验', allowedTools: ['bash'] }, 'inspector')
    }
  })
  run = {
    childSessionId: childId, childRunId: 'child-run', parentSessionId: parentId,
    profile: { profileId: 'inspector', name: 'inspector', permissionCeiling: 'workspace_write' },
    taskLabel: '核验', status: 'completed', startedAt: enteredAt + 1, completedAt: enteredAt + 2, artifactCount: 0
  }
})

afterEach(() => {
  resetSessionIndexHostForTests()
  rmSync(root, { recursive: true, force: true })
})

function context(): ToolContext {
  return {
    workingDir: root, sessionStore: store, sessionId: childId, runId: run.childRunId,
    readState: createReadState(),
    invocationRef: { sessionId: childId, runId: run.childRunId, messageId: 'inspection-message', toolCallId: 'report-call' }
  }
}

function facts(runs = [run], sessionStore = store) {
  return createComposeStageFactsProvider({ sessionStore, projection: { listByParentSessionId: () => runs } })(parentId)
}

const shell: MessageBlock = { type: 'tool', toolName: 'bash', toolCallId: 'shell-call', arguments: {}, status: 'success', result: 'ok', processOutcome: { state: 'exited', exitCode: 0 } }

async function submit(verdict: 'pass' | 'fail' = 'pass', evidence: MessageBlock[] = [shell]) {
  const args = { verdict, summary: '逐条实际操作并观察输出' }
  const result = await inspectionReportTool.execute(args, context())
  expect(result.success, result.error).toBe(true)
  store.appendMessage(childId, {
    id: 'inspection-message', role: 'assistant', content: '总体:通过', timestamp: enteredAt + 1,
    blocks: [...evidence, { type: 'tool', toolName: 'inspection_report', toolCallId: 'report-call', arguments: args, status: 'success', result: result.output }, { type: 'text', content: '总体:通过' }]
  })
  return result
}

describe('inspection_report', () => {
  it('正式结果随会话落盘，重建 Store 后仍按相同阶段与运行放行', async () => {
    const result = await submit()
    expect(JSON.parse(result.output)).toMatchObject({ parentSessionId: parentId, childRunId: run.childRunId, stageEnteredAt: enteredAt })
    expect(facts().inspectorPassed).toBe(true)
    expect(facts([run], new SessionStore(root)).inspectorPassed).toBe(true)
  })

  it('fail 不被报告正文里的通过字样覆盖', async () => {
    await submit('fail')
    expect(facts()).toMatchObject({ inspectorPassed: false, inspection: { issue: 'failed' } })
    expect(getStageCompleteDenial('inspect', facts())).toContain('正式结果为未通过')
  })

  it.each([
    { evidence: [] },
    { evidence: [{ ...shell, status: 'error' as const, result: '[命令退出码: 0]' }] },
    { evidence: [{ ...shell, processOutcome: { state: 'exited' as const, exitCode: 1 }, result: 'all checks passed' }] },
    { evidence: [{ ...shell, processOutcome: { state: 'running' as const }, result: '[命令退出码: 0]' }] },
    { evidence: [{ ...shell, processOutcome: { state: 'unconfirmed' as const } }] },
    { evidence: [{ ...shell, processOutcome: { state: 'exited' as const, exitCode: null } }] },
    { evidence: [{ ...shell, processOutcome: undefined, result: '[进程仍在运行 ref: psn_abcdefghijkl]' }] }
  ])('缺少真实成功命令不允许仅凭 pass 放行：%j', async ({ evidence }) => {
    await submit('pass', evidence)
    expect(facts()).toMatchObject({ inspectorPassed: false, inspection: { issue: 'missing_evidence' } })
  })

  it.each(['bash', 'shell_session'])('结构化 %s 退出证据不受展示文本影响，落盘后仍可放行', async toolName => {
    await submit('pass', [{ ...shell, toolName, result: 'localized output [命令退出码: 9]' }])
    expect(facts([run], new SessionStore(root)).inspectorPassed).toBe(true)
  })

  it.each([
    { toolName: 'bash', result: 'old foreground success' },
    { toolName: 'shell_session', result: '[会话已结束，退出码: 0]' },
    { toolName: 'shell_session', result: '[会话已终止，退出码: 0]' }
  ])('单一兼容入口读取旧版命令证据：%j', async old => {
    await submit('pass', [{ ...shell, ...old, processOutcome: undefined }])
    expect(facts().inspectorPassed).toBe(true)
  })

  it('旧报告只含自然语言时指向原 inspector 补交，保留已有证据', async () => {
    store.appendMessage(childId, { id: 'old-report', role: 'assistant', content: '结论:通过', timestamp: enteredAt + 1, blocks: [shell, { type: 'text', content: '结论:通过' }] })
    expect(facts().inspection?.issue).toBe('missing_report')
    expect(getStageCompleteDenial('inspect', facts())).toContain(`child_session_id: ${childId}`)
    run = { ...run, childRunId: 'followup-run', startedAt: enteredAt + 3 }
    await submit('pass', [])
    expect(facts().inspectorPassed).toBe(true)
  })

  it.each(['failed', 'cancelled', 'interrupted', 'running'] as const)('较新核验 %s 时不能复用旧 pass', async status => {
    await submit()
    const newer = { ...run, childRunId: 'newer-run', status, startedAt: enteredAt + 3 }
    expect(facts([run, newer])).toMatchObject({ inspectorPassed: false, inspection: { issue: 'not_completed' } })
  })

  it('新的完成运行不能复用同一子会话的旧结论', async () => {
    await submit()
    expect(facts([{ ...run, childRunId: 'newer-run', startedAt: enteredAt + 3 }]).inspection?.issue).toBe('missing_report')
  })

  it('回退重新进入验后拒绝旧阶段结果，即使投影时间更新', async () => {
    await submit()
    store.applyComposeStageTransition(parentId, { type: 'return', targetStage: 'build', reason: '需要修正' })
    store.applyComposeStageTransition(parentId, { type: 'complete' })
    expect(facts([{ ...run, startedAt: Date.now() + 100 }]).inspectorPassed).toBe(false)
  })

  it('身份缺失、主会话代交、越权参数和无效 verdict 均拒绝', async () => {
    const args = { verdict: 'pass', summary: 'ok' }
    expect((await inspectionReportTool.execute(args, { ...context(), invocationRef: undefined })).success).toBe(false)
    const primaryContext = { ...context(), sessionId: parentId, invocationRef: { ...context().invocationRef!, sessionId: parentId } }
    expect((await inspectionReportTool.execute(args, primaryContext)).error).toContain('只有 inspector')
    for (const invalid of [{ ...args, verdict: 'passed' }, { ...args, summary: ' ' }, { ...args, parentSessionId: 'other' }]) {
      expect((await inspectionReportTool.execute(invalid, context())).success).toBe(false)
    }
  })

  it('取消和过期 generation 不能提交，阶段改变后也不能补交', async () => {
    const args = { verdict: 'pass', summary: 'ok' }
    await expect(inspectionReportTool.execute(args, { ...context(), abortSignal: AbortSignal.abort() })).rejects.toThrow('已取消')
    await expect(inspectionReportTool.execute(args, { ...context(), assertExecutionCurrent: () => false })).rejects.toThrow('generation')
    store.applyComposeStageTransition(parentId, { type: 'complete' })
    expect((await inspectionReportTool.execute(args, context())).error).toContain('不在「验」阶段')
  })
})
