/**
 * 按会话的 turn 占用判断单测（isSessionTurnInProgress + hasActiveRunForSession）。
 *
 * 用真实 RunCoordinator + RunExecutionRegistry（tmp dir），验证：
 * - 同会话有 running run 时该会话占用 turn；
 * - 不同会话互不影响；
 * - 终态后释放。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RunCoordinator } from '../../../src/runtime/run/RunCoordinator'
import { RunStore } from '../../../src/runtime/run/RunStore'
import { RunExecutionRegistry } from '../../../src/runtime/run/RunExecutionRegistry'

describe('按会话 turn 占用判断', () => {
  let tmpDir: string
  let coord: RunCoordinator
  let registry: RunExecutionRegistry

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nova-session-turn-'))
    const store = new RunStore({ runsRoot: tmpDir })
    coord = new RunCoordinator({ store })
    registry = new RunExecutionRegistry()
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('hasActiveRunForSession：同会话 running 时为 true，其它会话为 false', () => {
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    expect(coord.hasActiveRunForSession('s1')).toBe(true)
    expect(coord.hasActiveRunForSession('s2')).toBe(false)
  })

  it('不同会话可同时持 active run（并发前提）', () => {
    const a = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    const b = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's2' })
    coord.markRunning(a.runId)
    coord.markRunning(b.runId)
    expect(coord.hasActiveRunForSession('s1')).toBe(true)
    expect(coord.hasActiveRunForSession('s2')).toBe(true)
  })

  it('waiting_user 也算占用 turn', () => {
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    coord.transition(snap.runId, 'waiting_user', 'test')
    expect(coord.hasActiveRunForSession('s1')).toBe(true)
  })

  it('终态后释放占用', () => {
    const snap = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1' })
    coord.markRunning(snap.runId)
    coord.commitTerminal({ runId: snap.runId, status: 'completed' })
    expect(coord.hasActiveRunForSession('s1')).toBe(false)
  })

  it('RunExecutionRegistry.listActiveRunIds 反映当前持有句柄的 run', () => {
    expect(registry.listActiveRunIds()).toEqual([])
    let resolveSettled!: () => void
    registry.register({
      runId: 'run1',
      generation: 1,
      kind: 'agent',
      abort: () => {},
      settled: new Promise<void>(r => { resolveSettled = r })
    })
    expect(registry.listActiveRunIds()).toEqual(['run1'])
    resolveSettled()
  })
})
