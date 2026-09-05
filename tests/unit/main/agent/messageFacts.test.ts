import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { SessionStore } from '../../../../src/runtime/sessions/SessionStore'
import { resetSessionIndexHostForTests } from '../../../../src/runtime/sessions/SessionIndexHost'
import { RunCoordinator } from '../../../../src/runtime/run/RunCoordinator'
import { RunStore } from '../../../../src/runtime/run/RunStore'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { agentRoute } from '../../../../src/runtime/agent/turn'
import { buildConversationContext } from '../../../../src/runtime/sessions'
import { toSharedMessage } from '../../../../src/main/ipc/sessionMessageMapper'
import { toRendererRunSnapshot } from '../../../../src/shared/run/rendererProjection'
import { forwardEventToRenderer } from '../../../../src/main/agent/events/AgentEventForwarder'
import type { MessageContext } from '../../../../src/main/agent/events/types'

let sessionStore: SessionStore
let coordinator: RunCoordinator
vi.mock('electron', () => ({ app: { getPath: () => '' }, BrowserWindow: class {} }))
vi.mock('../../../../src/main/services/SessionStoreHost', () => ({ getSessionStore: () => sessionStore }))
vi.mock('../../../../src/main/services/RunCoordinatorHost', () => ({ getRunCoordinator: () => coordinator }))
import { accumulateStreamEvent, activeStreams, markActiveStreamsCancelled } from '../../../../src/main/agent/events/AgentEventAccumulator'

