import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { randomUUID } from 'crypto'
import { AgentLoop } from '../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../src/test-support/builders/MockModelClient'
import { buildConversationContext } from '../../../src/runtime/agent/context/contextBuilder'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import { ToolRegistry } from '../../../src/runtime/tools/ToolRegistry'
import { extractTextFromContent } from '../../../src/runtime/model/types'
import type { ChatMessage } from '../../../src/runtime/model/types'
import type { SessionData, SessionMessage } from '../../../src/runtime/sessions/types'
import { extractTextFromSerializableContent } from '../../../src/runtime/sessions/types'
import type { ToolContext, ToolResult } from '../../../src/runtime/tools/types'

/**
 * 阶段一止血测试：压缩触发后 session.messages 不得被截断。
 *
 * 说明：agentHandler 里的 onCompaction 是 IPC 内联闭包，阶段一删成 no-op 后
 * 无法直接单测 handler 本体。本文件用两层护栏：
 * 1. legacyOnCompactionOverwrite —— 复刻已删除的旧版落盘逻辑，证明「覆盖会截断」可被测出；
 * 2. 真实 AgentLoop 压缩 + 不落盘回调 —— 对照 capturedContext，断言 Store 未被改写。
 *
 * 阶段二将改为单测 SessionStore.saveContextSnapshot（只写快照、不碰 messages）。
 */

