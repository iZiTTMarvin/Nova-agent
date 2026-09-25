import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join as pathJoin } from 'path'
import { tmpdir } from 'os'
import {
  AgentTurnExecutor,
  type AgentTurnOutcome,
  agentRoute
} from '../../../../src/runtime/agent/turn'
import { createRunCoordinator, RunExecutionRegistry } from '../../../../src/runtime/run'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { executeToolBatch } from '../../../../src/runtime/agent/execution/toolBatchExecutor'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import { createLearningCheckpointTool } from '../../../../src/runtime/tools/learning_checkpoint'
import { releaseCheckpointSlot } from '../../../../src/runtime/learning/progress/checkpointBatchGate'
import type { AgentLoop } from '../../../../src/runtime/agent'
import { createLearnToolAuthorizationPolicy } from '../../../../src/runtime/learning/policy/createLearnToolAuthorizationPolicy'
import {
  LearningProgress,
  setDefaultLearningProgress
} from '../../../../src/runtime/learning/progress/LearningProgress'
import { LearningProgressRepository } from '../../../../src/runtime/learning/progress/LearningProgressRepository'
import { LearningDbWorkerClient } from '../../../../src/runtime/learning/storage/LearningDbWorkerClient'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'

const workerJs = pathJoin(process.cwd(), 'out', 'main', 'learningDbWorker.js')

function fakeLoop(sendMessage: () => Promise<AgentTurnOutcome>) {
  const loop = {
    setExecutionIdentity: vi.fn(),
    setExecutionFence: vi.fn(),
    cancel: vi.fn(),
    sendMessage: vi.fn(sendMessage)
  } as unknown as AgentLoop
  return loop
}

describe('learning_checkpoint turn 可行性', () => {
  let sessionsRoot: string
  let learningTemp: string
  let store: SessionStore
  let workerClient: LearningDbWorkerClient | null = null

  beforeEach(async () => {
    if (!existsSync(workerJs)) {
      throw new Error(`缺少 ${workerJs}，请先 npm run build`)
    }
    sessionsRoot = mkdtempSync(pathJoin(tmpdir(), 'nova-learning-sess-'))
    learningTemp = mkdtempSync(pathJoin(tmpdir(), 'nova-learning-db-'))
    store = new SessionStore(sessionsRoot)
    workerClient = new LearningDbWorkerClient(workerJs)
    await workerClient.start()
    await workerClient.open(pathJoin(learningTemp, 'learning.db'))
    const progress = new LearningProgress(new LearningProgressRepository(workerClient))
    setDefaultLearningProgress(progress)
  })

  afterEach(async () => {
    setDefaultLearningProgress(null)
    if (workerClient) {
      await workerClient.close()
      workerClient = null
    }
    rmSync(sessionsRoot, { recursive: true, force: true })
    rmSync(learningTemp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  })

  it('停点持久化后 turn_complete，执行释放后可启动新 turn', async () => {
    const session = store.create('/proj', 'learn')
    const runsRoot = mkdtempSync(pathJoin(tmpdir(), 'nova-learning-run-'))
    const coordinator = createRunCoordinator(runsRoot)
    const registry = new RunExecutionRegistry()
    const executor = new AgentTurnExecutor(coordinator, registry)
    const toolRegistry = new ToolRegistry()
    toolRegistry.register(createLearningCheckpointTool())
    const learnPolicy = createLearnToolAuthorizationPolicy()

    const runCheckpointBatch = async (runId: string) => {
      releaseCheckpointSlot(runId)
      return executeToolBatch({
        readState: createReadState(),
        toolCalls: [
          {
            id: 'tc_ckpt',
            name: 'learning_checkpoint',
            arguments: JSON.stringify({
              question: '刷新后数据从哪来？',
              cursorVersion: 0,
              checkpointId: 'ckpt-1',
              rubric: {
                targetClaim: '指出持久化来源',
                knowledgeRevision: null,
                verificationMethod: 'open_answer',
                criteria: '能说明刷新后数据来源'
              }
            })
          }
        ],
        messageId: 'msg_ckpt',
        toolRegistry,
        workingDir: '/proj',
        sessionId: session.id,
        runId,
        mode: 'learn',
        supportsVision: false,
        checkpointManager: null,
        abortSignal: undefined,
        checkPermission: async (_tool, _args) => {
          const decision = learnPolicy('learning_checkpoint')
          return decision.allowed
            ? { allowed: true, reason: '' }
            : { allowed: false, reason: decision.reason }
        },
        emit: vi.fn(),
        applyTruncation: output => output,
        maxParallelToolCalls: 1,
        toolExecution: 'sequential'
      })
    }

    let activeRunId = ''
    const first = await executor.execute({
      agentLoop: fakeLoop(async () => {
        const batch = await runCheckpointBatch(activeRunId)
        expect(batch.outcomes[0]?.control).toEqual({ type: 'turn_complete' })
        return { status: 'completed' }
      }),
      task: '讲解',
      route: agentRoute(),
      sessionId: session.id,
      workingDirectory: '/proj',
      isolation: 'shared',
      userMessageId: 'user-1',
      onStarted: ctx => {
        activeRunId = ctx.runId
      }
    })

    const progress = new LearningProgress(new LearningProgressRepository(workerClient!))
    const persisted = await progress.getCheckpointForSession(session.id)
    expect(persisted?.checkpointId).toBe('ckpt-1')
    expect(coordinator.getSnapshot(first.runId)?.status).toBe('completed')
    expect(registry.get(first.runId)).toBeNull()

    const second = await executor.execute({
      agentLoop: fakeLoop(async () => ({ status: 'completed' })),
      task: '继续',
      route: agentRoute(),
      sessionId: session.id,
      workingDirectory: '/proj',
      isolation: 'shared',
      userMessageId: 'user-2'
    })

    expect(second.runId).not.toBe(first.runId)
    expect(coordinator.getSnapshot(second.runId)?.status).toBe('completed')

    rmSync(runsRoot, { recursive: true, force: true })
  })

  it('同批第二个不同停点拒绝', async () => {
    const tool = createLearningCheckpointTool()
    const runId = 'run-batch'
    releaseCheckpointSlot(runId)
    const baseContext = {
      workingDir: process.cwd(),
      readState: createReadState(),
      sessionId: 'sess',
      runId,
      mode: 'learn' as const
    }

    const rubric = {
      targetClaim: 'c',
      knowledgeRevision: null,
      verificationMethod: 'open_answer',
      criteria: 'c'
    }
    const ok = await tool.execute(
      { question: 'Q1', cursorVersion: 0, checkpointId: 'a', rubric },
      baseContext
    )
    expect(ok.control).toEqual({ type: 'turn_complete' })

    const rejected = await tool.execute(
      { question: 'Q2', cursorVersion: 0, checkpointId: 'b', rubric },
      baseContext
    )
    expect(rejected.success).toBe(false)
    expect(rejected.error).toContain('不同的学习停点')
  })

  it('取消走现有 RunCoordinator 路径', async () => {
    const runsRoot = mkdtempSync(pathJoin(tmpdir(), 'nova-learning-cancel-'))
    const coordinator = createRunCoordinator(runsRoot)
    const snap = coordinator.startRun({
      kind: 'agent',
      workspaceId: '/proj',
      sessionId: 'sess-cancel'
    })
    coordinator.markRunning(snap.runId)
    const cancelled = coordinator.commitTerminal({ runId: snap.runId, status: 'cancelled' })
    expect(cancelled?.status).toBe('cancelled')
    rmSync(runsRoot, { recursive: true, force: true })
  })
})
