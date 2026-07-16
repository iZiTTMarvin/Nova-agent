import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RunCoordinator } from '../../../../../src/runtime/run/RunCoordinator'
import { RunStore } from '../../../../../src/runtime/run/RunStore'
import {
  XForgeStageExecutor,
  buildWriteBoundary,
  createInitialXForgeRunState,
  type XForgeStageHost,
  type XForgeValidatedPlan
} from '../../../../../src/runtime/workflow/xforge'
import type { SkillManifest } from '../../../../../src/runtime/skills/types'

function validPlan(version: number): XForgeValidatedPlan {
  return {
    version,
    goal: '实现 M2',
    constraints: ['不自动 commit'],
    nonGoals: ['不做 M3'],
    repositoryFacts: ['已有 StageController'],
    changeScope: ['src/runtime/workflow/xforge'],
    tasks: [{ id: 'task-1', title: '实现任务循环', acceptance: ['三次失败可跳过'] }],
    acceptanceMap: { 'task-1': ['三次失败可跳过'] },
    verificationChecklist: ['npx vitest run tests/unit/runtime/workflow/xforge/stageExecutor.test.ts'],
    risks: ['Scope HIGH 不能硬闯']
  }
}

function baseHost(overrides: Partial<XForgeStageHost> = {}): XForgeStageHost {
  return {
    activateStage: vi.fn(),
    askQuestion: vi.fn(async () => [{ selectedLabels: ['继续'] }]),
    buildExplorationQuestions: vi.fn(async () => [{
      question: '本轮最重要的约束是什么？',
      options: [{ label: '保持当前范围' }],
      custom: true
    }]),
    runBrainstorm: vi.fn(async () => ({
      needsMoreClarification: false,
      mainSession: {
        goal: '实现 M2',
        constraints: ['不自动 commit'],
        nonGoals: ['不做 M3'],
        userDecisions: []
      },
      artifact: stageArtifact('brainstorm')
    })),
    runPlan: vi.fn(async () => ({
      plan: validPlan(1),
      workspaceRevision: 1,
      artifact: stageArtifact('plan')
    })),
    runScopeCheck: vi.fn(async () => ({
      findings: [],
      evidenceRef: { kind: 'scope-check', note: 'runtime scope result' },
      artifact: stageArtifact('scope_check')
    })),
    prepareWriteBoundary: vi.fn(async ({ checkpointRef, workspaceRevision }) =>
      buildWriteBoundary({
        checkpointRef,
        fingerprint: { revision: workspaceRevision, digest: 'fp', capturedAt: Date.now() }
      })
    ),
    runImplementTask: vi.fn(async () => ({
      verification: { outcome: 'passed', command: 'targeted-test', exitCode: 0, timedOut: false },
      evidenceRef: { kind: 'task-verification', note: 'exitCode=0' }
    })),
    completeImplement: vi.fn(async () => ({ artifact: stageArtifact('implement') })),
    ...overrides
  }
}

function stageArtifact(stage: 'brainstorm' | 'plan' | 'scope_check' | 'implement') {
  return { stage, artifactId: `${stage}-artifact`, path: `${stage}.md` }
}

const methodRegistry = {
  get(name: string): SkillManifest {
    return {
      name,
      description: name,
      userInvocable: false,
      modelInvocable: true,
      body: '# method',
      source: 'builtin',
      sourcePath: `.nova/skills/${name}/SKILL.md`,
      directory: `.nova/skills/${name}`,
      warnings: [],
      hasSupportingFiles: false,
      enabled: true
    }
  }
}

