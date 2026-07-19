import { XForgeRunService } from '../../../../../src/runtime/workflow/xforge/XForgeRunService'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RunCoordinator } from '../../../../../src/runtime/run/RunCoordinator'
import { RunStore } from '../../../../../src/runtime/run/RunStore'
import {
  XForgeDeliveryExecutor,
  buildWriteBoundary,
  createInitialXForgeRunState,
  isForbiddenXForgeSideEffectCommand,
  type XForgeDeliveryHost,
  type XForgeReviewFindingState,
  type XForgeStage,
  type XForgeValidatedPlan
} from '../../../../../src/runtime/workflow/xforge'
import type { SkillManifest } from '../../../../../src/runtime/skills/types'
import { bindXForgeTestExecution } from './testExecution'

function validPlan(): XForgeValidatedPlan {
  return {
    version: 1,
    goal: '完成交付闭环',
    constraints: ['不自动提交'],
    nonGoals: ['不做 M4'],
    repositoryFacts: ['已有 M2 执行器'],
    changeScope: ['src/runtime/workflow/xforge'],
    tasks: [{ id: 'task-1', title: '实现 M3', acceptance: ['定向测试通过'] }],
    acceptanceMap: { 'task-1': ['定向测试通过'] },
    verificationChecklist: ['npm run typecheck'],
    risks: ['模型不得自报测试通过']
  }
}

function artifact(stage: XForgeStage) {
  return { stage, artifactId: `${stage}-artifact`, path: `${stage}.md` }
}

function finding(
  severity: XForgeReviewFindingState['severity'],
  summary = '审查发现'
): XForgeReviewFindingState {
  return {
    severity,
    location: 'src/example.ts:1',
    summary,
    evidence: '可复现证据',
    suggestion: '修复建议'
  }
}

function baseHost(overrides: Partial<XForgeDeliveryHost> = {}): XForgeDeliveryHost {
  return {
    activateStage: vi.fn(),
    captureWorkspaceFingerprint: vi.fn(async ({ workspaceRevision }) => ({
      revision: workspaceRevision,
      digest: `fp-${workspaceRevision}`,
      capturedAt: Date.now()
    })),
    resolveControlledTestCommands: vi.fn(async () => ({
      commands: [{ command: 'npm run typecheck', required: true, reason: '类型门禁' }]
    })),
    runControlledCommand: vi.fn(async () => ({
      exitCode: 0,
      timedOut: false,
      evidenceRef: { kind: 'runtime-command', note: 'exitCode=0' }
    })),
    recordTestEvidence: vi.fn(async () => ({
      artifact: artifact('test'),
      evidenceRef: { kind: 'test-gate', note: 'runtime evidence' }
    })),
    createReviewSnapshot: vi.fn(async () => ({
      snapshot: {
        changedFiles: ['src/example.ts'],
        files: [{ path: 'src/example.ts', content: 'export const value = 1' }],
        diff: '+export const value = 1',
        evidenceRef: { kind: 'review-input', note: 'runtime snapshot' },
        targetKind: 'run_effects' as const
      }
    })),
    runReviewSubagent: vi.fn(async () => ({
      findings: [],
      artifact: artifact('review'),
      evidenceRef: { kind: 'review', note: 'isolated snapshot review' }
    })),
    prepareWriteBoundary: vi.fn(async ({ checkpointRef, workspaceRevision }) =>
      buildWriteBoundary({
        checkpointRef,
        fingerprint: {
          revision: workspaceRevision,
          digest: `fp-${workspaceRevision}`,
          capturedAt: Date.now()
        }
      })
    ),
    runFix: vi.fn(async () => ({
      expandsScope: false,
      artifact: artifact('fix')
    })),
    askShipIntent: vi.fn(async () => false),
    writeReport: vi.fn(async () => ({ artifact: artifact('report') })),
    ...overrides
  }
}

const methodRegistry = {
  get(name: string): SkillManifest | undefined {
    if (name !== 'br-debug') return undefined
    return {
      name,
      description: name,
      userInvocable: false,
      modelInvocable: true,
      body: '# debug',
      source: 'builtin',
      sourcePath: `.nova/skills/${name}/SKILL.md`,
      directory: `.nova/skills/${name}`,
      warnings: [],
      hasSupportingFiles: false,
      enabled: true
    }
  }
}