const roots: string[] = []
afterEach(() => {
  activeStreams.clear()
  vi.restoreAllMocks()
  resetSessionIndexHostForTests()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
const hash = (s: string) => createHash('sha256').update(s).digest('hex')

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nova-message-facts-'))
  roots.push(root)
  sessionStore = new SessionStore(root)
  const session = sessionStore.create(root)
  const runStore = new RunStore({ runsRoot: join(root, 'runs') })
  coordinator = new RunCoordinator({ store: runStore })
  const run = coordinator.startRun({ kind: 'agent', sessionId: session.id, workspaceId: root })
  coordinator.bindExecutionGeneration(run.runId, 1)
  const bus = new EventBus()
  const ctx: MessageContext = { mode: 'default', permissionMode: 'full_access', workspaceRoot: root,
    sessionsDir: join(root, 'sessions'), eventBus: bus, getMainWindow: () => null,
    runId: run.runId, executionGeneration: 1 }
  return { root, session, run, runStore, bus, ctx,
    feed: (event: Parameters<typeof accumulateStreamEvent>[1]) => accumulateStreamEvent(session.id, event, ctx) }
}

describe('消息事实提交往返', () => {
  it.each(['x'.repeat(8035), 'y'.repeat(12000), '中文🙂'.repeat(2500)])('完整事件经过草稿和正式存储保留工具正文 %#', async (body) => {
    const { root, session, run, runStore, bus, ctx } = setup()
    expect(sessionStore.appendMessageFast(session.id, { id: 'user', role: 'user', content: '原始问题', timestamp: 1 }).ok).toBe(true)
    const draftHashes: string[] = []
    const send = vi.fn()
    const win = { isDestroyed: () => false, webContents: { isDestroyed: () => false, send } }
    bus.on(event => {
      accumulateStreamEvent(session.id, event, ctx)
      forwardEventToRenderer(win as never, event)
      if (event.type === 'tool_result') {
        const snapshot = runStore.loadSnapshot(run.runId)!
        const blocks = snapshot.turnDraft?.blocks ?? []
        const block = blocks.find(b => b.type === 'tool' && b.toolCallId === event.toolCallId)
        draftHashes.push(hash(String(block?.type === 'tool' ? block.result : undefined)))
        const preview = toRendererRunSnapshot(snapshot)!.turnDraft!.blocks.find(b => b.type === 'tool')
        expect(preview?.type === 'tool' && preview.result!.length < body.length).toBe(true)
      }
    })
    const client = new MockModelClient()
    for (const id of ['a', 'b']) client.addResponse({ events: [
      { type: 'message_start' },
      { type: 'tool_call', toolCall: { id, name: 'probe', arguments: '{ "value": 1 }' } },
      { type: 'message_end', finishReason: 'tool_calls' }
    ] })
    client.addResponse({ events: [{ type: 'thinking_delta', delta: '最后一轮推理' }, { type: 'text_delta', delta: 'done' }, { type: 'message_end', finishReason: 'stop' }] })
    const registry = new ToolRegistry()
    registry.register({ name: 'probe', description: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } } },
      execute: async () => ({ success: true, output: body, artifactId: '0123456789ab',
        truncationMeta: { totalBytes: Buffer.byteLength(body), totalLines: 1, shownLines: 1, truncated: false } }) })
    const loop = new AgentLoop(client, bus, { permissionManager: new PermissionManager(), permissionMode: 'full_access' })
    loop.setToolRegistry(registry)
    loop.setSessionId(session.id)
    loop.setModeInstructionProvider(() => '当时的模式指令')
    const outcome = await loop.sendMessage('原始问题', agentRoute(), { userMessageId: 'user' })
    expect(outcome.status).toBe('completed')
    const loaded = sessionStore.load(session.id)!
    const restored = buildConversationContext(loaded, 'default')
    const results = restored.filter(m => m.role === 'tool')
    expect(draftHashes).toEqual([hash(body), hash(body)])
    expect(results.map(m => hash(String(m.content)))).toEqual([hash(body), hash(body)])
    expect(restored.filter(m => m.role === 'assistant').map(m => m.toolCalls?.map(t => t.id) ?? [])).toEqual([['a'], ['b'], []])
    const sent = client.getCalls().at(-1)!.messages.filter(m => m.role === 'assistant' && m.toolCalls)
    expect(restored.filter(m => m.toolCalls).map(m => m.toolCalls)).toEqual(sent.map(m => m.toolCalls))
    expect(coordinator.getSnapshot(run.runId)?.turnDraft).toBeNull()
    const assistant = loaded.messages.find(m => m.role === 'assistant')!
    expect(assistant.messageSchemaVersion).toBe(2)
    expect(assistant.userDelivery).toMatchObject({ userMessageId: 'user', modeInstruction: '当时的模式指令' })
    const delivery = assistant.userDelivery!
    expect(client.getCalls()[0].messages.find(m => m.origin?.messageId === 'user')?.content)
      .toBe(`${delivery.sessionPrefix ? delivery.sessionPrefix + '\n\n' : ''}原始问题\n\n${delivery.modeInstruction}`)
    const replay = buildConversationContext(loaded, 'default', { reasoningReplay: 'all-history' })
    expect(replay.filter(m => m.role === 'assistant').map(m => m.reasoningContent)).toEqual([undefined, undefined, '最后一轮推理'])
    expect(assistant.blocks!.find(b => b.type === 'thinking')).toMatchObject({ responseStep: 2, providerId: expect.any(String) })
    expect(loaded.messages[0].content).toBe('原始问题')
    expect(results.map(m => m.artifactId)).toEqual(['0123456789ab', '0123456789ab'])
    const disk = readFileSync(join(root, 'sessions', session.id, 'messages.jsonl'), 'utf8')
    expect(disk.split(body).length - 1).toBe(2)
    const ui = toSharedMessage(assistant)
    expect(ui.blocks?.filter(b => b.type === 'tool').every(b => (b.result?.length ?? 0) < body.length)).toBe(true)
    expect(send.mock.calls.filter(([channel]) => channel === 'agent:tool-result').map(([, payload]) => payload.result.length))
      .toEqual(ui.blocks?.filter(b => b.type === 'tool').map(b => b.result!.length))
    console.info(JSON.stringify({ chars: body.length, bytes: Buffer.byteLength(body), sha256: hash(body),
      draftHashes, restoredHashes: results.map(m => hash(String(m.content))), toolSteps: results.map(m => m.origin?.step),
      uiChars: ui.blocks?.filter(b => b.type === 'tool').map(b => b.result!.length) }))
  })

  it.each(['message_end', 'error'] as const)('过期 generation 的 %s 不提交或清除草稿', type => {
    const { feed, run, session, runStore } = setup()
    feed({ type: 'message_start', messageId: 'a' })
    feed({ type: 'tool_call', messageId: 'a', toolCallId: 't', toolName: 'probe', args: {} })
    const before = runStore.loadSnapshot(run.runId)!.turnDraft
    coordinator.invalidateExecutionGeneration(run.runId)
    feed(type === 'error' ? { type, messageId: 'a', error: 'late' } : { type, messageId: 'a' })
    expect(sessionStore.load(session.id)!.messages).toEqual([])
    expect(runStore.loadSnapshot(run.runId)!.turnDraft).toEqual(before)
  })

  it('取消后丢弃晚到正文与工具结果，保留取消前事实并封存中断', () => {
    const { feed, run, session } = setup()
    feed({ type: 'message_start', messageId: 'a' })
    feed({ type: 'text_delta', messageId: 'a', delta: '已产生' })
    feed({ type: 'tool_call', messageId: 'a', toolCallId: 't', toolName: 'probe', args: {} })
    markActiveStreamsCancelled(run.runId)
    feed({ type: 'text_delta', messageId: 'a', delta: 'late' })
    feed({ type: 'tool_result', messageId: 'a', toolCallId: 't', toolName: 'probe', result: 'late' })
    feed({ type: 'message_end', messageId: 'a', interrupted: true })
    const message = sessionStore.load(session.id)!.messages[0]
    expect(message.content).toBe('已产生')
    expect(message.interrupted).toBe(true)
    expect(message.toolCalls![0].result).toBe('工具执行被中断')
  })

  it.each(['message_end', 'error'] as const)('正式追加失败的 %s 保留完整草稿和注入事实', type => {
    const { feed, run, runStore, session } = setup()
    feed({ type: 'message_start', messageId: 'a' })
    feed({ type: 'user_delivery', messageId: 'a', facts: { userMessageId: 'u', sessionPrefix: 'prefix', modeInstruction: 'mode' } })
    feed({ type: 'tool_call', messageId: 'a', toolCallId: 't', toolName: 'probe', args: {} })
    feed({ type: 'tool_result', messageId: 'a', toolCallId: 't', toolName: 'probe', result: '完整正文' })
    vi.spyOn(sessionStore, 'appendMessageFast').mockReturnValue({ ok: false, status: 'failed', error: 'disk_failure' })
    feed(type === 'error' ? { type, messageId: 'a', error: 'failure' } : { type, messageId: 'a' })
    const draft = runStore.loadSnapshot(run.runId)!.turnDraft!
    expect(draft.finalized).toBe(false)
    expect(draft.userDelivery?.sessionPrefix).toBe('prefix')
    expect(draft.blocks.find(b => b.type === 'tool')).toMatchObject({ result: '完整正文' })
    expect(sessionStore.load(session.id)!.messages).toEqual([])
  })

  it('未知消息格式从真实磁盘读取失败且原始文件不变', () => {
    const { root, session } = setup()
    const path = join(root, 'sessions', session.id, 'messages.jsonl')
    const raw = JSON.stringify({ id: 'a', parentId: null, role: 'assistant', content: '保留原档案', timestamp: 1,
      messageSchemaVersion: 99 }) + '\n'
    writeFileSync(path, raw)
    expect(sessionStore.load(session.id)).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(raw)
  })
})

