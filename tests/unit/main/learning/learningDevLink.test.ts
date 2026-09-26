import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  initSessionStoreHost,
  resetSessionStoreHostForTests
} from '../../../../src/main/services/SessionStoreHost'
import {
  formatDevLinkTurnContent,
  verifyDevLinkReference
} from '../../../../src/main/learning/LearningSurfaceHost'

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'nova-devlink-app-')) }
}))

describe('开发 → 学习关联引用校验', () => {
  let sessionsRoot: string

  beforeEach(() => {
    sessionsRoot = mkdtempSync(join(tmpdir(), 'nova-devlink-sess-'))
    resetSessionStoreHostForTests()
    initSessionStoreHost(sessionsRoot)
  })

  afterEach(() => {
    resetSessionStoreHostForTests()
    rmSync(sessionsRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  function createDevSessionWithAssistant(): { sessionId: string; messageId: string } {
    const store = initSessionStoreHost(sessionsRoot)
    const session = store.create('/proj', 'default')
    const messageId = 'msg-assistant-1'
    store.appendMessage(session.id, {
      id: messageId,
      parentId: null,
      role: 'assistant',
      content: '已经把保存入口改成先写库再返回。',
      blocks: [{ type: 'text', content: '已经把保存入口改成先写库再返回。' }],
      messageSchemaVersion: 1
    })
    return { sessionId: session.id, messageId }
  }

  it('真实开发结果消息通过校验并给出短摘录', () => {
    const { sessionId, messageId } = createDevSessionWithAssistant()
    const verified = verifyDevLinkReference('/proj', {
      devSessionId: sessionId,
      devMessageId: messageId,
      filePaths: ['src/db.ts']
    })
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.assistantExcerpt).toContain('先写库再返回')
    }
  })

  it('会话不存在、跨项目、非开发会话、消息不存在都被拒绝', () => {
    const { sessionId, messageId } = createDevSessionWithAssistant()
    expect(
      verifyDevLinkReference('/proj', {
        devSessionId: 'missing',
        devMessageId: messageId,
        filePaths: []
      }).ok
    ).toBe(false)
    expect(
      verifyDevLinkReference('/other', {
        devSessionId: sessionId,
        devMessageId: messageId,
        filePaths: []
      }).ok
    ).toBe(false)
    expect(
      verifyDevLinkReference('/proj', {
        devSessionId: sessionId,
        devMessageId: 'missing-message',
        filePaths: []
      }).ok
    ).toBe(false)

    const store = initSessionStoreHost(sessionsRoot)
    const learn = store.create('/proj', 'learn')
    store.appendMessage(learn.id, {
      id: 'learn-msg',
      parentId: null,
      role: 'assistant',
      content: '讲解',
      blocks: [{ type: 'text', content: '讲解' }],
      messageSchemaVersion: 1
    })
    const learnResult = verifyDevLinkReference('/proj', {
      devSessionId: learn.id,
      devMessageId: 'learn-msg',
      filePaths: []
    })
    expect(learnResult.ok).toBe(false)
    if (!learnResult.ok) {
      expect(learnResult.message).toContain('开发会话')
    }
  })

  it('教练上下文只带引用与短摘录，不复制整段历史', () => {
    const content = formatDevLinkTurnContent(
      {
        devSessionId: 'dev-1',
        devMessageId: 'msg-1',
        filePaths: ['src/db.ts', 'src/api.ts']
      },
      '摘要文本'
    )
    // 用户可见消息不携带内部会话/消息标识
    expect(content).not.toContain('dev-1')
    expect(content).not.toContain('msg-1')
    expect(content).toContain('src/db.ts')
    expect(content).toContain('摘要文本')
    expect(content).toContain('请先核对当前代码')
  })
})