describe('XForgeDeliveryExecutor', () => {
  it('全阶段副作用禁令与阶段名无关，只拦截提交和发布类命令', () => {
    expect(isForbiddenXForgeSideEffectCommand('git commit -m test')).toBe(true)
    expect(isForbiddenXForgeSideEffectCommand('git push origin main')).toBe(true)
    expect(isForbiddenXForgeSideEffectCommand('npm publish')).toBe(true)
    expect(isForbiddenXForgeSideEffectCommand('npm run deploy')).toBe(true)
    expect(isForbiddenXForgeSideEffectCommand('gh release create v1.0.0')).toBe(true)
    expect(isForbiddenXForgeSideEffectCommand('npm test')).toBe(false)
    expect(isForbiddenXForgeSideEffectCommand('New-Item docs/idea.md')).toBe(false)
  })

  let tmpDir: string
  let store: RunStore
  let coord: RunCoordinator
  let service: XForgeRunService

  const execution = (runId: string) => bindXForgeTestExecution(service, coord, runId)

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-delivery-'))
    store = new RunStore({ runsRoot: tmpDir })
    coord = new RunCoordinator({ store })
    service = new XForgeRunService(coord)
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('测试是否通过只取 Runtime Command；失败后 fix 必须重新 test 再 review', async () => {
    const runId = startAt('test')
    let testAttempt = 0
    const events: string[] = []
    const host = baseHost({
      activateStage: vi.fn(async ({ stage }) => { events.push(stage) }),
      runControlledCommand: vi.fn(async () => {
        testAttempt += 1
        return {
          exitCode: testAttempt === 1 ? 1 : 0,
          timedOut: false,
          evidenceRef: { kind: 'runtime-command', note: `attempt=${testAttempt}` }
        }
      }),
      runFix: vi.fn(async () => ({ expandsScope: false, artifact: artifact('fix') }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('completed')
    expect(events).toEqual(['test', 'fix', 'test', 'review', 'report'])
    expect(host.runControlledCommand).toHaveBeenCalledTimes(2)
    expect(result.deliveryTestFixUsed).toBe(1)
    expect(result.testEvidence?.passed).toBe(true)
    expect(result.reportFacts?.testPassed).toBe(true)
  })

  it('Blocking Finding 修复后必重测再复审，模型不能直接跳到 report', async () => {
    const runId = startAt('test')
    let reviewAttempt = 0
    const host = baseHost({
      runReviewSubagent: vi.fn(async () => {
        reviewAttempt += 1
        return {
          findings: reviewAttempt === 1 ? [finding('high', '阻断问题')] : [],
          artifact: artifact('review'),
          evidenceRef: { kind: 'review', note: `attempt=${reviewAttempt}` }
        }
      })
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('completed')
    expect(host.runFix).toHaveBeenCalledOnce()
    expect(host.runControlledCommand).toHaveBeenCalledTimes(2)
    expect(host.runReviewSubagent).toHaveBeenCalledTimes(2)
    expect(result.reviewRemediationUsed).toBe(1)
  })

  it('medium/low/nit 只进入技术债，不消耗修复预算', async () => {
    const runId = startAt('test')
    const debt = [finding('medium'), finding('low'), finding('nit')]
    const host = baseHost({
      runReviewSubagent: vi.fn(async () => ({
        findings: debt,
        artifact: artifact('review'),
        evidenceRef: { kind: 'review' }
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('completed')
    expect(host.runFix).not.toHaveBeenCalled()
    expect(result.reviewRemediationUsed).toBe(0)
    expect(result.reportFacts?.technicalDebt).toHaveLength(3)
  })

  it('Test-Fix 预算耗尽仍失败时 waiting_user，不伪装完成', async () => {
    const runId = startAt('test')
    const host = baseHost({
      runControlledCommand: vi.fn(async () => ({
        exitCode: 1,
        timedOut: false,
        evidenceRef: { kind: 'runtime-command', note: 'failed' }
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.deliveryTestFixUsed).toBe(3)
    expect(host.runFix).toHaveBeenCalledTimes(3)
    expect(host.runControlledCommand).toHaveBeenCalledTimes(4)
    expect(host.runReviewSubagent).not.toHaveBeenCalled()
  })

  it('Review Blocking 两轮修复后仍存在时 waiting_user', async () => {
    const runId = startAt('test')
    const host = baseHost({
      runReviewSubagent: vi.fn(async () => ({
        findings: [finding('critical', '持续阻断')],
        artifact: artifact('review'),
        evidenceRef: { kind: 'review', note: 'blocking' }
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.reviewRemediationUsed).toBe(2)
    expect(host.runFix).toHaveBeenCalledTimes(2)
    expect(host.runControlledCommand).toHaveBeenCalledTimes(3)
    expect(host.runReviewSubagent).toHaveBeenCalledTimes(3)
  })

  it('Review 前测试证据与当前 Fingerprint 不一致时回到安全等待', async () => {
    const runId = startAt('review')
    execution(runId).commitXForgeStatePatch(runId, {
      testEvidence: {
        workspaceRevision: 1,
        fingerprint: { revision: 1, digest: 'stale', capturedAt: Date.now() },
        commands: [],
        passed: true,
        capturedAt: Date.now()
      }
    })
    const host = baseHost()

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.resumeTarget).toBe('test')
    expect(host.runReviewSubagent).not.toHaveBeenCalled()
  })

  it('reviewOnly 无新鲜测试证据时允许只读审查，但结论强制 unverified 且禁止 fix', async () => {
    const runId = startAt('review', true)
    const host = baseHost({
      runReviewSubagent: vi.fn(async ({ input }) => {
        expect(Object.isFrozen(input)).toBe(true)
        expect(Object.isFrozen(input.workspace.files[0])).toBe(true)
        expect(input.testEvidence).toBeNull()
        return {
          findings: [finding('high')],
          artifact: artifact('review'),
          evidenceRef: { kind: 'review-only' }
        }
      })
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('completed')
    expect(host.runFix).not.toHaveBeenCalled()
    expect(result.reportFacts?.blockingFindings[0]?.unverified).toBe(true)
  })

  it('Review 子代理执行期间工作区变化会破坏只读隔离并停止', async () => {
    const runId = startAt('review', true)
    let captureCount = 0
    const host = baseHost({
      captureWorkspaceFingerprint: vi.fn(async ({ workspaceRevision }) => ({
        revision: workspaceRevision,
        digest: captureCount++ === 0 ? 'before-review' : 'after-review',
        capturedAt: Date.now()
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toMatch(/违反只读隔离边界/)
    expect(host.writeReport).not.toHaveBeenCalled()
  })

  it('fix 出现 prepared EffectReceipt 时立即 waiting_user，禁止重复副作用', async () => {
    const runId = startAt('fix')
    const host = baseHost({
      runFix: vi.fn(async () => ({
        expandsScope: false,
        fileEffects: [{ path: 'src/example.ts', receiptId: 'effect-1', status: 'prepared' }],
        artifact: artifact('fix')
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toMatch(/Pending Side Effect/)
    expect(host.runControlledCommand).not.toHaveBeenCalled()
  })

  it('fix 漏报 EffectReceipt 但实际工作区变化时仍会被 Fingerprint 抓住', async () => {
    const runId = startAt('fix')
    let captureCount = 0
    const host = baseHost({
      captureWorkspaceFingerprint: vi.fn(async ({ workspaceRevision }) => ({
        revision: workspaceRevision,
        digest: captureCount++ === 0 ? 'changed-without-receipt' : 'changed-without-receipt',
        capturedAt: Date.now()
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toMatch(/未登记 EffectReceipt/)
    expect(host.runControlledCommand).not.toHaveBeenCalled()
  })

  it('fix 的 committed EffectReceipt 与 Runtime 指纹一致时递增 Revision 并重测', async () => {
    const runId = startAt('fix')
    const host = baseHost({
      runFix: vi.fn(async () => ({
        expandsScope: false,
        fileEffects: [{ path: 'src/example.ts', receiptId: 'effect-1', status: 'committed' }],
        workspaceFingerprint: { revision: 2, digest: 'fp-2', capturedAt: Date.now() },
        artifact: artifact('fix')
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('completed')
    expect(result.workspaceRevision).toBe(2)
    expect(result.testEvidence?.workspaceRevision).toBe(2)
    expect(result.hasValidScopePass).toBe(false)
  })

  it('fix 扩大范围时回到 plan 并失效 Validated Plan/Scope Pass', async () => {
    const runId = startAt('fix')
    const host = baseHost({
      runFix: vi.fn(async () => ({ expandsScope: true, artifact: artifact('fix') }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('plan')
    expect(result.hasValidatedPlan).toBe(false)
    expect(result.hasValidScopePass).toBe(false)
    expect(result.testEvidence).toBeNull()
  })

  it('Test Gate 环境阻塞时 waiting_user，且不进入 fix', async () => {
    const runId = startAt('test')
    const host = baseHost({
      runControlledCommand: vi.fn(async () => ({
        exitCode: null,
        timedOut: false,
        blockedReason: '缺少测试凭据',
        evidenceRef: { kind: 'runtime-command', note: 'blocked' }
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toContain('缺少测试凭据')
    expect(host.runFix).not.toHaveBeenCalled()
  })

  it('Test Gate 拒绝 commit/push/deploy/publish 等非验证命令', async () => {
    const runId = startAt('test')
    const host = baseHost({
      resolveControlledTestCommands: vi.fn(async () => ({
        commands: [{ command: 'npm test && git push', required: true, reason: '恶意混入副作用' }]
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toMatch(/拒绝非验证或高风险命令/)
    expect(host.runControlledCommand).not.toHaveBeenCalled()
  })

  it('Test Gate 拒绝伪装成验证的任意 shell/node 命令', async () => {
    const runId = startAt('test')
    const host = baseHost({
      resolveControlledTestCommands: vi.fn(async () => ({
        commands: [{
          command: 'node -e "require(\'fs\').writeFileSync(\'owned\',\'1\')"',
          required: true,
          reason: '伪装验证'
        }]
      }))
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(host.runControlledCommand).not.toHaveBeenCalled()
  })

  it('测试命令执行期间工作区内容变化会使证据失效', async () => {
    const runId = startAt('test')
    let captureCount = 0
    const host = baseHost({
      captureWorkspaceFingerprint: vi.fn(async ({ workspaceRevision }) => {
        captureCount += 1
        return {
          revision: workspaceRevision,
          digest: captureCount === 1 ? 'before' : 'after',
          capturedAt: Date.now()
        }
      })
    })

    const result = await run(runId, host)

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toMatch(/执行期间工作区发生变化/)
    expect(host.recordTestEvidence).not.toHaveBeenCalled()
  })

  it('报告事实由 Runtime 构造，明确 commit/push/deploy/publish 均未执行', async () => {
    const runId = startAt('test')
    const host = baseHost({ askShipIntent: vi.fn(async () => true) })

    const result = await run(runId, host)

    expect(result.reportFacts).toMatchObject({
      runId,
      shipRequested: true,
      notExecuted: ['commit', 'push', 'deploy', 'publish']
    })
    expect(host.writeReport).toHaveBeenCalledWith(expect.objectContaining({
      facts: expect.objectContaining({ notExecuted: ['commit', 'push', 'deploy', 'publish'] })
    }))
  })

  function startAt(stage: 'test' | 'review' | 'fix', reviewOnly = false): string {
    const snap = service.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: stage,
        reviewOnly,
        planVersion: 1,
        workspaceRevision: 1,
        hasValidatedPlan: true,
        hasValidScopePass: true
      })
    })
    coord.markRunning(snap.runId)
    execution(snap.runId).commitXForgeStatePatch(snap.runId, {
      validatedPlan: validPlan(),
      tasks: [{
        id: 'task-1',
        title: '实现 M3',
        status: 'done',
        acceptance: ['定向测试通过'],
        attempts: 1,
        evidenceRefs: []
      }]
    })
    return snap.runId
  }

  async function run(runId: string, host: XForgeDeliveryHost) {
    return new XForgeDeliveryExecutor({
      runId,
      committer: execution(runId),
      host,
      methodRegistry
    }).runDeliveryStages()
  }
})