it('native XML 参数修复后再提交，首发与恢复使用同一规范参数', async () => {
  const { bus, ctx, session } = setup()
  bus.on(event => accumulateStreamEvent(session.id, event, ctx))
  const client = new MockModelClient()
  client.addResponse({ events: [
    { type: 'tool_call', toolCall: { id: 'xml', name: 'probe', arguments: '<invoke name="probe"><parameter name="value">42</parameter></invoke>' } },
    { type: 'message_end', finishReason: 'tool_calls' }
  ] })
  client.addResponse({ events: [{ type: 'text_delta', delta: 'done' }, { type: 'message_end', finishReason: 'stop' }] })
  let received: unknown
  const registry = new ToolRegistry()
  registry.register({ name: 'probe', description: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } } }, execute: async args => { received = args; return { success: true, output: 'ok' } } })
  const loop = new AgentLoop(client, bus, { permissionManager: new PermissionManager(), permissionMode: 'full_access' })
  loop.setToolRegistry(registry)
  await loop.sendMessage('go', agentRoute())
  expect(received).toEqual({ value: 42 })
  const sent = client.getCalls().at(-1)!.messages.find(m => m.toolCalls?.some(t => t.id === 'xml'))!.toolCalls
  const restored = buildConversationContext(sessionStore.load(session.id)!, 'default').find(m => m.toolCalls)?.toolCalls
  expect(sent).toEqual([{ id: 'xml', name: 'probe', arguments: '{"value":42}' }])
  expect(restored).toEqual(sent)
})

it('草稿提交回调失效 generation 后不追加或清除事实', () => {
  const { feed, run, runStore, session } = setup()
  feed({ type: 'message_start', messageId: 'a' })
  feed({ type: 'text_delta', messageId: 'a', delta: 'old' })
  coordinator = new RunCoordinator({ store: runStore, onSnapshot: (_snapshot, event) => {
    if (event.type === 'turn_draft_upsert') coordinator.invalidateExecutionGeneration(run.runId)
  } })
  feed({ type: 'message_end', messageId: 'a' })
  expect(sessionStore.load(session.id)!.messages).toEqual([])
  expect(runStore.loadSnapshot(run.runId)!.turnDraft).not.toBeNull()
})
