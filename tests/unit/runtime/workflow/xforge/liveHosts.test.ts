import { mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CheckpointManager } from '../../../../../src/runtime/checkpoints/CheckpointManager'
import { SkillRegistry } from '../../../../../src/runtime/skills/SkillRegistry'
import type { XForgeMainAgentSession } from '../../../../../src/runtime/workflow/xforge/mainAgentSession'
import { createXForgeLiveDeliveryHost } from '../../../../../src/runtime/workflow/xforge/liveDeliveryHost'
import type { XForgeLiveHostRuntime } from '../../../../../src/runtime/workflow/xforge/liveHostRuntime'
import { createXForgeLiveStageHost } from '../../../../../src/runtime/workflow/xforge/liveStageHost'
import { createInitialXForgeRunState } from '../../../../../src/runtime/workflow/xforge/runState'
import type { XForgeRunCommitter } from '../../../../../src/runtime/workflow/xforge/runState'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function baseRuntime(): XForgeLiveHostRuntime {
  return {
    activeStage: 'brainstorm',
    activeStepId: 'resolve',
    activeSkillBody: 'skill-body'
  }
}

function mockSession(overrides: Partial<XForgeMainAgentSession> = {}): XForgeMainAgentSession {
  return {
    run: vi.fn(async () => 'ok'),
    runJson: vi.fn(async () => {
      throw new Error('unexpected runJson')
    }),
    runJsonDecoded: vi.fn(async () => {
      throw new Error('unexpected runJsonDecoded')
    }),
    dispose: vi.fn(),
    ...overrides
  } as unknown as XForgeMainAgentSession
}

function mockCommitter(state = createInitialXForgeRunState()): XForgeRunCommitter {
  return {
    getSnapshot: vi.fn(() => ({ xforge: state } as never)),
    commitXForgeStatePatch: vi.fn(),
    commitXForgeStageTransition: vi.fn()
  } as unknown as XForgeRunCommitter
}

