// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LearningCommandReceipt } from '../../../../src/shared/learning/command'
import type { LearningQuestionView, LearningSurfaceProjection } from '../../../../src/shared/learning/surface'
import {
  LEARNING_VIZ_AWAITING_NOTICE,
  LEARNING_VIZ_BUSY_NOTICE,
  LEARNING_VIZ_FAILED_NOTICE
} from '../../../../src/renderer/features/learning/learningCopy'
import { createLearningVisualizationSubmitter } from '../../../../src/renderer/features/learning/learningVisualizationSubmitter'
import { useLearningStore } from '../../../../src/renderer/features/learning/useLearningStore'
import { useRunStore } from '../../../../src/renderer/stores/useRunStore'
import { claimInterfaceState, recordInterfaceState } from '../../../../src/renderer/lib/interfaceStateOutbox'

const SESSION_ID = 'learn-session-1'

function createProjection(overrides: Partial<LearningSurfaceProjection> = {}): LearningSurfaceProjection {
  return {
    sessionId: SESSION_ID,
    workspaceRoot: '/workspace',
    projectionRevision: 1,
    cursorVersion: 2,
    clearGeneration: 0,
    selectedNodeId: null,
    currentCheckpointId: null,
    questions: [],
    topicStartMessageIds: [],
    nodeProgress: [],
    build: { status: 'idle' },
    tree: { knowledgeRevision: null, nodes: [], edges: [] },
    ...overrides
  }
}

let currentProjection: LearningSurfaceProjection = createProjection()
let commandHandler: () => Promise<LearningCommandReceipt>
let invoke: ReturnType<typeof vi.fn>

beforeEach(async () => {
  currentProjection = createProjection()
  commandHandler = async () => ({ ok: true, commandId: 'cmd-1', cursorVersion: 3, applied: true })
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'learning:get-surface') return currentProjection
    if (channel === 'learning:command') return commandHandler()
    throw new Error(`Unexpected channel: ${channel}`)
  })
  Object.assign(window, { api: { invoke } })
  useRunStore.getState().resetForTests()
  useLearningStore.getState().clearForSession(null)
  useLearningStore.getState().pruneDrafts([])
  useLearningStore.getState().clearForSession(SESSION_ID)
  await useLearningStore.getState().refresh(SESSION_ID)
})

afterEach(() => {
  useLearningStore.getState().clearForSession(null)
  useLearningStore.getState().pruneDrafts([])
  useRunStore.getState().resetForTests()
})

describe('createLearningVisualizationSubmitter', () => {
  it('待答题时返回 blocked，不调用 learning:command，且草稿保持不变', async () => {
    const question: LearningQuestionView = {
      checkpointId: 'ckpt-1',
      question: '为什么需要游标？',
      state: 'awaiting_answer',
      createdAt: 1,
      assessment: null
    }
    currentProjection = createProjection({
      projectionRevision: 2,
      currentCheckpointId: 'ckpt-1',
      questions: [question]
    })
    await useLearningStore.getState().refresh(SESSION_ID)
    useLearningStore.getState().setDraft(SESSION_ID, 'ckpt-1', '我的回答草稿')
    useLearningStore.getState().setDraft(SESSION_ID, null, '我的提问草稿')
    invoke.mockClear()

    const submit = createLearningVisualizationSubmitter(SESSION_ID)
    const outcome = await submit('【可视化】图：explore\n模块：深入讲讲', 'event')

    expect(outcome).toEqual({ status: 'blocked', notice: LEARNING_VIZ_AWAITING_NOTICE })
    expect(invoke).not.toHaveBeenCalledWith('learning:command', expect.anything())
    expect(useLearningStore.getState().drafts[SESSION_ID]).toEqual({
      message: '我的提问草稿',
      answers: { 'ckpt-1': '我的回答草稿' }
    })
  })

  it('命令提交中返回 blocked', async () => {
    let resolveCommand!: (receipt: LearningCommandReceipt) => void
    commandHandler = () =>
      new Promise<LearningCommandReceipt>(resolve => {
        resolveCommand = resolve
      })

    const inFlight = useLearningStore.getState().sendCommand({
      sessionId: SESSION_ID,
      action: { type: 'message', text: '正在发送的命令' }
    })
    expect(useLearningStore.getState().commandPending).toBe(true)

    const submit = createLearningVisualizationSubmitter(SESSION_ID)
    const outcome = await submit('【可视化】图：explore\n模块：深入讲讲', 'event')

    expect(outcome).toEqual({ status: 'blocked', notice: LEARNING_VIZ_BUSY_NOTICE })
    expect(invoke.mock.calls.filter(call => call[0] === 'learning:command')).toHaveLength(1)

    resolveCommand({ ok: true, commandId: 'cmd-in-flight', cursorVersion: 3, applied: true })
    await inFlight
  })

  it('空闲时以 message 命令调用 learning:command，返回 sent', async () => {
    const submit = createLearningVisualizationSubmitter(SESSION_ID)
    const text = '【可视化】图：explore\n模块：深入讲讲'
    const outcome = await submit(text, 'event')

    expect(outcome).toEqual({ status: 'sent' })
    expect(invoke).toHaveBeenCalledWith('learning:command', {
      sessionId: SESSION_ID,
      command: expect.objectContaining({
        sessionId: SESSION_ID,
        expectedClearGeneration: 0,
        expectedCursorVersion: 2,
        action: { type: 'message', text }
      })
    })
  })

  it('回执 ok: false 时返回 blocked', async () => {
    commandHandler = async () => ({ ok: false, code: 'busy', message: '忙' })

    const submit = createLearningVisualizationSubmitter(SESSION_ID)
    const outcome = await submit('【可视化】图：explore\n模块：深入讲讲', 'event')

    expect(outcome).toEqual({ status: 'blocked', notice: LEARNING_VIZ_FAILED_NOTICE })
  })

  it('交互组件改动随 message 命令交出；命令被拒时放回待发箱', async () => {
    const widget = { title: '缓存命中', values: [{ label: '前缀长度', value: '4k' }] }
    recordInterfaceState(SESSION_ID, 'block#w', widget)
    commandHandler = async () => ({ ok: false, code: 'busy', message: '忙' })

    const submit = createLearningVisualizationSubmitter(SESSION_ID)
    await submit('【可视化】图：explore\n模块：深入讲讲', 'event')
    const firstAction = (invoke.mock.calls.find(call => call[0] === 'learning:command')![1] as { command: { action: unknown } }).command.action
    expect(firstAction).toMatchObject({ type: 'message', interfaceState: { widgets: [widget] } })

    commandHandler = async () => ({ ok: true, commandId: 'cmd-2', cursorVersion: 3, applied: true })
    invoke.mockClear()
    expect(await submit('再讲讲', 'event')).toEqual({ status: 'sent' })
    const retried = (invoke.mock.calls.find(call => call[0] === 'learning:command')![1] as { command: { action: unknown } }).command.action
    expect(retried).toMatchObject({ interfaceState: { widgets: [widget] } })
    expect(claimInterfaceState(SESSION_ID)).toBeNull()
  })
})