describe('XForgeStageExecutor M2', () => {
  let tmpDir: string
  let store: RunStore
  let coord: RunCoordinator

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nova-xforge-exec-'))
    store = new RunStore({ runsRoot: tmpDir })
    coord = new RunCoordinator({ store })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('brainstorm 阶段必须先 askQuestion；无回答则停在 waiting_user', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({ currentStage: 'brainstorm' })
    })
    coord.markRunning(snap.runId)
    const host = baseHost({
      askQuestion: vi.fn(async () => []),
      runBrainstorm: vi.fn(async () => {
        throw new Error('不应在无回答时运行 brainstorm')
      })
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.askQuestion).toHaveBeenCalledOnce()
    expect(host.runBrainstorm).not.toHaveBeenCalled()
    expect(result.currentStage).toBe('waiting_user')
    expect(result.suspendedStage).toBe('brainstorm')
    expect(coord.getSnapshot(snap.runId)?.status).toBe('waiting_user')
  })

  it('探索问题由宿主逐轮生成；选择暂存会保留决策并安全暂停', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({ currentStage: 'brainstorm' })
    })
    coord.markRunning(snap.runId)
    const host = baseHost({
      buildExplorationQuestions: vi.fn(async ({ round }) => [{
        question: `第 ${round} 轮的真实约束是什么？`,
        options: [{ label: '限定范围' }],
        custom: true
      }]),
      askQuestion: vi.fn(async () => [{ selectedLabels: ['暂存本轮 XForge'] }]),
      runBrainstorm: vi.fn(async () => {
        throw new Error('暂存时不应生成设计产物')
      })
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.buildExplorationQuestions).toHaveBeenCalledWith(expect.objectContaining({ round: 1 }))
    expect(host.askQuestion).toHaveBeenCalledWith(expect.objectContaining({
      questions: [expect.objectContaining({
        question: '第 1 轮的真实约束是什么？',
        options: expect.arrayContaining([expect.objectContaining({ label: '暂存本轮 XForge' })])
      })]
    }))
    expect(host.runBrainstorm).not.toHaveBeenCalled()
    expect(result.currentStage).toBe('waiting_user')
    expect(result.resumeTarget).toBe('brainstorm')
    expect(result.mainSession.userDecisions).toContain('暂存本轮 XForge')
  })

  it('探索最多允许三轮，后续轮次携带已收集决策而不是重复固定问题', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({ currentStage: 'brainstorm' })
    })
    coord.markRunning(snap.runId)
    const host = baseHost({
      buildExplorationQuestions: vi.fn(async ({ round, context }) => [{
        question: round === 1 ? '谁是首批用户？' : `已知决策 ${context.mainSession.userDecisions.join('、')} 后的验收是什么？`,
        options: [{ label: round === 1 ? '内部开发者' : '可验证交付' }],
        custom: true
      }]),
      askQuestion: vi.fn(async ({ questions }) => [{ selectedLabels: [questions[0].options[0].label] }]),
      runBrainstorm: vi.fn(async ({ round }) => ({
        needsMoreClarification: round === 1,
        mainSession: {
          goal: '实现 M2',
          constraints: ['不自动 commit'],
          nonGoals: ['不做 M3'],
          userDecisions: []
        },
        artifact: stageArtifact('brainstorm')
      }))
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.buildExplorationQuestions).toHaveBeenCalledTimes(2)
    expect(host.runBrainstorm).toHaveBeenCalledTimes(2)
    expect(host.buildExplorationQuestions).toHaveBeenLastCalledWith(expect.objectContaining({
      round: 2,
      context: expect.objectContaining({
        mainSession: expect.objectContaining({ userDecisions: ['内部开发者'] })
      })
    }))
    expect(result.currentStage).toBe('test')
    expect(result.mainSession.userDecisions).toEqual(['内部开发者', '可验证交付'])
  })

  it('Scope 两轮修正后仍有 HIGH 会进入 waiting_user，禁止 tradeoff 硬闯', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1'
    })
    coord.markRunning(snap.runId)
    let version = 0
    const host = baseHost({
      runPlan: vi.fn(async () => {
        version += 1
        return {
          plan: validPlan(version),
          workspaceRevision: version,
          artifact: stageArtifact('plan')
        }
      }),
      runScopeCheck: vi.fn(async () => ({
        findings: [{
          severity: 'high',
          location: 'changeScope',
          summary: '计划范围过宽',
          evidence: '变更范围包含无关模块',
          suggestion: '移除无关模块'
        }],
        evidenceRef: { kind: 'scope-check', note: 'high finding' },
        artifact: stageArtifact('scope_check')
      }))
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry,
      startStage: 'brainstorm'
    }).runPreDeliveryStages()

    expect(result.currentStage).toBe('waiting_user')
    expect(result.suspendedStage).toBe('scope_check')
    expect(result.scopeCorrectionUsed).toBe(2)
    expect(host.runPlan).toHaveBeenCalledTimes(3)
    expect(host.runScopeCheck).toHaveBeenCalledTimes(3)
    expect(host.runPlan).toHaveBeenNthCalledWith(1, expect.objectContaining({
      context: expect.objectContaining({
        mainSession: expect.objectContaining({ goal: '实现 M2' })
      })
    }))
    expect(result.mainSession).toMatchObject({
      goal: '实现 M2',
      constraints: ['不自动 commit'],
      nonGoals: ['不做 M3']
    })
    expect(result.stageArtifacts.map(item => item.stage)).toEqual(expect.arrayContaining([
      'brainstorm',
      'plan',
      'scope_check'
    ]))
  })

  it('implement 任务连续三次失败后标记 skipped，并推进到 test 边界', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: 'implement',
        hasValidatedPlan: true,
        hasValidScopePass: true,
        planVersion: 1,
        workspaceRevision: 1
      })
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStatePatch(
      snap.runId,
      { tasks: createInitialTasks() },
      'seed tasks'
    )
    const host = baseHost({
      runImplementTask: vi.fn(async () => ({
        verification: { outcome: 'failed', command: 'targeted-test', exitCode: 1, timedOut: false },
        failureReason: '验收失败',
        evidenceRef: { kind: 'task-verification', note: 'exitCode=1' }
      }))
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.prepareWriteBoundary).toHaveBeenCalledOnce()
    expect(host.runImplementTask).toHaveBeenCalledTimes(3)
    expect(result.currentStage).toBe('test')
    expect(result.writeBoundary?.checkpointRef).toBe(`xforge:${snap.runId}:implement`)
    expect(result.tasks[0]).toMatchObject({
      id: 'task-1',
      status: 'skipped',
      attempts: 3,
      failureReason: '验收失败'
    })
    expect(store.loadSnapshot(snap.runId)?.xforge?.tasks[0]?.status).toBe('skipped')
  })

  it('多任务中没有定向命令的行为验收标为 unverified，不使用交付级命令兜底', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: 'implement',
        hasValidatedPlan: true,
        hasValidScopePass: true,
        planVersion: 1,
        workspaceRevision: 1
      })
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStatePatch(snap.runId, {
      tasks: [
        ...createInitialTasks(),
        {
          id: 'task-2',
          title: '实现定向命令任务',
          status: 'pending',
          acceptance: ['`node --test targeted.mjs`'],
          attempts: 0,
          evidenceRefs: []
        }
      ]
    })
    const host = baseHost({
      runImplementTask: vi.fn(async ({ task }) => task.id === 'task-1'
        ? {
            verification: { outcome: 'unverified', command: null, exitCode: null, timedOut: false },
            evidenceRef: { kind: 'task-verification', unverified: true }
          }
        : {
            verification: { outcome: 'passed', command: 'node --test targeted.mjs', exitCode: 0, timedOut: false },
            evidenceRef: { kind: 'task-verification', note: 'targeted passed' }
          })
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.runImplementTask).toHaveBeenCalledTimes(2)
    expect(host.runImplementTask).toHaveBeenNthCalledWith(1, expect.objectContaining({
      task: expect.objectContaining({ id: 'task-1' })
    }))
    expect(result.currentStage).toBe('test')
    expect(result.tasks).toEqual([
      expect.objectContaining({ id: 'task-1', status: 'unverified', attempts: 0 }),
      expect.objectContaining({ id: 'task-2', status: 'done', attempts: 1 })
    ])
  })

  it('任务验证因环境或凭据阻塞时立即 waiting_user，不消耗重试伪装为 skipped', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: 'implement',
        hasValidatedPlan: true,
        hasValidScopePass: true,
        planVersion: 1,
        workspaceRevision: 1
      })
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStatePatch(snap.runId, { tasks: createInitialTasks() })
    const host = baseHost({
      runImplementTask: vi.fn(async () => ({
        verification: {
          outcome: 'blocked',
          command: 'targeted-test',
          exitCode: null,
          timedOut: false,
          blockedReason: '缺少测试凭据'
        },
        evidenceRef: { kind: 'task-verification', note: 'blocked' }
      }))
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.runImplementTask).toHaveBeenCalledOnce()
    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toContain('缺少测试凭据')
    expect(result.tasks[0]).toMatchObject({
      status: 'failed',
      attempts: 1,
      failureReason: '缺少测试凭据'
    })
  })

  it('从持久化 Validated Plan 恢复后可继续 scope，不依赖执行器内存', async () => {
    const plan = validPlan(4)
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: 'scope_check',
        hasValidatedPlan: true,
        planVersion: 4,
        workspaceRevision: 7
      })
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStatePatch(snap.runId, {
      validatedPlan: plan,
      tasks: createInitialTasks()
    })
    const host = baseHost()

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.runPlan).not.toHaveBeenCalled()
    expect(host.runScopeCheck).toHaveBeenCalledWith(expect.objectContaining({ runId: snap.runId, plan }))
    expect(result.currentStage).toBe('test')
  })

  it('Plan Version 由权威状态单调分配，不信任方法返回版本', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: 'plan',
        planVersion: 5,
        workspaceRevision: 2
      })
    })
    coord.markRunning(snap.runId)
    const host = baseHost({
      runPlan: vi.fn(async () => ({
        plan: validPlan(1),
        workspaceRevision: 2,
        artifact: stageArtifact('plan')
      }))
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(host.runPlan).toHaveBeenCalledWith(expect.objectContaining({ nextPlanVersion: 6 }))
    expect(result.planVersion).toBe(6)
    expect(result.validatedPlan?.version).toBe(6)
  })

  it('prepared EffectReceipt 视为 Pending Side Effect 并停止自动推进', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: 'implement',
        hasValidatedPlan: true,
        hasValidScopePass: true,
        planVersion: 1,
        workspaceRevision: 1
      })
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStatePatch(snap.runId, { tasks: createInitialTasks() })
    const host = baseHost({
      runImplementTask: vi.fn(async () => ({
        verification: { outcome: 'passed', command: 'targeted-test', exitCode: 0, timedOut: false },
        evidenceRef: { kind: 'task-verification', note: 'exitCode=0' },
        fileEffects: [{ path: 'src/example.ts', receiptId: 'effect-1', status: 'prepared' }]
      }))
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toMatch(/Pending Side Effect/)
    expect(result.tasks[0].status).toBe('failed')
  })

  it('持久化 committed EffectReceipt 后递增 Workspace Revision 并刷新写入边界', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({
        currentStage: 'implement',
        hasValidatedPlan: true,
        hasValidScopePass: true,
        planVersion: 1,
        workspaceRevision: 3
      })
    })
    coord.markRunning(snap.runId)
    coord.commitXForgeStatePatch(snap.runId, { tasks: createInitialTasks() })
    const afterFingerprint = { revision: 4, digest: 'after', capturedAt: Date.now() }
    const host = baseHost({
      runImplementTask: vi.fn(async () => ({
        verification: { outcome: 'passed', command: 'targeted-test', exitCode: 0, timedOut: false },
        evidenceRef: { kind: 'task-verification', note: 'exitCode=0' },
        fileEffects: [{ path: 'src/example.ts', receiptId: 'effect-1', status: 'committed' }],
        workspaceFingerprint: afterFingerprint
      }))
    })

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry
    }).runPreDeliveryStages()

    expect(result.currentStage).toBe('test')
    expect(result.workspaceRevision).toBe(4)
    expect(result.hasValidScopePass).toBe(false)
    expect(result.writeBoundary?.fingerprint).toEqual(afterFingerprint)
  })

  it('阶段方法缺失时进入 waiting_user，且不运行该阶段 Agent', async () => {
    const snap = coord.startXForgeRun({
      workspaceId: tmpDir,
      sessionId: 's1',
      xforge: createInitialXForgeRunState({ currentStage: 'plan' })
    })
    coord.markRunning(snap.runId)
    const host = baseHost()

    const result = await new XForgeStageExecutor({
      runId: snap.runId,
      committer: coord,
      host,
      methodRegistry: { get: () => undefined }
    }).runPreDeliveryStages()

    expect(result.currentStage).toBe('waiting_user')
    expect(result.waitingReason).toMatch(/br-task-breakdown.*缺失/)
    expect(host.activateStage).not.toHaveBeenCalled()
    expect(host.runPlan).not.toHaveBeenCalled()
  })
})

function createInitialTasks() {
  return [
    {
      id: 'task-1',
      title: '实现任务循环',
      status: 'pending' as const,
      acceptance: ['三次失败可跳过'],
      attempts: 0,
      evidenceRefs: []
    }
  ]
}
