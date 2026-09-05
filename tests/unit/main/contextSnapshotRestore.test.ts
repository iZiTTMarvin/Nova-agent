import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { makeCompactionLedger } from '../../../src/test-support/builders/compactionLedger'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../src/runtime/sessions/SessionIndexHost'
import {
  persistCompactionSnapshot,
  restoreFromLedger,
  restoreOrInjectHistory
} from '../../../src/runtime/sessions/contextSnapshot'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import { extractTextFromContent } from '../../../src/runtime/model/types'
import { PermissionManager } from '../../../src/runtime/permissions/PermissionManager'
import type { ToolContext, ToolResult } from '../../../src/runtime/tools/types'
import { agentRoute } from '../../../src/runtime/agent/turn'
import type { MessageBlock } from '../../../src/shared/session'

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
  registry.register({ name: 'history_read', description: '读取压缩历史', parameters: { type: 'object', properties: {} }, execute: async () => ({ success: true, output: 'history' }) })
  return registry
}

describe('上下文账本恢复', () => {
  let tmpDir: string
  let store: SessionStore

  beforeEach(() => {
    // 防止 SessionIndexHost 模块级连接缓存跨测试文件泄漏
    resetSessionIndexHostForTests()
    tmpDir = mkdtempSync(join(tmpdir(), 'nova-ctx-snapshot-'))
    store = new SessionStore(tmpDir)
  })

  afterEach(() => {
    // 先经 Owner 关闭索引连接，再删临时目录，避免 Windows 上 messages-index.sqlite EBUSY
    resetSessionIndexHostForTests()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('压缩写账本后追加消息，恢复无重复无丢失', async () => {
    const session = store.create('/tmp/project', 'default')
    for (let i = 0; i < 24; i++) {
      store.appendMessage(session.id, {
        id: `user_${i}`,
        role: 'user',
        content: `历史问题 ${i} ${'x'.repeat(3_300)}`,
        timestamp: i * 2
      })
      store.appendMessage(session.id, {
        id: `asst_${i}`,
        role: 'assistant',
        content: `历史回复 ${i} ${'y'.repeat(3_300)}`,
        timestamp: i * 2 + 1
      })
    }

    const client = new MockModelClient()
    client.addCompactionPair({
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
      permissionManager: new PermissionManager(),
      systemPromptLayers: { agentRole: '你是助手。', toolSummary: 'ls' },
      toolSummaryRenderer: definitions => definitions.map(d => d.name).join('\n'),
      maxToolRounds: 20,
      onCompaction: (_ctx, meta) => persistCompactionSnapshot(store, session.id, meta.ledger)
    })
    loop.setToolRegistry(createTestRegistry())
    restoreOrInjectHistory(loop, store.load(session.id)!, null)

    expect(loop.getFrozenSystemPrompt()).not.toContain('history_read')
    await loop.sendMessage('触发压缩', agentRoute())
    expect(loop.getFrozenSystemPrompt()).toContain('history_read')
    expect(client.getCalls().at(-1)?.tools?.map(t => t.name)).toContain('history_read')

    const ledger = store.loadContextSnapshot(session.id)
    expect(ledger).not.toBeNull()
    expect(ledger!.state?.text).toBe('压缩摘要文本')
    expect(ledger).not.toHaveProperty('recentMessages')
    expect(JSON.stringify(ledger)).not.toContain('历史问题 0')

    store.appendMessage(session.id, {
      id: 'user_delta_1',
      role: 'user',
      content: '压缩后新问题',
      timestamp: 100_000
    })
    store.appendMessage(session.id, {
      id: 'asst_delta_1',
      role: 'assistant',
      content: '压缩后新回复',
      timestamp: 100_001
    })

    const reloaded = store.load(session.id)!
    const recoveryLoop = new AgentLoop(new MockModelClient(), eventBus, {
      permissionManager: new PermissionManager(),
      systemPromptLayers: { agentRole: '你是助手。', toolSummary: 'ls\nhistory_read' },
      toolSummaryRenderer: definitions => definitions.map(d => d.name).join('\n')
    })
    recoveryLoop.setToolRegistry(createTestRegistry())
    restoreOrInjectHistory(recoveryLoop, reloaded, store.loadContextSnapshot(session.id))

    expect(recoveryLoop.getFrozenSystemPrompt()).toBe(loop.getFrozenSystemPrompt())
    expect(recoveryLoop.getContext()[0]).toEqual(loop.getContext()[0])
    const ctx = recoveryLoop.getContext()
    expect(extractTextFromContent(ctx[0].content)).toContain('压缩摘要文本')
    const userTexts = ctx.filter(m => m.role === 'user').map(m => extractTextFromContent(m.content))
    expect(userTexts.filter(t => t.includes('压缩后新问题'))).toHaveLength(1)
    expect(userTexts.some(t => t.includes('历史问题 0'))).toBe(false)
    expect(reloaded.messages.map(m => m.id)).toContain('user_0')
    expect(reloaded.messages.map(m => m.id)).toContain('user_delta_1')
  })

  it('从 tailFrom 的 step 切片恢复，tool_call id 唯一（不叠两份子轮）', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, {
      id: 'u1',
      role: 'user',
      content: '分析并修复两个问题',
      timestamp: 1
    })
    const blocks: MessageBlock[] = [
      {
        type: 'tool',
        toolCallId: 'tc_a',
        toolName: 'read',
        arguments: { path: 'a.ts' },
        status: 'success',
        result: 'content of a.ts'
      },
      { type: 'thinking', content: '继续改 b.ts' },
      {
        type: 'tool',
        toolCallId: 'tc_b',
        toolName: 'edit',
        arguments: { path: 'b.ts' },
        status: 'success',
        result: 'edited b.ts'
      },
      { type: 'text', content: '已完成两处修复。' }
    ]
    store.appendMessage(session.id, {
      id: 'a1',
      role: 'assistant',
      content: '已完成两处修复。',
      blocks,
      toolCalls: [
        { id: 'tc_a', name: 'read', arguments: '{"path":"a.ts"}', result: 'content of a.ts' },
        { id: 'tc_b', name: 'edit', arguments: '{"path":"b.ts"}', result: 'edited b.ts' }
      ],
      timestamp: 2
    })

    const loaded = store.load(session.id)!
    const ledger = makeCompactionLedger({
      summary: '已读 a.ts',
      tailFrom: { messageId: 'a1', step: 1 },
      shadows: {
        from: { messageId: 'u1', step: 0 },
        to: { messageId: 'a1', step: 0 }
      },
    })
    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPrompt: '你是助手。'
    })
    restoreOrInjectHistory(loop, loaded, ledger)

    const ctx = loop.getContext()
    const toolCallIds = ctx.flatMap(m => m.toolCalls?.map(tc => tc.id) ?? [])
    expect(toolCallIds).toEqual(['tc_b'])
    expect(ctx.filter(m => m.role === 'tool').map(m => m.toolCallId)).toEqual(['tc_b'])
    expect(JSON.stringify(ctx)).not.toContain('content of a.ts')
    expect(JSON.stringify(ctx)).toContain('edited b.ts')
    expect(extractTextFromContent(ctx[0].content)).toContain('已读 a.ts')
  })

  it('tailFrom.messageId 尚未落盘时恢复为空尾部且不抛错', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, {
      id: 'u1', role: 'user', content: '问题一', timestamp: 1
    })
    const loaded = store.load(session.id)!
    const ledger = makeCompactionLedger({
      summary: '进行中摘要',
      tailFrom: { messageId: 'asst_inflight', step: 0 },
      shadows: {
        from: { messageId: 'u1', step: 0 },
        to: { messageId: 'u1', step: 0 }
      },
    })
    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPrompt: '你是助手。'
    })
    restoreOrInjectHistory(loop, loaded, ledger)
    const ctx = loop.getContext()
    expect(extractTextFromContent(ctx[0].content)).toContain('进行中摘要')
    expect(ctx.filter(m => m.role !== 'system')).toEqual([])
  })

  it('账本坐标不在激活路径时清空账本并全量 inject', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '问题一', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: '回复一', timestamp: 2 })
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: '问题二', timestamp: 3 })

    const ledger = makeCompactionLedger({
      summary: '折叠后摘要',
      tailFrom: { messageId: 'u2', step: 0 },
      shadows: {
        from: { messageId: 'u1', step: 0 },
        to: { messageId: 'u2', step: 0 }
      },
    })
    store.saveContextSnapshot(session.id, ledger)
    store.setCurrentLeaf(session.id, 'u1')

    const reloaded = store.load(session.id)!
    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPrompt: '你是助手。'
    })
    restoreOrInjectHistory(loop, reloaded, store.loadContextSnapshot(session.id), { sessionStore: store })

    expect(store.loadContextSnapshot(session.id)).toBeNull()
    const users = loop.getContext()
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))
    expect(users).toEqual(['问题一'])
    expect(extractTextFromContent(loop.getContext()[0].content)).not.toContain('折叠后摘要')
  })

  it('无账本时回退全量重建', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, {
      id: 'u1', role: 'user', content: '问题一', timestamp: 1
    })
    store.appendMessage(session.id, {
      id: 'a1', role: 'assistant', content: '回复一', timestamp: 2
    })

    const reloaded = store.load(session.id)!
    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPrompt: '你是助手。'
    })
    restoreOrInjectHistory(loop, reloaded, null)
    const users = loop.getContext()
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))
    expect(users).toContain('问题一')
  })

  it('截断历史后账本被清除，下次 restoreOrInjectHistory 走全量重建', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, { id: 'u0', role: 'user', content: '问题0', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a0', role: 'assistant', content: '回复0', timestamp: 2 })
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '问题1', timestamp: 3 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: '回复1', timestamp: 4 })
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: '问题2', timestamp: 5 })

    const loaded = store.load(session.id)!
    store.saveContextSnapshot(session.id, makeCompactionLedger({
      summary: '截断前摘要',
      tailFrom: { messageId: 'u1', step: 0 }
    }))
    expect(store.loadContextSnapshot(session.id)).not.toBeNull()

    const targetIdx = loaded.messages.findIndex(m => m.id === 'u2')
    expect(targetIdx).toBeGreaterThan(-1)
    loaded.messages = loaded.messages.slice(0, targetIdx)
    loaded.updatedAt = Date.now()
    store.save(loaded)
    store.clearContextSnapshot(session.id)

    expect(store.loadContextSnapshot(session.id)).toBeNull()

    const truncated = store.load(session.id)!
    const loop = new AgentLoop(new MockModelClient(), new EventBus(), {
      permissionManager: new PermissionManager(),
      systemPrompt: '你是助手。'
    })
    restoreOrInjectHistory(loop, truncated, store.loadContextSnapshot(session.id))

    const ctx = loop.getContext()
    expect(extractTextFromContent(ctx[0].content)).not.toContain('截断前摘要')
    const users = ctx.filter(m => m.role === 'user').map(m => extractTextFromContent(m.content))
    expect(users).toContain('问题0')
    expect(users).toContain('问题1')
    expect(users).not.toContain('问题2')
  })

  it('persistCompactionSnapshot 只写账本文件，不修改 session.messages', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, {
      id: 'm1', role: 'user', content: 'hello', timestamp: 1
    })

    const beforeMessages = structuredClone(store.load(session.id)!.messages)

    persistCompactionSnapshot(
      store,
      session.id,
      makeCompactionLedger({ summary: '摘要', tailFrom: { messageId: 'm1', step: 0 } })
    )

    expect(store.load(session.id)!.messages).toEqual(beforeMessages)
    expect(store.loadContextSnapshot(session.id)).not.toBeNull()
  })

  it('restore 两次发出的上下文 fingerprint 相同', () => {
    const session = store.create('/tmp/project', 'default')
    store.appendMessage(session.id, { id: 'u1', role: 'user', content: '旧', timestamp: 1 })
    store.appendMessage(session.id, { id: 'a1', role: 'assistant', content: '旧回', timestamp: 2 })
    store.appendMessage(session.id, { id: 'u2', role: 'user', content: '近', timestamp: 3 })
    const loaded = store.load(session.id)!
    const ledger = makeCompactionLedger({
      summary: '幂等摘要',
      tailFrom: { messageId: 'u2', step: 0 },
      shadows: {
        from: { messageId: 'u1', step: 0 },
        to: { messageId: 'a1', step: 0 }
      },
    })
    const a = restoreFromLedger(loaded, ledger, '你是助手。')
    const b = restoreFromLedger(loaded, ledger, '你是助手。')
    expect(JSON.stringify(a.messages)).toBe(JSON.stringify(b.messages))
  })
})