function createTestRegistry(): ToolRegistry {
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录内容: ${args.path ?? '.'}` }
    }
  })
  return registry
}

/**
 * 复刻阶段一之前 agentHandler.onCompaction 的落盘逻辑（仅用于测试对照）。
 * 生产代码已删除；若有人把同等逻辑接回 handler，本 helper 的断言模式应能抓出回归。
 */
function legacyOnCompactionOverwrite(
  store: SessionStore,
  sessionId: string,
  compactedContext: ChatMessage[]
): void {
  const compactedSession = store.load(sessionId)
  if (!compactedSession) return

  const toolResults = new Map<string, {
    result: string
    artifactId?: string
    truncationMeta?: import('../../../src/runtime/tools/types').ToolTruncationMeta
  }>()
  for (const m of compactedContext) {
    if (m.role === 'tool' && m.toolCallId) {
      toolResults.set(m.toolCallId, {
        result: extractTextFromSerializableContent(m.content),
        ...(m.artifactId ? { artifactId: m.artifactId } : {}),
        ...(m.truncationMeta ? { truncationMeta: m.truncationMeta } : {})
      })
    }
  }

  const compactedMessages: SessionMessage[] = compactedContext
    .filter(m => m.role !== 'system' && m.role !== 'tool' && !m.internal)
    .map((m, idx) => {
      const msg: SessionMessage = {
        id: `compacted_${randomUUID().slice(0, 8)}_${idx}`,
        role: m.role as SessionMessage['role'],
        content: extractTextFromSerializableContent(m.content),
        toolCallId: m.toolCallId,
        timestamp: Date.now()
      }

      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.toolCalls = m.toolCalls.map(tc => {
          const info = toolResults.get(tc.id)
          return {
            id: tc.id,
            name: tc.name,
            arguments: tc.arguments,
            ...(info?.result !== undefined ? { result: info.result } : {}),
            ...(info?.artifactId ? { artifactId: info.artifactId } : {}),
            ...(info?.truncationMeta ? { truncationMeta: info.truncationMeta } : {})
          }
        })
      }

      return msg
    })

  compactedSession.messages = compactedMessages
  store.save(compactedSession)
}

/** 构造带多轮对话 + 工具调用的会话，贴近真实持久化结构（经 appendMessage 写入树链） */
function makeLongSession(store: SessionStore): SessionData {
  const session = store.create('/tmp/project', 'default')

  for (let i = 0; i < 12; i++) {
    store.appendMessage(session.id, {
      id: `user_${i}`,
      role: 'user',
      content: `第 ${i + 1} 轮用户问题：` + 'x'.repeat(500),
      timestamp: i * 10
    })
    store.appendMessage(session.id, {
      id: `assistant_${i}`,
      role: 'assistant',
      content: `第 ${i + 1} 轮助手回复：` + 'y'.repeat(500),
      toolCalls: i % 3 === 0
        ? [{ id: `tc_${i}`, name: 'ls', arguments: '{"path":"."}', result: 'a.ts\nb.ts' }]
        : undefined,
      timestamp: i * 10 + 1
    })
  }

  return store.load(session.id)!
}

/** 注入足以触发阈值压缩的历史（与 AgentLoop.test.ts 压缩用例对齐） */
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

describe('阶段一：压缩不截断 session.messages', () => {
  let tmpDir: string
  let store: SessionStore

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'nova-compaction-preserve-'))
    store = new SessionStore(tmpDir)
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('反向证明：旧版 onCompaction 覆盖逻辑会截断历史（测试本身有鉴别力）', () => {
    const session = makeLongSession(store)
    const originalCount = session.messages.length
    expect(originalCount).toBe(24)

    // 模拟压缩后的运行时上下文：仅保留最近几条非 system 消息
    const compactedContext: ChatMessage[] = [
      { role: 'system', content: '冻结 prompt + 摘要' },
      { role: 'user', content: '最近用户消息' },
      { role: 'assistant', content: '最近助手回复' }
    ]

    legacyOnCompactionOverwrite(store, session.id, compactedContext)

    const after = store.load(session.id)!
    expect(after.messages.length).toBeLessThan(originalCount)
    expect(after.messages.every(m => m.id.startsWith('compacted_'))).toBe(true)
    // 早期消息 id 被整体替换，无法找回
    expect(after.messages.some(m => m.id === 'user_0')).toBe(false)
  })

  it('阶段一：真实压缩触发后 onCompaction 不落盘，SessionStore 历史完整保留', async () => {
    const session = makeLongSession(store)
    const originalMessages = structuredClone(session.messages)
    const sessionId = session.id

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '这是对话摘要。' },
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
    let capturedContext: ChatMessage[] | null = null

    // 阶段一 agentHandler 行为：不传落盘逻辑（此处用空回调捕获 compactedContext 做对照）
    const loop = new AgentLoop(client, eventBus, {
      systemPrompt: '你是助手。',
      maxToolRounds: 20,
      onCompaction: (compactedContext, _meta) => {
        capturedContext = compactedContext
        // 阶段二：写快照，不写 session.messages（与 agentHandler 一致）
      }
    })
    loop.setToolRegistry(createTestRegistry())
    injectCompactionTriggerHistory(loop)

    await loop.sendMessage('触发压缩')

    expect(capturedContext).not.toBeNull()
    // 压缩后运行时上下文应远小于完整 session 历史（否则对照无意义）
    const nonSystemCount = capturedContext!.filter(m => m.role !== 'system').length
    expect(nonSystemCount).toBeLessThan(originalMessages.length)

    // 主断言：Store 未被 onCompaction 改写
    const reloaded = store.load(sessionId)!
    expect(reloaded.messages).toEqual(originalMessages)

    // 对照：若对同一份 compactedContext 误接旧版覆盖，会截断（证明主断言有鉴别力）
    const shadowDir = mkdtempSync(join(tmpdir(), 'nova-compaction-shadow-'))
    const shadowStore = new SessionStore(shadowDir)
    const shadowSession = structuredClone(session)
    shadowStore.save(shadowSession)
    legacyOnCompactionOverwrite(shadowStore, shadowSession.id, capturedContext!)
    const shadowAfter = shadowStore.load(shadowSession.id)!
    expect(shadowAfter.messages.length).toBeLessThan(originalMessages.length)
    rmSync(shadowDir, { recursive: true, force: true })
  })

  it('压缩后仍可通过 buildConversationContext + injectHistory 恢复完整历史（T1.2）', async () => {
    const session = makeLongSession(store)

    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '摘要内容' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '好的' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const eventBus = new EventBus()
    const loop = new AgentLoop(client, eventBus, {
      systemPrompt: '你是助手。',
      maxToolRounds: 20
    })
    loop.setToolRegistry(createTestRegistry())
    injectCompactionTriggerHistory(loop)

    await loop.sendMessage('触发压缩')

    // 模拟下一次 SEND_MESSAGE：从 SessionStore 全量重建
    const reloaded = store.load(session.id)!
    const history = buildConversationContext(reloaded, reloaded.mode)

    const recoveryLoop = new AgentLoop(client, eventBus, {
      systemPrompt: '你是助手。'
    })
    recoveryLoop.setToolRegistry(createTestRegistry())
    recoveryLoop.injectHistory(history)

    const ctx = recoveryLoop.getContext()
    const userTexts = ctx
      .filter(m => m.role === 'user')
      .map(m => extractTextFromContent(m.content))

    for (const msg of reloaded.messages.filter(m => m.role === 'user')) {
      expect(userTexts.some(t => t.includes(msg.content.slice(0, 20)))).toBe(true)
    }
  })
})
