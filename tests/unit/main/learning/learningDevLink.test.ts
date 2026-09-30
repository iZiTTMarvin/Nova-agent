import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  initSessionStoreHost,
  resetSessionStoreHostForTests
} from '../../../../src/main/services/SessionStoreHost'
import { verifyDevLinkReference } from '../../../../src/main/learning/LearningSurfaceHost'
import { resolveLearningDelivery } from '../../../../src/main/learning/LearningDelivery'

vi.mock('electron', () => ({
  app: { getPath: () => mkdtempSync(join(tmpdir(), 'nova-devlink-app-')) }
}))

describe('开发 → 学习改动来源', () => {
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

  function createDevSession(withChanges: boolean): { sessionId: string; messageId: string } {
    const store = initSessionStoreHost(sessionsRoot)
    const session = store.create('/proj', 'default')
    store.updateTitle(session.id, '保存流程重构', 'manual')
    const messageId = 'msg-assistant-1'
    const toolBlocks = withChanges
      ? [
          { type: 'tool' as const, toolCallId: 't1', toolName: 'edit', arguments: { filePath: 'src/db.ts', edits: [] }, status: 'success' as const },
          { type: 'tool' as const, toolCallId: 't2', toolName: 'write', arguments: { path: 'src/api.ts', content: 'x' }, status: 'success' as const },
          { type: 'tool' as const, toolCallId: 't3', toolName: 'edit', arguments: { filePath: 'src/db.ts', edits: [] }, status: 'success' as const },
          { type: 'tool' as const, toolCallId: 't4', toolName: 'write', arguments: { path: 'src/failed.ts', content: 'x' }, status: 'error' as const },
          { type: 'tool' as const, toolCallId: 't5', toolName: 'read', arguments: { path: 'src/read.ts' }, status: 'success' as const }
        ]
      : []
    store.appendMessage(session.id, {
      id: messageId,
      parentId: null,
      role: 'assistant',
      content: '已经把保存入口改成先写库再返回。',
      blocks: [...toolBlocks, { type: 'text', content: '已经把保存入口改成先写库再返回。' }],
      messageSchemaVersion: 1
    })
    return { sessionId: session.id, messageId }
  }

  it('改动文件只从成功的写入/编辑记录推导并去重', () => {
    const { sessionId, messageId } = createDevSession(true)
    const verified = verifyDevLinkReference('/proj', sessionId, messageId)
    expect(verified.ok).toBe(true)
    if (verified.ok) {
      expect(verified.files).toEqual(['src/db.ts', 'src/api.ts'])
      expect(verified.sessionTitle).toBe('保存流程重构')
      expect(verified.excerpt).toContain('先写库再返回')
    }
  })

  it('没改过代码、会话不存在、跨项目、非开发会话、消息不存在都被拒绝', () => {
    const plain = createDevSession(false)
    expect(verifyDevLinkReference('/proj', plain.sessionId, plain.messageId).ok).toBe(false)
    const { sessionId, messageId } = createDevSession(true)
    expect(verifyDevLinkReference('/proj', 'missing', messageId).ok).toBe(false)
    expect(verifyDevLinkReference('/other', sessionId, messageId).ok).toBe(false)
    expect(verifyDevLinkReference('/proj', sessionId, 'missing-message').ok).toBe(false)

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
    expect(verifyDevLinkReference('/proj', learn.id, 'learn-msg').ok).toBe(false)
  })

  it('用户看到的是一句短话，指令、摘录和内部标识只进模型输入', async () => {
    const { sessionId, messageId } = createDevSession(true)
    const text = await resolveLearningDelivery(
      JSON.stringify({ kind: 'deliver_command', action: { type: 'explain_change', devSessionId: sessionId, devMessageId: messageId } }),
      {
        loadTopicTitle: async () => null,
        loadDevChange: (s, m) => verifyDevLinkReference('/proj', s, m)
      }
    )
    expect(text.displayText).toBe('帮我搞懂「保存流程重构」里的这次改动')
    expect(text.modelInput).toContain('src/db.ts')
    expect(text.modelInput).toContain('先写库再返回')
    for (const leaked of [sessionId, messageId]) {
      expect(text.displayText).not.toContain(leaked)
      expect(text.modelInput).not.toContain(leaked)
    }
  })
})
