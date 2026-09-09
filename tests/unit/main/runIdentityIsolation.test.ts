import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventBus, type AgentEvent } from '../../../src/runtime/agent'
import { SessionStore } from '../../../src/runtime/sessions'
import { resetSessionIndexHostForTests } from '../../../src/runtime/sessions/SessionIndexHost'
import {
  initRunCoordinatorHost, getRunCoordinator, getRunExecutionRegistry,
  resetRunCoordinatorHostForTests
} from '../../../src/main/services/RunCoordinatorHost'
import { isAgentTurnInProgress, isSessionTurnInProgress } from '../../../src/main/agent/state'
import {
  createAskQuestionHandler, pendingAskQuestions,
  dismissPendingAskQuestionsForSession
} from '../../../src/main/agent/interaction/askQuestionWaiters'
import { cancelExecution, respondAskQuestion } from '../../../src/main/agent/interaction/AgentInteractionController'
import { enqueueSteeringMessage, dequeueSteeringMessage, clearSteeringQueue } from '../../../src/main/agent/turn/SteeringQueue'
import { registerRunHandler } from '../../../src/main/ipc/runHandler'
import { handle } from '../../../src/main/ipc/secureIpc'
import { RUN_FORCE_TERMINATE } from '../../../src/shared/ipc/channels'

vi.mock('../../../src/main/ipc/secureIpc', () => ({ handle: vi.fn() }))

async function forceTerminate(runId: string) {
  vi.mocked(handle).mockClear()
  registerRunHandler()
  const handler = vi.mocked(handle).mock.calls.find(([channel]) => channel === RUN_FORCE_TERMINATE)?.[1]
  if (!handler) throw new Error('force terminate handler missing')
  return Reflect.apply(handler, undefined, [{}, { runId }])
}

const host = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => host.root },
  BrowserWindow: class {}
}))
let store: SessionStore
vi.mock('../../../src/main/services/SessionStoreHost', () => ({ getSessionStore: () => store }))
vi.mock('../../../src/main/agent/turn', () => ({
  getAgentLoopForRun: () => undefined,
  disposeIdleLoopForSession: () => {}
}))
vi.mock('../../../src/main/agent/events', () => ({ markActiveStreamsCancelled: () => {} }))

const events: AgentEvent[] = []
let bus: EventBus
const settlements: Array<() => void> = []

function start(runId: string, sessionId: string, messageId = `message-${runId}`) {
  const coord = getRunCoordinator()
  coord.startRun({ kind: 'agent', runId, sessionId, workspaceId: host.root, messageId })
  coord.markRunning(runId)
  coord.bindExecutionGeneration(runId, 1)
  let settle!: () => void
  const settled = new Promise<void>(resolve => { settle = resolve })
  settlements.push(settle)
  getRunExecutionRegistry().register({ runId, generation: 1, kind: 'agent', abort: settle, settled })
  const ask = createAskQuestionHandler({
    sessionId, getRunRefs: () => ({ runId, executionGeneration: 1 }),
    runCoordinator: coord, pending: pendingAskQuestions, eventBus: bus
  })
  return { ask, settle, settled }
}

beforeEach(() => {
  host.root = mkdtempSync(join(tmpdir(), 'nova-run-identity-'))
  store = new SessionStore(join(host.root, 'sessions'))
  initRunCoordinatorHost(() => null)
  events.length = 0
  bus = new EventBus()
  bus.on(event => { events.push(event) })
})

afterEach(async () => {
  for (const settle of settlements.splice(0)) settle()
  await Promise.resolve()
  for (const sessionId of new Set(['session-A', 'session-B', ...[...pendingAskQuestions.values()].map(entry => entry.sessionId)])) {
    dismissPendingAskQuestionsForSession(sessionId)
    clearSteeringQueue(sessionId)
  }
  resetRunCoordinatorHostForTests()
  resetSessionIndexHostForTests()
  rmSync(host.root, { recursive: true, force: true })
})

