/**
 * RunCoordinator × XForge Stage Run 状态契约
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RunStore } from '../../../../src/runtime/run/RunStore'
import { RunCoordinator } from '../../../../src/runtime/run/RunCoordinator'
import {
  SCOPE_CORRECTION_BUDGET,
  applyXForgeStageTransition,
  createInitialXForgeRunState,
  nextAfterScopeCheck,
  transition
} from '../../../../src/runtime/workflow/xforge'

describe('RunCoordinator XForge 状态契约', () => {
  let tmpDir: string
  let store: RunStore
  let coord: RunCoordinator

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-run-'))
    store = new RunStore({ runsRoot: tmpDir })
    coord = new RunCoordinator({ store })
  })

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  it('waiting_user 只能从持久化 resumeTarget 恢复并记录用户决策', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 'session-resume',
      xforge: createInitialXForgeRunState({ currentStage: 'scope_check' })
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'scope_check',
      to: 'waiting_user',
      reason: '需要用户决策'
    }, { resumeTarget: 'plan' })

    const resumed = coord.resumeXForgeRun(snap.runId, '缩小变更范围')

    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    expect(resumed.snapshot.status).toBe('running')
    expect(resumed.xforge.currentStage).toBe('plan')
    expect(resumed.xforge.resumeTarget).toBeNull()
    expect(resumed.xforge.mainSession.userDecisions).toContain('缩小变更范围')
  })

  it('startXForgeRun 后 snapshot 含初始 stage state', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf',
      reviewOnly: false
    })
    expect(snap.kind).toBe('xforge')
    expect(snap.xforge).toBeTruthy()
    expect(snap.xforge?.currentStage).toBe('resolve')
    expect(snap.xforge?.reviewOnly).toBe(false)
    expect(snap.xforge?.planVersion).toBeNull()
    expect(snap.xforge?.workspaceRevision).toBe(0)
    expect(snap.xforge?.scopeCorrectionUsed).toBe(0)
    expect(snap.xforge?.deliveryTestFixUsed).toBe(0)
    expect(snap.xforge?.reviewRemediationUsed).toBe(0)
    expect(snap.xforge?.suspendedStage).toBeNull()
    expect(snap.xforge?.resumeTarget).toBeNull()
    expect(snap.xforge?.waitingReason).toBeNull()
    expect(snap.xforge?.stageArtifacts).toEqual([])
    expect(snap.xforge?.evidenceRefs).toEqual([])
    expect(snap.xforge?.testEvidence).toBeNull()
    expect(snap.xforge?.reviewFindings).toEqual([])
    expect(snap.xforge?.technicalDebt).toEqual([])
    expect(snap.xforge?.reportFacts).toBeNull()

    const disk = store.loadSnapshot(snap.runId)
    expect(disk?.kind).toBe('xforge')
    expect(disk?.xforge?.currentStage).toBe('resolve')
  })

  it('stage transition 原子更新 currentStage 与预算计数', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf'
    })
    coord.markRunning(snap.runId, 'm1')

    const toScope = transition(
      {
        currentStage: 'resolve',
        reviewOnly: false,
        hasValidatedPlan: true,
        hasValidScopePass: false,
        scopeCorrectionUsed: 0,
        deliveryTestFixUsed: 0,
        reviewRemediationUsed: 0
      },
      'scope_check'
    )
    expect(toScope.ok).toBe(true)

    const r1 = coord.commitXForgeStageTransition(snap.runId, toScope, {
      hasValidatedPlan: true,
      planVersion: 1,
      workspaceRevision: 3
    })
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    expect(r1.xforge.currentStage).toBe('scope_check')
    expect(r1.xforge.planVersion).toBe(1)
    expect(r1.xforge.workspaceRevision).toBe(3)
    expect(r1.snapshot.sequence).toBeGreaterThan(snap.sequence)

    const afterHigh = nextAfterScopeCheck(
      {
        currentStage: 'scope_check',
        reviewOnly: false,
        hasValidatedPlan: true,
        hasValidScopePass: false,
        scopeCorrectionUsed: 0,
        deliveryTestFixUsed: 0,
        reviewRemediationUsed: 0
      },
      true
    )
    const r2 = coord.commitXForgeStageTransition(snap.runId, afterHigh)
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.xforge.currentStage).toBe('plan')
    expect(r2.xforge.scopeCorrectionUsed).toBe(1)

    const disk = store.loadSnapshot(snap.runId)
    expect(disk?.xforge?.currentStage).toBe('plan')
    expect(disk?.xforge?.scopeCorrectionUsed).toBe(1)
    expect(disk?.sequence).toBe(r2.snapshot.sequence)
  })

  it('waiting_user 保存 suspendedStage / resumeTarget / reason', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf'
    })
    coord.markRunning(snap.runId, 'm1')

    coord.commitXForgeStageTransition(
      snap.runId,
      transition(
        {
          currentStage: 'resolve',
          reviewOnly: false,
          hasValidatedPlan: true,
          hasValidScopePass: false,
          scopeCorrectionUsed: 0,
          deliveryTestFixUsed: 0,
          reviewRemediationUsed: 0
        },
        'scope_check'
      ),
      { hasValidatedPlan: true, planVersion: 1, workspaceRevision: 1 }
    )

    const wait = nextAfterScopeCheck(
      {
        currentStage: 'scope_check',
        reviewOnly: false,
        hasValidatedPlan: true,
        hasValidScopePass: false,
        scopeCorrectionUsed: SCOPE_CORRECTION_BUDGET,
        deliveryTestFixUsed: 0,
        reviewRemediationUsed: 0
      },
      true
    )
    expect(wait.ok).toBe(true)

    const aligned = coord.commitXForgeStageTransition(snap.runId, wait)
    expect(aligned.ok).toBe(true)
    if (!aligned.ok) return
    expect(aligned.xforge.currentStage).toBe('waiting_user')
    expect(aligned.xforge.suspendedStage).toBe('scope_check')
    expect(aligned.xforge.resumeTarget).toBe('scope_check')
    expect(aligned.xforge.waitingReason).toMatch(/预算|HIGH|Scope/)
    expect(aligned.snapshot.status).toBe('waiting_user')

    const disk = store.loadSnapshot(snap.runId)
    expect(disk?.xforge?.suspendedStage).toBe('scope_check')
    expect(disk?.xforge?.resumeTarget).toBe('scope_check')
    expect(disk?.xforge?.waitingReason).toBeTruthy()
  })

  it('result.from 与 currentStage 不一致时拒绝', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf'
    })
    coord.markRunning(snap.runId)

    const mismatched = coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'review',
      to: 'report',
      reason: '伪造跨阶段推进'
    })
    expect(mismatched.ok).toBe(false)
    if (!mismatched.ok) expect(mismatched.code).toBe('from_mismatch')
    expect(store.loadSnapshot(snap.runId)?.xforge?.currentStage).toBe('resolve')

    const pure = applyXForgeStageTransition(createInitialXForgeRunState(), {
      ok: true,
      from: 'review',
      to: 'report',
      reason: '跨阶段'
    })
    expect(pure.ok).toBe(false)
    if (!pure.ok) expect(pure.code).toBe('from_mismatch')
  })

  it('XForge 终态阶段同步 RunSnapshot.status，并拒绝后续更新', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf'
    })
    coord.markRunning(snap.runId)

    const toReport = coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'resolve',
      to: 'report',
      reason: '测试直达 report'
    })
    expect(toReport.ok).toBe(true)
    if (toReport.ok) expect(toReport.snapshot.status).toBe('running')

    const done = coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'report',
      to: 'completed',
      reason: '完成'
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.xforge.currentStage).toBe('completed')
    expect(done.snapshot.status).toBe('completed')
    expect(done.snapshot.terminalReason).toBe('完成')
    expect(done.snapshot.terminalTransitionId).toBeTruthy()
    expect(coord.listActiveRuns().some(r => r.runId === snap.runId)).toBe(false)

    const rejected = coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'completed',
      to: 'plan',
      reason: '复活'
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('run_ended')
    expect(store.loadSnapshot(snap.runId)?.status).toBe('completed')
    expect(store.loadSnapshot(snap.runId)?.xforge?.currentStage).toBe('completed')
  })

  it('run 硬终态后拒绝后续 stage 更新', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf'
    })
    coord.markRunning(snap.runId)
    coord.commitTerminal({ runId: snap.runId, status: 'cancelled', reason: 'user' })

    const rejected = coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'resolve',
      to: 'brainstorm',
      reason: '迟到事件'
    })
    expect(rejected.ok).toBe(false)
    if (!rejected.ok) expect(rejected.code).toBe('run_ended')
  })

  it('磁盘恢复后仍可读 xforge 状态', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf',
      reviewOnly: true
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'resolve',
      to: 'review',
      reason: 'reviewOnly'
    })

    const coord2 = new RunCoordinator({ store })
    const loaded = coord2.getSnapshot(snap.runId)
    expect(loaded?.xforge?.currentStage).toBe('review')
    expect(loaded?.xforge?.reviewOnly).toBe(true)
  })

  it('agent / compose run 不带 xforge，既有行为不变', () => {
    const agent = coord.startRun({
      kind: 'agent',
      workspaceId: '/ws',
      sessionId: 's-agent'
    })
    expect(agent.xforge).toBeUndefined()
    const agentRunning = coord.markRunning(agent.runId, 'ma')
    expect(agentRunning?.status).toBe('running')
    expect(agentRunning?.xforge).toBeUndefined()

    const compose = coord.startRun({
      kind: 'compose',
      workspaceId: '/ws',
      sessionId: 's-compose'
    })
    expect(compose.kind).toBe('compose')
    expect(compose.xforge).toBeUndefined()

    const xfReject = coord.commitXForgeStageTransition(agent.runId, {
      ok: true,
      from: 'resolve',
      to: 'plan',
      reason: '误用'
    })
    expect(xfReject.ok).toBe(false)
    if (!xfReject.ok) expect(xfReject.code).toBe('not_xforge')
    expect(store.loadSnapshot(agent.runId)?.status).toBe('running')
    expect(store.loadSnapshot(agent.runId)?.xforge).toBeUndefined()
  })

  it('xforge_stage_commit 事件重放恢复 waiting_user 的 status/progress/xforge', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf',
      runId: 'xf_replay_wait'
    })
    coord.markRunning(snap.runId, 'm1')
    coord.commitXForgeStageTransition(
      snap.runId,
      transition(
        {
          currentStage: 'resolve',
          reviewOnly: false,
          hasValidatedPlan: true,
          hasValidScopePass: false,
          scopeCorrectionUsed: 0,
          deliveryTestFixUsed: 0,
          reviewRemediationUsed: 0
        },
        'scope_check'
      ),
      { hasValidatedPlan: true, planVersion: 1, workspaceRevision: 1 }
    )
    const wait = nextAfterScopeCheck(
      {
        currentStage: 'scope_check',
        reviewOnly: false,
        hasValidatedPlan: true,
        hasValidScopePass: false,
        scopeCorrectionUsed: SCOPE_CORRECTION_BUDGET,
        deliveryTestFixUsed: 0,
        reviewRemediationUsed: 0
      },
      true
    )
    const committed = coord.commitXForgeStageTransition(snap.runId, wait)
    expect(committed.ok).toBe(true)
    if (!committed.ok) return

    const waitEvent = store
      .loadEvents(snap.runId)
      .events.find(
        e =>
          e.type === 'xforge_stage_commit' &&
          (e.payload as { to?: string } | undefined)?.to === 'waiting_user'
      )
    expect(waitEvent).toBeTruthy()

    const snapPath = path.join(tmpDir, snap.runId, 'snapshot.json')
    const stale = store.loadSnapshot(snap.runId)!
    // 模拟 snapshot 未跟上 waiting_user 的 xforge_stage_commit
    stale.sequence = waitEvent!.sequence - 1
    stale.status = 'running'
    stale.progress = null
    stale.xforge = {
      ...stale.xforge!,
      currentStage: 'scope_check',
      suspendedStage: null,
      resumeTarget: null,
      waitingReason: null
    }
    fs.writeFileSync(snapPath, JSON.stringify(stale, null, 2), 'utf8')

    const replayed = store.loadSnapshotWithReplay(snap.runId)!
    expect(replayed.sequence).toBeGreaterThanOrEqual(waitEvent!.sequence)
    expect(replayed.status).toBe('waiting_user')
    expect(replayed.progress?.label).toMatch(/预算|HIGH|Scope/)
    expect(replayed.xforge?.currentStage).toBe('waiting_user')
    expect(replayed.xforge?.suspendedStage).toBe('scope_check')
    expect(replayed.xforge?.resumeTarget).toBe('scope_check')
  })

  it('xforge_state_patch 事件重放恢复同阶段任务状态', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf',
      runId: 'xf_replay_patch',
      xforge: createInitialXForgeRunState({ currentStage: 'implement' })
    })
    coord.markRunning(snap.runId)
    const patched = coord.commitXForgeStatePatch(
      snap.runId,
      {
        tasks: [
          {
            id: 'task-1',
            title: '任务',
            status: 'skipped',
            acceptance: ['验收'],
            attempts: 3,
            evidenceRefs: [],
            failureReason: 'verify failed'
          }
        ],
        activeTaskId: null
      },
      '任务跳过'
    )
    expect(patched.ok).toBe(true)
    if (!patched.ok) return

    const patchEvent = store
      .loadEvents(snap.runId)
      .events.find(e => e.type === 'xforge_state_patch')
    expect(patchEvent).toBeTruthy()

    const snapPath = path.join(tmpDir, snap.runId, 'snapshot.json')
    const stale = store.loadSnapshot(snap.runId)!
    stale.sequence = patchEvent!.sequence - 1
    stale.xforge = {
      ...stale.xforge!,
      tasks: [],
      activeTaskId: 'task-1'
    }
    fs.writeFileSync(snapPath, JSON.stringify(stale, null, 2), 'utf8')

    const replayed = store.loadSnapshotWithReplay(snap.runId)!
    expect(replayed.xforge?.tasks[0]).toMatchObject({
      id: 'task-1',
      status: 'skipped',
      attempts: 3,
      failureReason: 'verify failed'
    })
    expect(replayed.xforge?.activeTaskId).toBeNull()
  })

  it('xforge_state_patch 事件重放恢复 M3 测试证据与技术债', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf',
      runId: 'xf_replay_delivery',
      xforge: createInitialXForgeRunState({ currentStage: 'review', workspaceRevision: 2 })
    })
    coord.markRunning(snap.runId)
    const patched = coord.commitXForgeStatePatch(snap.runId, {
      testEvidence: {
        workspaceRevision: 2,
        fingerprint: { revision: 2, digest: 'fp-2', capturedAt: 1 },
        commands: [{
          command: 'npm test',
          required: true,
          exitCode: 0,
          timedOut: false,
          evidenceRef: { kind: 'runtime-command', note: 'passed' }
        }],
        passed: true,
        capturedAt: 2
      },
      technicalDebt: [{
        severity: 'medium',
        location: 'src/a.ts:1',
        summary: '可维护性问题',
        evidence: '重复逻辑'
      }]
    }, 'M3 事实更新')
    expect(patched.ok).toBe(true)
    if (!patched.ok) return

    const patchEvent = store.loadEvents(snap.runId).events.find(e => e.type === 'xforge_state_patch')!
    const snapPath = path.join(tmpDir, snap.runId, 'snapshot.json')
    const stale = store.loadSnapshot(snap.runId)!
    stale.sequence = patchEvent.sequence - 1
    stale.xforge = {
      ...stale.xforge!,
      testEvidence: null,
      technicalDebt: []
    }
    fs.writeFileSync(snapPath, JSON.stringify(stale, null, 2), 'utf8')

    const replayed = store.loadSnapshotWithReplay(snap.runId)!
    expect(replayed.xforge?.testEvidence?.passed).toBe(true)
    expect(replayed.xforge?.testEvidence?.fingerprint.digest).toBe('fp-2')
    expect(replayed.xforge?.technicalDebt[0]?.severity).toBe('medium')
  })

  it('xforge_stage_commit 事件重放恢复 completed 终态语义', () => {
    const snap = coord.startXForgeRun({
      workspaceId: '/ws',
      sessionId: 's-xf',
      runId: 'xf_replay_done'
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'resolve',
      to: 'report',
      reason: '到 report'
    })
    const done = coord.commitXForgeStageTransition(snap.runId, {
      ok: true,
      from: 'report',
      to: 'completed',
      reason: '完成汇报'
    })
    expect(done.ok).toBe(true)
    if (!done.ok) return

    const completedEvent = store
      .loadEvents(snap.runId)
      .events.find(
        e =>
          e.type === 'xforge_stage_commit' &&
          (e.payload as { to?: string } | undefined)?.to === 'completed'
      )
    expect(completedEvent).toBeTruthy()
    expect(completedEvent!.payload).toMatchObject({
      status: 'completed',
      terminalReason: '完成汇报'
    })

    const snapPath = path.join(tmpDir, snap.runId, 'snapshot.json')
    const stale = store.loadSnapshot(snap.runId)!
    stale.sequence = completedEvent!.sequence - 1
    stale.status = 'running'
    delete stale.terminalReason
    delete stale.terminalTransitionId
    stale.xforge = {
      ...stale.xforge!,
      currentStage: 'report',
      lastTransitionReason: '到 report'
    }
    fs.writeFileSync(snapPath, JSON.stringify(stale, null, 2), 'utf8')

    const replayed = store.loadSnapshotWithReplay(snap.runId)!
    expect(replayed.sequence).toBeGreaterThanOrEqual(completedEvent!.sequence)
    expect(replayed.status).toBe('completed')
    expect(replayed.terminalReason).toBe('完成汇报')
    expect(replayed.terminalTransitionId).toBeTruthy()
    expect(replayed.xforge?.currentStage).toBe('completed')
  })
})