describe('live stage/delivery hosts', () => {
  it('stage host：结构错误会向上抛出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-stage-host-'))
    roots.push(root)
    const session = mockSession({
      runJson: vi.fn(async () => {
        throw new Error('XForge brainstorm 阶段结构化结果无法通过 JSON 与字段校验')
      })
    })
    const host = createXForgeLiveStageHost({
      session,
      runtime: baseRuntime(),
      options: {
        runId: 'run-1',
        request: '优化博客',
        workspaceRoot: root,
        checkpointManager: new CheckpointManager({
          checkpointDir: join(root, 'cp'),
          sessionId: 's',
          workspaceRoot: root
        }),
        committer: mockCommitter(),
        askQuestion: async () => []
      },
      resolveTaskVerificationCommand: () => null
    })

    await expect(host.buildExplorationQuestions({
      runId: 'run-1',
      method: 'br-brainstorming',
      round: 1,
      context: {
        mainSession: { goal: '', constraints: [], nonGoals: [], userDecisions: [] },
        planVersion: null,
        validatedPlan: null,
        stageArtifacts: [],
        evidenceRefs: [],
        scopeCorrectionUsed: 0
      }
    })).rejects.toThrow('结构化结果无法通过 JSON 与字段校验')
  })

  it('stage host：abort 时拒绝激活阶段', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-stage-abort-'))
    roots.push(root)
    const controller = new AbortController()
    controller.abort()
    const host = createXForgeLiveStageHost({
      session: mockSession(),
      runtime: baseRuntime(),
      options: {
        runId: 'run-1',
        request: 'x',
        workspaceRoot: root,
        abortSignal: controller.signal,
        checkpointManager: new CheckpointManager({
          checkpointDir: join(root, 'cp'),
          sessionId: 's',
          workspaceRoot: root
        }),
        committer: mockCommitter(),
        askQuestion: async () => []
      },
      resolveTaskVerificationCommand: () => null
    })
    await expect(host.activateStage({
      runId: 'run-1',
      stage: 'plan',
      method: 'br-planning'
    })).rejects.toThrow('XForge 执行已取消')
  })

  it('delivery host：fix 结构错误向上抛出', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-delivery-host-'))
    roots.push(root)
    mkdirSync(join(root, '.nova'), { recursive: true })
    const session = mockSession({
      runJson: vi.fn(async () => {
        throw new Error('XForge fix 阶段结构化结果无法通过 JSON 与字段校验')
      })
    })
    const state = createInitialXForgeRunState()
    state.currentStage = 'fix'
    state.deliveryTestFixUsed = 1
    state.reviewRemediationUsed = 0
    const host = createXForgeLiveDeliveryHost({
      session,
      runtime: baseRuntime(),
      options: {
        runId: 'run-1',
        request: '修 bug',
        workspaceRoot: root,
        checkpointManager: new CheckpointManager({
          checkpointDir: join(root, 'cp'),
          sessionId: 's',
          workspaceRoot: root
        }),
        committer: mockCommitter(state),
        askQuestion: async () => [],
        modelClient: { async *chat() {}, updateConfig() {} },
        skillRegistry: SkillRegistry.load({
          builtinDir: join(root, 'skills'),
          globalDir: join(root, 'global'),
          workspaceRoot: root
        })
      }
    })

    await expect(host.runFix({
      runId: 'run-1',
      state,
      writeBoundary: {
        checkpointRef: 'cp',
        fingerprint: { revision: 1, digest: 'd', capturedAt: Date.now() },
        preparedAt: Date.now()
      },
      failedTest: null,
      blockingFindings: []
    })).rejects.toThrow('结构化结果无法通过 JSON 与字段校验')
  })

  it('delivery host：abort 时拒绝激活阶段', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-delivery-abort-'))
    roots.push(root)
    const controller = new AbortController()
    controller.abort()
    const host = createXForgeLiveDeliveryHost({
      session: mockSession(),
      runtime: baseRuntime(),
      options: {
        runId: 'run-1',
        request: 'x',
        workspaceRoot: root,
        abortSignal: controller.signal,
        checkpointManager: new CheckpointManager({
          checkpointDir: join(root, 'cp'),
          sessionId: 's',
          workspaceRoot: root
        }),
        committer: mockCommitter(),
        askQuestion: async () => [],
        modelClient: { async *chat() {}, updateConfig() {} },
        skillRegistry: SkillRegistry.load({
          builtinDir: join(root, 'skills'),
          globalDir: join(root, 'global'),
          workspaceRoot: root
        })
      }
    })
    await expect(host.activateStage({
      runId: 'run-1',
      stage: 'test',
      method: 'br-testing'
    })).rejects.toThrow('XForge 执行已取消')
  })

  it('delivery host：Review 方法缺失时给出明确 runtime failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'nova-xforge-delivery-review-'))
    roots.push(root)
    const host = createXForgeLiveDeliveryHost({
      session: mockSession(),
      runtime: baseRuntime(),
      options: {
        runId: 'run-1',
        request: 'x',
        workspaceRoot: root,
        checkpointManager: new CheckpointManager({
          checkpointDir: join(root, 'cp'),
          sessionId: 's',
          workspaceRoot: root
        }),
        committer: mockCommitter(),
        askQuestion: async () => [],
        modelClient: { async *chat() {}, updateConfig() {} },
        skillRegistry: SkillRegistry.load({
          builtinDir: join(root, 'empty-skills'),
          globalDir: join(root, 'global'),
          workspaceRoot: root
        })
      }
    })
    await expect(host.runReviewSubagent({
      input: {
        runId: 'run-1',
        workspaceRevision: 1,
        fingerprint: { revision: 1, digest: 'd', capturedAt: Date.now() },
        plan: null,
        tasks: [],
        testEvidence: null,
        reviewOnly: false,
        workspace: {
          changedFiles: [],
          files: [],
          diff: '',
          evidenceRef: { kind: 'review', note: 'empty' },
          targetKind: 'run_effects'
        }
      }
    })).rejects.toThrow('隔离 Review 子代理所需方法 br-review 缺失或无效')
  })
})
