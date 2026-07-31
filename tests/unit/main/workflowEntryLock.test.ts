/**
 * 会话入口锁决策。
 *
 * 重点是回归保护：编排运行态新增了一条拒绝分支，默认 / plan 模式的 steering queue
 * 行为必须一字不变——turn 占用中且没有编排 run 时，永远只能是排队。
 */
import { describe, expect, it } from 'vitest'
import { resolveEntryLockAction } from '../../../src/main/agent/turn/entryLock'

const workflowRun = { runId: 'run-1', workflow: 'compose', phase: 'implement' }

describe('resolveEntryLockAction', () => {
  it('入口空闲 → proceed', () => {
    expect(
      resolveEntryLockAction({
        turnInProgress: false,
        resumable: false,
        activeWorkflowRun: null
      })
    ).toEqual({ kind: 'proceed' })
  })

  it('可 resume 的 run 让行，即使 turn 在进行中', () => {
    expect(
      resolveEntryLockAction({
        turnInProgress: true,
        resumable: true,
        activeWorkflowRun: null
      })
    ).toEqual({ kind: 'proceed' })
  })

  it('默认模式回归：turn 占用中且无编排 run → 仍然进 steering queue', () => {
    expect(
      resolveEntryLockAction({
        turnInProgress: true,
        resumable: false,
        activeWorkflowRun: null
      })
    ).toEqual({ kind: 'steer' })
  })

  it('编排运行中 → 拒绝并回运行态信号，不排队', () => {
    expect(
      resolveEntryLockAction({
        turnInProgress: true,
        resumable: false,
        activeWorkflowRun: workflowRun
      })
    ).toEqual({ kind: 'workflow_busy', run: workflowRun })
  })

  it('编排 run 存在但入口空闲时不拦截（run 已终态、turn 已释放）', () => {
    expect(
      resolveEntryLockAction({
        turnInProgress: false,
        resumable: false,
        activeWorkflowRun: workflowRun
      })
    ).toEqual({ kind: 'proceed' })
  })

  it('resumable 优先于编排分支，避免旧 XForge 恢复路径被误拦', () => {
    expect(
      resolveEntryLockAction({
        turnInProgress: true,
        resumable: true,
        activeWorkflowRun: workflowRun
      })
    ).toEqual({ kind: 'proceed' })
  })
})