describe('main run identity isolation', () => {
  it('A、B 并发提问绑定各自 message；A 结束不清除 B 的执行和回答', async () => {
    const a = start('A', 'session-A')
    const b = start('B', 'session-B')
    const answerA = a.ask('question-A', [])
    const answerB = b.ask('question-B', [])
    const coord = getRunCoordinator()
    expect(coord.findInteraction('question-A')).toMatchObject({ runId: 'A', sessionId: 'session-A', messageId: 'message-A' })
    expect(coord.findInteraction('question-B')).toMatchObject({ runId: 'B', sessionId: 'session-B', messageId: 'message-B' })
    expect(events.filter(event => event.type === 'ask_question_request')).toMatchObject([
      { runId: 'A', messageId: 'message-A' }, { runId: 'B', messageId: 'message-B' }
    ])
    dismissPendingAskQuestionsForSession('session-A')
    await expect(answerA).resolves.toEqual([])
    coord.commitTerminal({ runId: 'A', status: 'completed' })
    a.settle()
    await a.settled
    expect(isSessionTurnInProgress('session-A')).toBe(false)
    expect(isSessionTurnInProgress('session-B')).toBe(true)
    expect(isAgentTurnInProgress()).toBe(true)
    const answers = [{ selectedLabels: ['B'] }]
    const result = await respondAskQuestion({ requestId: 'question-B', answers, commandId: 'answer-B' })
    expect(result).toMatchObject({ ok: true, firstApplied: true })
    await expect(answerB).resolves.toEqual(answers)
    expect(pendingAskQuestions.size).toBe(0)
  })

  it.each(['missing-run', 'wrong-session', 'missing-message', 'stale-generation', 'cancelling', 'terminal'])('提问拒绝 %s 身份，不留下 waiter 或污染 B', async defect => {
    const a = start('A', 'session-A')
    const b = start('B', 'session-B')
    const pendingB = b.ask('question-B', [])
    const coord = getRunCoordinator()
    const beforeB = coord.getSnapshot('B')
    if (defect === 'missing-message') coord.setMessageId('A', '')
    if (defect === 'stale-generation') coord.bindExecutionGeneration('A', 2)
    if (defect === 'cancelling') coord.beginCancel('A')
    if (defect === 'terminal') coord.commitTerminal({ runId: 'A', status: 'completed' })
    const ask = defect === 'missing-run' || defect === 'wrong-session'
      ? createAskQuestionHandler({
          sessionId: defect === 'wrong-session' ? 'session-B' : 'session-A',
          getRunRefs: () => ({ runId: defect === 'missing-run' ? 'missing' : 'A', executionGeneration: 1 }),
          runCoordinator: coord, pending: pendingAskQuestions, eventBus: bus
        })
      : a.ask
    await expect(ask('invalid-question', [])).rejects.toThrow(/身份无效/)
    expect(pendingAskQuestions.has('invalid-question')).toBe(false)
    expect(coord.findInteraction('invalid-question')).toBeNull()
    expect(coord.getSnapshot('B')).toEqual(beforeB)
    dismissPendingAskQuestionsForSession('session-B')
    await expect(pendingB).resolves.toEqual([])
  })

  it('拒绝重复 requestId 并保留原 waiter，持久化失败清理新 waiter', async () => {
    const a = start('A', 'session-A')
    const b = start('B', 'session-B')
    const answer = a.ask('question', [])
    await expect(b.ask('question', [])).rejects.toThrow(/重复/)
    expect(pendingAskQuestions.get('question')?.runId).toBe('A')
    const enqueue = vi.spyOn(getRunCoordinator().inbox, 'enqueue').mockImplementationOnce(() => { throw new Error('disk failed') })
    await expect(b.ask('failed', [])).rejects.toThrow('disk failed')
    expect(pendingAskQuestions.has('failed')).toBe(false)
    enqueue.mockRestore()
    dismissPendingAskQuestionsForSession('session-A')
    await expect(answer).resolves.toEqual([])
  })

  it('旧 generation 的 waiter 不能回答新执行的 interaction', async () => {
    const a = start('A', 'session-A')
    const answer = a.ask('question', [])
    getRunCoordinator().bindExecutionGeneration('A', 2)
    const old = getRunExecutionRegistry().get('A')!
    getRunExecutionRegistry().register({ ...old, generation: 2 })
    const before = getRunCoordinator().findInteraction('question')
    const result = await respondAskQuestion({ requestId: 'question', answers: [], commandId: 'stale' })
    expect(result).toMatchObject({ ok: false, code: 'identity_mismatch' })
    expect(getRunCoordinator().findInteraction('question')).toEqual(before)
    expect(pendingAskQuestions.has('question')).toBe(true)
    dismissPendingAskQuestionsForSession('session-A')
    await expect(answer).resolves.toEqual([])
  })

  it('取消 A 在执行收敛前清空 A 队列，不等待 B 也不触碰 B 的提问和队列', async () => {
    const a = start('A', 'session-A')
    const b = start('B', 'session-B')
    const answerA = a.ask('question-A', [])
    const answerB = b.ask('question-B', [])
    const handle = getRunExecutionRegistry().get('A')!
    getRunExecutionRegistry().register({
      ...handle,
      abort: () => {},
      settled: answerA.then(() => {})
    })
    enqueueSteeringMessage('session-A', { sessionId: 'session-A', content: 'queued A' })
    enqueueSteeringMessage('session-B', { sessionId: 'session-B', content: 'queued B' })
    const beforeB = getRunCoordinator().getSnapshot('B')
    const cancelling = cancelExecution({ runId: 'A' })
    expect(dequeueSteeringMessage('session-A')).toBeUndefined()
    await expect(cancelling).resolves.toEqual({ runId: 'A', status: 'cancelled' })
    await expect(answerA).resolves.toEqual([])
    expect(getRunCoordinator().getSnapshot('B')).toEqual(beforeB)
    expect(getRunExecutionRegistry().listActiveRunIds()).toEqual(['B'])
    expect(dequeueSteeringMessage('session-B')?.content).toBe('queued B')
    expect(pendingAskQuestions.has('question-B')).toBe(true)
    dismissPendingAskQuestionsForSession('session-B')
    await expect(answerB).resolves.toEqual([])
  })

  it('强制终止父 run 在等待执行前释放整棵子任务树的提问', async () => {
    const parent = store.create(host.root)
    const child = store.createChildIfAbsent({
      childSessionId: 'force-child-session', workspaceRoot: host.root, mode: 'default',
      permissionMode: 'request_approval', task: 'inspect',
      subagent: {
        lineage: {
          parentSessionId: parent.id, parentRunId: 'A', rootRunId: 'A', depth: 1,
          spawnKey: 'force-child-key', spawnRunId: 'C',
          origin: { kind: 'task_tool', parentMessageId: 'message-A', parentToolCallId: 'tool-A' }
        },
        profile: {
          profileId: 'explore', name: 'Explore', description: 'Inspect', systemPrompt: 'Inspect',
          toolNames: ['read'], permissionCeiling: 'read_only', maxToolRounds: 10, configHash: 'hash'
        }
      }
    }).session
    const a = start('A', parent.id)
    const c = start('C', child.id)
    const answerA = a.ask('question-A', [])
    const answerC = c.ask('question-C', [])
    const registry = getRunExecutionRegistry()
    registry.register({ ...registry.get('A')!, abort: () => {}, settled: answerA.then(() => {}) })
    registry.register({ ...registry.get('C')!, abort: () => {}, settled: answerC.then(() => {}) })
    await expect(forceTerminate('A')).resolves.toMatchObject({ ok: true, lingering: false })
    await expect(Promise.all([answerA, answerC])).resolves.toEqual([[], []])
    expect(pendingAskQuestions.size).toBe(0)
    expect(registry.listActiveRunIds()).toEqual([])
    expect(getRunCoordinator().getSnapshot('C')?.status).toBe('cancelled')
    expect(getRunCoordinator().findInteraction('question-C')?.status).toBe('cancelled')
  })

  it.each(['active', 'terminal-lingering'] as const)('强制终止 %s 释放对应 generation 的提问，不触碰另一执行', async state => {
    const a = start('A', 'session-A')
    const answerA = a.ask('question-A', [])
    const coord = getRunCoordinator()
    const registry = getRunExecutionRegistry()
    registry.register({ ...registry.get('A')!, abort: () => {}, settled: answerA.then(() => {}) })
    if (state === 'terminal-lingering') {
      coord.invalidateExecutionGeneration('A')
      coord.commitTerminal({ runId: 'A', status: 'interrupted' })
    }
    const otherSession = state === 'active' ? 'session-B' : 'session-A'
    const b = start('B', otherSession)
    const answerB = b.ask('question-B', [])
    enqueueSteeringMessage(otherSession, { sessionId: otherSession, content: 'keep queued' })
    const beforeB = coord.getSnapshot('B')
    await expect(forceTerminate('A')).resolves.toMatchObject({
      ok: true, lingering: false,
      snapshot: { runId: 'A', status: state === 'active' ? 'cancelled' : 'interrupted' }
    })
    await expect(answerA).resolves.toEqual([])
    expect(pendingAskQuestions.has('question-A')).toBe(false)
    expect(registry.listActiveRunIds()).toEqual(['B'])
    expect(coord.getSnapshot('B')).toEqual(beforeB)
    expect(coord.findInteraction('question-A')?.status).toBe('cancelled')
    expect(pendingAskQuestions.has('question-B')).toBe(true)
    expect(dequeueSteeringMessage(otherSession)?.content).toBe('keep queued')
    dismissPendingAskQuestionsForSession(otherSession)
    await expect(answerB).resolves.toEqual([])
  })

  it('无效取消身份明确失败；旧终态取消不能清掉同会话的新 turn 队列', async () => {
    const a = start('A', 'session-A')
    const before = getRunCoordinator().getSnapshot('A')
    for (const runId of ['', '  ', 'missing']) {
      await expect(cancelExecution({ runId })).rejects.toThrow(/取消执行/)
    }
    await expect(Reflect.apply(cancelExecution, undefined, [])).rejects.toThrow(/缺少 runId/)
    expect(getRunCoordinator().getSnapshot('A')).toEqual(before)
    getRunCoordinator().commitTerminal({ runId: 'A', status: 'completed' })
    a.settle()
    await a.settled
    start('next-A', 'session-A')
    enqueueSteeringMessage('session-A', { sessionId: 'session-A', content: 'next queued' })
    await expect(cancelExecution({ runId: 'A' })).resolves.toEqual({ runId: 'A', status: 'completed' })
    expect(isSessionTurnInProgress('session-A')).toBe(true)
    expect(dequeueSteeringMessage('session-A')?.content).toBe('next queued')
  })
})
