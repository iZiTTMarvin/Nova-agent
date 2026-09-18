/**
 * 按会话的 turn 占用判断单测（isSessionTurnInProgress + hasActiveRunForSession）。
 *
 * 用真实 RunCoordinator + RunExecutionRegistry（tmp dir），验证：
 * - 同会话有 running run 时该会话占用 turn；
 * - 不同会话互不影响；
 * - 终态后释放；
 * - excludeRunId 排除自身执行身份后不再把自己当成并发 turn。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RunCoordinator } from '../../../src/runtime/run/RunCoordinator'
import { RunStore } from '../../../src/runtime/run/RunStore'
import { RunExecutionRegistry } from '../../../src/runtime/run/RunExecutionRegistry'
import type * as AgentState from '../../../src/main/agent/state'
import { resetRunCoordinatorHostForTests } from '../../../src/main/services/RunCoordinatorHost'

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

  it('excludeRunId 是唯一占用者时返回 false，其它占用者仍在时返回 true', () => {
    const mine = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1', runId: 'run-mine' })
    coord.markRunning(mine.runId)
    const other = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1', runId: 'run-other' })
    coord.markRunning(other.runId)

    expect(coord.hasActiveRunForSession('s1', { excludeRunId: 'run-mine' })).toBe(true)
    coord.commitTerminal({ runId: other.runId, status: 'completed' })
    expect(coord.hasActiveRunForSession('s1', { excludeRunId: 'run-mine' })).toBe(false)
    expect(coord.hasActiveRunForSession('s1')).toBe(true)
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

describe('isSessionTurnInProgress 的 excludeRunId', () => {
  let tmpDir: string
  let coord: RunCoordinator
  let registry: RunExecutionRegistry
  let state: typeof AgentState

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nova-session-turn-exclude-'))
    coord = new RunCoordinator({ store: new RunStore({ runsRoot: tmpDir }) })
    registry = new RunExecutionRegistry()
    // 只替换宿主单例的取值，真实 RunCoordinator / Registry 仍是权威状态源
    vi.doMock('../../../src/main/services/RunCoordinatorHost', () => ({
      getRunCoordinator: () => coord,
      getRunExecutionRegistry: () => registry
    }))
    state = await import('../../../src/main/agent/state')

    const mine = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1', runId: 'run-mine' })
    coord.markRunning(mine.runId)
    registry.register({
      runId: mine.runId,
      generation: 1,
      kind: 'agent',
      abort: () => {},
      settled: new Promise<void>(() => {})
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetRunCoordinatorHostForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('排除自身 run 后该会话不再算占用，排除其它 run 仍为占用', () => {
    expect(state.isSessionTurnInProgress('s1')).toBe(true)

    // 接力接管会先建自身 queued run 再入场：不排除自身会把自己当成并发 turn 而永久入队
    expect(state.isSessionTurnInProgress('s1', { excludeRunId: 'run-mine' })).toBe(false)
    expect(state.isSessionTurnInProgress('s1', { excludeRunId: 'run-other' })).toBe(true)

    const other = coord.startRun({ kind: 'agent', workspaceId: '/ws', sessionId: 's1', runId: 'run-other' })
    coord.markRunning(other.runId)
    expect(state.isSessionTurnInProgress('s1', { excludeRunId: 'run-mine' })).toBe(true)
  })
})
