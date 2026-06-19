import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { buildConversationContext } from '../../../src/runtime/agent/contextBuilder'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import {
  buildSnapshotFromCompaction,
  persistCompactionSnapshot,
  restoreOrInjectHistory
} from '../../../src/runtime/sessions/contextSnapshot'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import { extractTextFromContent } from '../../../src/runtime/model/types'
import type { ChatMessage } from '../../../src/runtime/model/types'
import { CONTEXT_SNAPSHOT_VERSION } from '../../../src/runtime/sessions/types'
import type { ToolContext, ToolResult } from '../../../src/runtime/tools/types'

/**
 * 阶段二集成测试：快照优先恢复 + 增量补齐 + 回退路径。
 * 使用与 agentHandler 相同的 contextSnapshot 模块，避免镜像漂移。
 */

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录: ${args.path ?? '.'}` }
    }
  })
  return registry
}

function injectCompactionTriggerHistory(loop: AgentLoop): void {
  const history: ChatMessage[] = []
  for (let i = 0; i < 24; i++) {
    history.push(
      { role: 'user', content: 'x'.repeat(20_000) },
      { role: 'assistant', content: 'y'.repeat(20_000) }
    )
  }
  loop.injectHistory(history)
}

describe('阶段二：上下文快照恢复', () => {
  let tmpDir: string
  let store: SessionStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nova-ctx-snapshot-'))
    store = new SessionStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('压缩 → 写快照 → 追加消息 → 快照优先恢复无重复无丢失（I3）', async () => {
    const session = store.create('/tmp/project', 'default')
    for (let i = 0; i < 6; i++) {
      store.appendMessage(session.id, {
        id: `user_${i}`,
        role: 'user',
        content: `历史问题 ${i}`,
        timestamp: i * 2
      })
      store.appendMessage(session.id, {
        id: `asst_${i}`,
        role: 'assistant',
        content: `历史回复 ${i}`,
        timestamp: i * 2 + 1
      })
    }

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '压缩摘要文本' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '继续' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, {
      systemPrompt: '你是助手。',
      maxToolRounds: 20,
      onCompaction: (ctx, meta) => persistCompactionSnapshot(store, session.id, ctx, meta)
    })
    loop.setToolRegistry(createTestRegistry())
    injectCompactionTriggerHistory(loop)

    await loop.sendMessage('触发压缩')

    const snapshot = store.loadContextSnapshot(session.id)
    expect(snapshot).not.toBeNull()
    expect(snapshot!.summary).toBe('压缩摘要文本')
    expect(snapshot!.recentMessages.every(m => m.role !== 'system')).toBe(true)
    expect(snapshot!.lastMessageId).toBe('asst_5')

    store.appendMessage(session.id, {
      id: 'user_delta_1',
      role: 'user',
      content: '压缩后新问题',
      timestamp: 100
    })
    store.appendMessage(session.id, {
      id: 'asst_delta_1',
      role: 'assistant',
      content: '压缩后新回复',
      timestamp: 101
    })

    const reloaded = store.load(session.id)!
    expect(reloaded.messages).toHaveLength(14)

    const recoveryClient = new MockModelClient()
    const recoveryLoop = new AgentLoop(recoveryClient, eventBus, {
      systemPrompt: '你是助手。'
    })
    recoveryLoop.setToolRegistry(createTestRegistry())
    restoreOrInjectHistory(recoveryLoop, reloaded, store.loadContextSnapshot(session.id))

    const ctx = recoveryLoop.getContext()
    const systemText = extractTextFromContent(ctx[0].content)
    expect(systemText).toContain('压缩摘要文本')

    const userTexts = ctx.filter(m => m.role === 'user').map(m => extractTextFromContent(m.content))
    expect(userTexts.filter(t => t.includes('压缩后新问题'))).toHaveLength(1)
    expect(snapshot!.recentMessages.length).toBeGreaterThan(0)
    expect(userTexts.length).toBe(
      snapshot!.recentMessages.filter(m => m.role === 'user').length + 1
    )

    expect(reloaded.messages.map(m => m.id)).toContain('user_0')
    expect(reloaded.messages.map(m => m.id)).toContain('user_delta_1')
  })

  it('快照 recent 与 session 尾部对齐时，恢复无重复（拟真场景）', () => {
    const session = store.create('/tmp/project', 'default')
    for (let i = 0; i < 3; i++) {
      store.appendMessage(session.id, {
        id: `user_${i}`,
        role: 'user',
        content: `历史问题 ${i}`,
        timestamp: i * 2
      })
      store.appendMessage(session.id, {
        id: `asst_${i}`,
        role: 'assistant',
        content: `历史回复 ${i}`,
        timestamp: i * 2 + 1
      })
    }

    const reloaded = store.load(session.id)!
    // 快照 recent 来自 session 尾部真实消息（与压缩后落盘结构一致）
    const tailMessages = reloaded.messages.slice(-4)
    const recentFromSession = buildConversationContext(
      { ...reloaded, messages: tailMessages },
      reloaded.mode
    )

    store.saveContextSnapshot(session.id, {
      version: CONTEXT_SNAPSHOT_VERSION,
      summary: '对齐摘要',
      recentMessages: recentFromSession,
      lastMessageId: 'asst_2',
      compactionLevel: 1,
      updatedAt: Date.now()
    })

    store.appendMessage(session.id, {
      id: 'user_delta',
      role: 'user',
      content: '压缩后新问题',
      timestamp: 100
    })

    const afterDelta = store.load(session.id)!
    const eventBus = new EventBus()
    const loop = new AgentLoop(new MockModelClient(), eventBus, {
      systemPrompt: '你是助手。'
    })
    loop.setToolRegistry(createTestRegistry())
    restoreOrInjectHistory(loop, afterDelta, store.loadContextSnapshot(session.id))

    const userTexts = loop.getContext()
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))

    // 尾部 u1/u2 各出现一次（来自快照 recent），u0 已摘要化不在上下文
    expect(userTexts.filter(t => t.includes('历史问题 1'))).toHaveLength(1)
    expect(userTexts.filter(t => t.includes('历史问题 2'))).toHaveLength(1)
    expect(userTexts.some(t => t.includes('历史问题 0'))).toBe(false)
    // 锚点后增量恰好一次
    expect(userTexts.filter(t => t.includes('压缩后新问题'))).toHaveLength(1)
    expect(extractTextFromContent(loop.getContext()[0].content)).toContain('对齐摘要')
  })

  it('无快照或锚点失效时回退全量重建（I2、I4）', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, {
      id: 'u1', role: 'user', content: '问题一', timestamp: 1
    })
    store.appendMessage(session.id, {
      id: 'a1', role: 'assistant', content: '回复一', timestamp: 2
    })
    store.appendMessage(session.id, {
      id: 'u2', role: 'user', content: '问题二', timestamp: 3
    })

    const reloaded = store.load(session.id)!
    const eventBus = new EventBus()
    const client = new MockModelClient()

    const loopNoSnapshot = new AgentLoop(client, eventBus, { systemPrompt: '你是助手。' })
    loopNoSnapshot.setToolRegistry(createTestRegistry())
    restoreOrInjectHistory(loopNoSnapshot, reloaded, null)

    const usersNoSnapshot = loopNoSnapshot.getContext()
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))
    expect(usersNoSnapshot).toContain('问题一')
    expect(usersNoSnapshot).toContain('问题二')

    store.saveContextSnapshot(session.id, {
      version: CONTEXT_SNAPSHOT_VERSION,
      summary: '过期摘要',
      recentMessages: [{ role: 'user', content: '仅快照内消息' }],
      lastMessageId: 'deleted_anchor_id',
      compactionLevel: 1,
      updatedAt: Date.now()
    })

    const loopStale = new AgentLoop(client, eventBus, { systemPrompt: '你是助手。' })
    loopStale.setToolRegistry(createTestRegistry())
    restoreOrInjectHistory(loopStale, reloaded, store.loadContextSnapshot(session.id))

    const ctxStale = loopStale.getContext()
    expect(extractTextFromContent(ctxStale[0].content)).not.toContain('过期摘要')
    const usersStale = ctxStale
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))
    expect(usersStale).toContain('问题一')
    expect(usersStale).toContain('问题二')
    expect(usersStale).not.toContain('仅快照内消息')
  })

  it('截断历史后快照被清除，下次 restoreOrInjectHistory 走全量重建（T2.8）', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, { id: 'u0', role: 'user', content: '问题0', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a0', role: 'assistant', content: '回复0', timestamp: 2 })
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '问题1', timestamp: 3 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: '回复1', timestamp: 4 })
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: '问题2', timestamp: 5 })

    const loaded = store.load(session.id)!
    store.saveContextSnapshot(session.id, buildSnapshotFromCompaction(
      loaded,
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: '快照内最近用户' },
        { role: 'assistant', content: '快照内最近助手' }
      ],
      { summary: '截断前摘要', compactionLevel: 1, trigger: 'threshold' }
    ))
    expect(store.loadContextSnapshot(session.id)).not.toBeNull()

    // 模拟 sessionHandler / WorkspaceService 截断分支
    const targetIdx = loaded.messages.findIndex(m => m.id === 'u2')
    expect(targetIdx).toBeGreaterThan(-1)
    loaded.messages = loaded.messages.slice(0, targetIdx)
    loaded.updatedAt = Date.now()
    store.save(loaded)
    store.clearContextSnapshot(session.id)

    expect(store.loadContextSnapshot(session.id)).toBeNull()

    const truncated = store.load(session.id)!
    const eventBus = new EventBus()
    const loop = new AgentLoop(new MockModelClient(), eventBus, { systemPrompt: '你是助手。' })
    loop.setToolRegistry(createTestRegistry())
    restoreOrInjectHistory(loop, truncated, store.loadContextSnapshot(session.id))

    const ctx = loop.getContext()
    expect(extractTextFromContent(ctx[0].content)).not.toContain('截断前摘要')
    const users = ctx.filter(m => m.role === 'user').map(m => extractTextFromContent(m.content))
    expect(users).toContain('问题0')
    expect(users).toContain('问题1')
    expect(users).not.toContain('问题2')
    expect(users).not.toContain('快照内最近用户')
  })

  it('persistCompactionSnapshot 只写快照文件，不修改 session.messages', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, {
      id: 'm1', role: 'user', content: 'hello', timestamp: 1
    })

    const beforeMessages = structuredClone(store.load(session.id)!.messages)

    persistCompactionSnapshot(
      store,
      session.id,
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'compact recent' }
      ],
      { summary: '摘要', compactionLevel: 1, trigger: 'threshold' }
    )

    expect(store.load(session.id)!.messages).toEqual(beforeMessages)
    expect(store.loadContextSnapshot(session.id)).not.toBeNull()
  })
})
