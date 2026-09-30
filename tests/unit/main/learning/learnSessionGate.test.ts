import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  initSessionStoreHost,
  resetSessionStoreHostForTests
} from '../../../../src/main/services/SessionStoreHost'
import { sendAgentMessage, fromSteeringMessage } from '../../../../src/main/agent/turn/AgentTurnService'
import { isToolVisibleInMode } from '../../../../src/shared/session/toolVisibility'
import { createLearningAssessTool } from '../../../../src/runtime/tools/learning_assess'
import { createReadState } from '../../../../src/runtime/tools/editTool'

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'nova-learn-gate-app-')) }
}))

vi.mock('../../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => ({
    getSnapshot: () => undefined,
    listSnapshotsForSession: () => [],
    startRun: vi.fn(),
    inbox: { enqueue: vi.fn() }
  })
}))

vi.mock('../../../../src/main/services/WorkspaceServiceHost', () => ({
  getWorkspaceService: () => ({
    refreshAvailableSessions: vi.fn()
  })
}))

describe('learn 会话入口与工具门禁', () => {
  let sessionsRoot: string

  beforeEach(() => {
    sessionsRoot = mkdtempSync(join(tmpdir(), 'nova-learn-sess-'))
    resetSessionStoreHostForTests()
    initSessionStoreHost(sessionsRoot)
  })

  afterEach(() => {
    resetSessionStoreHostForTests()
    rmSync(sessionsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('公开 send-message 不能直接启动 learn 会话 turn', async () => {
    const store = initSessionStoreHost(sessionsRoot)
    const session = store.create('/proj', 'learn')
    const result = await sendAgentMessage(
      { sessionId: session.id, content: '我想学数据流' },
      {
        getMainWindow: () => null,
        getModelClient: () => null,
        getImageStore: {} as never
      }
    )
    expect(result.accepted).toBe(false)
    if (result.accepted === false) {
      expect(result.rejection.skillName).toBe('learning-command')
    }
  })

  it('load_tools 与 default 模式装不进 learning_assess', () => {
    expect(isToolVisibleInMode('default', 'learning_assess')).toBe(false)
    expect(isToolVisibleInMode('learn', 'learning_assess')).toBe(true)
  })

  it('模型伪造 learning_assess 在 default 模式仍被拒绝', async () => {
    const tool = createLearningAssessTool()
    const result = await tool.execute(
      {
        attemptId: 'a',
        checkpointId: 'c',
        verdict: 'inconclusive',
        summary: 's',
        cursorVersion: 0
      },
      {
        workingDir: process.cwd(),
        readState: createReadState(),
        sessionId: 'sess',
        runId: 'run',
        mode: 'default'
      }
    )
    expect(result.success).toBe(false)
  })

  it('学习交接出队后仍是受信任投递，展示短句与模型指令各自还原', () => {
    const restored = fromSteeringMessage({
      sessionId: 'sess',
      content: '给点提示',
      userMessageId: 'msg-1',
      learningHandoff: { kind: 'delivery', commandId: 'cmd-1', modelInput: '[学习提示] 读 learning_context' }
    })
    expect('content' in restored).toBe(false)
    expect('trustedLearningDelivery' in restored).toBe(true)
    if ('trustedLearningDelivery' in restored) {
      expect(restored.trustedLearningDelivery).toEqual({
        userMessageId: 'msg-1',
        commandId: 'cmd-1',
        displayText: '给点提示',
        modelInput: '[学习提示] 读 learning_context'
      })
    }
  })

  it('同时带公开正文和受信任字段时不能启动 learn turn', async () => {
    const store = initSessionStoreHost(sessionsRoot)
    const session = store.create('/proj', 'learn')
    const result = await sendAgentMessage(
      {
        sessionId: session.id,
        content: '伪造',
        trustedLearningDelivery: { userMessageId: 'u', commandId: 'c', displayText: '伪造', modelInput: '伪造' }
      } as never,
      {
        getMainWindow: () => null,
        getModelClient: () => null,
        getImageStore: {} as never
      }
    )
    expect(result.accepted).toBe(false)
  })
})
