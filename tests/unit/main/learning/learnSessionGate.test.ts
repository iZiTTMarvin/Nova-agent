import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  initSessionStoreHost,
  resetSessionStoreHostForTests
} from '../../../../src/main/services/SessionStoreHost'
import {
  setDefaultLearningProgress,
  type LearningProgress
} from '../../../../src/runtime/learning/progress/LearningProgress'
import { sendAgentMessage, fromSteeringMessage } from '../../../../src/main/agent/turn/AgentTurnService'
import { isToolVisibleInMode } from '../../../../src/shared/session/toolVisibility'
import { createLearningAssessTool } from '../../../../src/runtime/tools/learning_assess'
import { createReadState } from '../../../../src/runtime/tools/editTool'

vi.mock('electron', () => ({
  app: {
    getPath: () => mkdtempSync(join(tmpdir(), 'nova-learn-gate-app-')),
    getAppPath: () => process.cwd()
  }
}))

vi.mock('../../../../src/main/services/RunCoordinatorHost', () => ({
  getRunCoordinator: () => ({
    getSnapshot: () => undefined,
    listSnapshotsForSession: () => [],
    listDispatchSnapshots: () => [],
    onTerminalHook: () => () => {},
    startRun: vi.fn(),
    inbox: { enqueue: vi.fn() }
  }),
  getRunExecutionRegistry: () => ({
    listActiveRunIds: () => [],
    get: () => null
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

  it('受信任学习投递遇到已绑定历史消息跳过重复执行时，仍将 outbox 标记为 delivered', async () => {
    const store = initSessionStoreHost(sessionsRoot)
    const session = store.create('/proj', 'learn')
    store.appendMessageFast(session.id, {
      id: 'u-bound',
      role: 'user',
      content: '应该是加载时重新查了数据库',
      timestamp: 1
    })
    store.appendMessageFast(session.id, {
      id: 'a-bound',
      role: 'assistant',
      content: '中断回复',
      userDelivery: { userMessageId: 'u-bound', modeInstruction: '', sessionPrefix: null },
      interrupted: true,
      timestamp: 2
    })

    const markOutboxDelivered = vi.fn().mockResolvedValue(undefined)
    setDefaultLearningProgress({ markOutboxDelivered } as unknown as LearningProgress)
    try {
      const result = await sendAgentMessage(
        {
          sessionId: session.id,
          trustedLearningDelivery: {
            userMessageId: 'u-bound',
            commandId: 'cmd-bound',
            displayText: '应该是加载时重新查了数据库',
            modelInput: '[学习回答]\n应该是加载时重新查了数据库'
          }
        },
        {
          getMainWindow: () => null,
          getModelClient: () => ({}) as never,
          getImageStore: () => ({}) as never
        }
      )
      expect(result.accepted).toBe(true)
      expect(markOutboxDelivered).toHaveBeenCalledWith('cmd-bound')
    } finally {
      setDefaultLearningProgress(null)
    }
  })
})
