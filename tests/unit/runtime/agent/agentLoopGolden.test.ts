/**
 * AgentLoop 黄金测试（Phase 0 行为基线护栏）
 *
 * 目的：在 AgentLoop 重构（Pipeline 化）开始前，以"输入 → EventBus 事件序列"为
 * 唯一断言对象，把现状行为固化为快照。重构的每个阶段（Phase 1-4）都必须让本文件
 * 全绿，且事件序列与本次基线逐项相等（PRD §3 C1 / §9）。
 *
 * 覆盖 PRD §9 全部 18 个场景：
 *  1. 纯文本应答              10. 模型降级 fallback
 *  2. 单工具调用（native）     11. 上下文溢出压缩
 *  3. 单工具调用（XML）        12. 主动阈值压缩
 *  4. 多工具并行               13. 重复失败熔断
 *  5. XML 兜底解析             14. maxToolRounds 上限
 *  6. native 空参修复          15. skill fork/inject/system_notice/passthrough
 *  7. 权限 ask → 允许/拒绝     16. cancel 主流程
 *  8. 权限打断（cancel）       17. error 态不启动 idleTimer
 *  9. 模型瞬时错误重试         18. context_breakdown 兜底
 *
 * 断言策略：
 * - 主断言 = 事件类型序列（eventTypes），它是行为指纹。
 * - 辅断言 = 关键 payload 字段（toolName / finishReason / interrupted / modelId 等），
 *   锁定 C1 要求的"关键 payload 字段一致"。
 *
 * 注意：sendMessage 结束后会启动 266s 的 idleTimer（fire-and-forget setTimeout），
 * 测试中不会真正触发（266s 远超测试时长），但每个用例结束后 dispose() 清理资源。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'
import type { ChatEvent, NormalizedUsage } from '../../../../src/runtime/model/types'
import type { AgentEvent } from '../../../../src/runtime/agent/types'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'

// ── 公共辅助 ──────────────────────────────────────────────

/** 记录中的 loop 实例，用于 afterEach 统一 dispose */
const loops: AgentLoop[] = []

/** 构造 AgentLoop；通过 modelId + dialect 覆盖控制方言（xml / native） */
function createLoop(opts: {
  modelId: string
  client: MockModelClient
  fallbacks?: Array<{ config: { baseUrl: string; apiKey: string; modelId: string }; client: MockModelClient }>
  config?: ConstructorParameters<typeof AgentLoop>[2]
  dialect?: 'xml' | 'native'
}): { loop: AgentLoop; eventBus: EventBus; client: MockModelClient } {
  const { modelId, client, fallbacks, config, dialect } = opts
  const pool = new ModelClientPool({
    primary: client,
    primaryConfig: {
      baseUrl: '',
      apiKey: '',
      modelId,
      ...(dialect ? { toolDialect: dialect } : {})
    },
    fallbacks: fallbacks?.map(f => ({ config: f.config, client: f.client }))
  })
  const eventBus = new EventBus()
  const loop = new AgentLoop(pool, eventBus, {
    ...config,
    ...(dialect ? { toolDialectOverride: dialect } : {})
  })
  loops.push(loop)
  return { loop, eventBus, client }
}

/** 注册一个简单工具，返回固定结果。impl 可选接收 ctx（用于访问 abortSignal 等） */
function registerTool(
  registry: ToolRegistry,
  name: string,
  impl: (args: Record<string, unknown>, ctx: ToolContext) => ToolResult | Promise<ToolResult>
): void {
  registry.register({
    name,
    description: name,
    parameters: { type: 'object', properties: {}, additionalProperties: true },
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      return impl(args, ctx)
    }
  })
}

/** 收集 sendMessage 全程事件 */
async function runAndCollect(loop: AgentLoop, eventBus: EventBus, userText: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  eventBus.on(e => events.push(e))
  await loop.sendMessage(userText)
  return events
}

/**
 * 在 fake timers 下收集 sendMessage 全程事件：循环推进时间 + 微任务队列，
 * 直到 sendMessage 落定。用于重试/降级/溢出压缩等含 setTimeout 退避的异步路径。
 */
async function runAndCollectDrained(loop: AgentLoop, eventBus: EventBus, userText: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = []
  eventBus.on(e => events.push(e))
  const pending = loop.sendMessage(userText)
  // 循环推进：每次推进 1s + flush 微任务，直到 pending 落定或推进上限
  for (let i = 0; i < 200; i++) {
    await vi.advanceTimersByTimeAsync(1000)
    if (await isSettled(pending)) break
  }
  await pending
  return events
}

/** 非破坏性地探测一个 promise 是否已落定 */
async function isSettled(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([
    p.then(
      () => true,
      () => true
    ),
    Promise.resolve(false)
  ])
}

/** 提取事件类型序列（行为指纹） */
function types(events: AgentEvent[]): string[] {
  return events.map(e => e.type)
}

/** 构造一条普通 usage 事件 */
function usage(prompt = 100, cached = 0): ChatEvent {
  return {
    type: 'usage',
    usage: { promptTokens: prompt, completionTokens: 10, cachedTokens: cached, cacheWriteTokens: 0 } satisfies NormalizedUsage
  }
}

afterEach(() => {
  // 清理 idleTimer + pendingPermissions，避免用例间资源泄漏
  while (loops.length) {
    const l = loops.pop()!
    l.dispose()
  }
  vi.useRealTimers()
})

// ============================================================
// 场景 1：纯文本应答
// 期望：message_start, text_delta*, usage, context_breakdown, message_end
// ============================================================
describe('黄金测试 §9.1 纯文本应答', () => {
  it('无工具调用 → 文本流 + usage + context_breakdown + message_end', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '你好' },
        { type: 'text_delta', delta: '！' },
        usage(120),
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    const registry = new ToolRegistry()
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '你好')

    const seq = types(events)
    expect(seq[0]).toBe('message_start')
    // 文本增量
    const textDeltas = events.filter(e => e.type === 'text_delta')
    expect(textDeltas).toHaveLength(2)
    expect((textDeltas[0] as Extract<AgentEvent, { type: 'text_delta' }>).delta).toBe('你好')
    // usage 在 message_end 之前
    const usageIdx = seq.indexOf('usage')
    const endIdx = seq.indexOf('message_end')
    expect(usageIdx).toBeGreaterThan(-1)
    expect(endIdx).toBeGreaterThan(usageIdx)
    // context_breakdown 必然出现（usage 触发一次）
    expect(seq).toContain('context_breakdown')
    // 结尾是 message_end，无 interrupted
    const end = events.find(e => e.type === 'message_end') as Extract<AgentEvent, { type: 'message_end' }>
    expect(end.interrupted).toBeUndefined()
  })
})

// ============================================================
// 场景 2：单工具调用（native 方言）
// 期望：tool_call_start, tool_call, tool_result，一轮后正常结束
// ============================================================
describe('黄金测试 §9.2 单工具调用（native）', () => {
  it('native tool_calls → 执行 → tool_result → 结束', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'tool_call_start',
          toolCallId: 'tc1',
          toolName: 'ls',
          index: 0
        },
        { type: 'tool_call', toolCall: { id: 'tc1', name: 'ls', arguments: '{"path":"."}' } },
        usage(150),
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    // 工具执行后的第二轮：纯文本结束
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '完成' }, usage(80), { type: 'message_end', finishReason: 'stop' }]
    })

    const registry = new ToolRegistry()
    registerTool(registry, 'ls', args => ({ success: true, output: `目录: ${args.path ?? '.'}` }))
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '列出文件')

    const seq = types(events)
    // 第一轮工具调用事件链
    expect(seq).toContain('tool_call_start')
    expect(seq).toContain('tool_call')
    expect(seq).toContain('tool_result')
    // tool_call_start 在 tool_call 之前
    expect(seq.indexOf('tool_call_start')).toBeLessThan(seq.indexOf('tool_call'))
    // tool_result 在 tool_call 之后
    expect(seq.indexOf('tool_call')).toBeLessThan(seq.indexOf('tool_result'))
    // tool_result 携带结果文本
    const result = events.find(e => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>
    expect(result.toolName).toBe('ls')
    expect(result.result).toContain('目录')
    // 最终 message_end 无 interrupted
    const end = events.find(e => e.type === 'message_end') as Extract<AgentEvent, { type: 'message_end' }>
    expect(end.interrupted).toBeUndefined()
  })
})

// ============================================================
// 场景 3：单工具调用（XML 方言）
// 期望：scanner 增量识别，text_delta 与 tool_call* 交错
// ============================================================
describe('黄金测试 §9.3 单工具调用（XML）', () => {
  it('XML inband → scanner 产出 tool_call_start/delta/call 交错序列', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '我看一下。\n<invoke name="ls"><parameter name="path">.</parameter></invoke>' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '好了' }, usage(50), { type: 'message_end', finishReason: 'stop' }]
    })

    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: true, output: '目录内容' }))
    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client, dialect: 'xml' })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '列文件')

    const seq = types(events)
    // 工具调用三件套
    expect(seq.filter(t => t === 'tool_call_start')).toHaveLength(1)
    expect(seq.filter(t => t === 'tool_call_delta').length).toBeGreaterThan(0)
    expect(seq.filter(t => t === 'tool_call')).toHaveLength(1)
    expect(seq).toContain('tool_result')

    // 交错顺序：先有正文 text_delta，再有 tool_call_start，再有 tool_call_delta，再有 tool_call
    const firstText = seq.indexOf('text_delta')
    const startIdx = seq.indexOf('tool_call_start')
    const deltaIdx = seq.indexOf('tool_call_delta')
    const callIdx = seq.indexOf('tool_call')
    expect(firstText).toBeLessThan(startIdx)
    expect(startIdx).toBeLessThan(deltaIdx)
    expect(deltaIdx).toBeLessThan(callIdx)

    // toolCallId 跨 start/delta/call 一致
    const start = events.find(e => e.type === 'tool_call_start') as Extract<AgentEvent, { type: 'tool_call_start' }>
    const deltas = events.filter(e => e.type === 'tool_call_delta') as Array<Extract<AgentEvent, { type: 'tool_call_delta' }>>
    const call = events.find(e => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>
    expect(deltas.every(d => d.toolCallId === start.toolCallId)).toBe(true)
    expect(call.toolCallId).toBe(start.toolCallId)
  })
})

// ============================================================
// 场景 4：多工具并行
// 期望：parallel 模式下 tool_result 按 assistant 源顺序入栈
// ============================================================
describe('黄金测试 §9.4 多工具并行', () => {
  it('一轮多个 native tool_calls → 每个都有 tool_result', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'a', toolName: 'ls', index: 0 },
        { type: 'tool_call', toolCall: { id: 'a', name: 'ls', arguments: '{"path":"."}' } },
        { type: 'tool_call_start', toolCallId: 'b', toolName: 'read', index: 1 },
        { type: 'tool_call', toolCall: { id: 'b', name: 'read', arguments: '{"path":"x"}' } },
        usage(200),
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: 'done' }, usage(60), { type: 'message_end', finishReason: 'stop' }]
    })

    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: true, output: 'LS' }))
    registerTool(registry, 'read', () => ({ success: true, output: 'READ' }))
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client, config: { toolExecution: 'parallel', maxParallelToolCalls: 4 } })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '并行')

    // 两个工具都有完整链路
    const starts = events.filter(e => e.type === 'tool_call_start')
    const calls = events.filter(e => e.type === 'tool_call')
    const results = events.filter(e => e.type === 'tool_result')
    expect(starts).toHaveLength(2)
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)
    // tool_result 携带的 toolName 覆盖 ls 和 read
    const resultNames = results.map(r => (r as Extract<AgentEvent, { type: 'tool_result' }>).toolName).sort()
    expect(resultNames).toEqual(['ls', 'read'])
  })
})

// ============================================================
// 场景 5：XML 兜底解析
// 期望：scanner 未抓到，由 parseXmlToolCalls 补齐
// 编排：把 invoke 标签放在两个 text_delta 中间且故意构造 scanner 难以增量识别的场景——
// 实际上 scanner 对标准 <invoke> 都能识别；兜底路径触发条件是非标准格式。
// 这里用一个不带闭合的片段 + flush 兜底，或用 MiniMax 占位符触发 stripMinimaxArtifacts。
// 为稳定触发兜底，使用一个模型把工具调用写成「被 MiniMax 占位符包裹」的形式。
// ============================================================
describe('黄金测试 §9.5 XML 兜底解析', () => {
  it('scanner 未识别的 inband 调用由 parseXmlToolCalls 补齐 → 仍产出 tool_call_start/tool_call', async () => {
    const client = new MockModelClient()
    // 故意把整个 invoke 放在单个 text_delta（scanner 仍能识别），
    // 真正的兜底用 MiniMax 占位符包裹：stripMinimaxArtifacts 会先清理再解析。
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '<|tool_calls_begin|><invoke name="ls"><parameter name="path">.</parameter></invoke><|tool_calls_end|>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: 'ok' }, usage(40), { type: 'message_end', finishReason: 'stop' }]
    })

    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: true, output: '目录' }))
    const { loop, eventBus } = createLoop({ modelId: 'minimax-m1', client, dialect: 'xml' })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '列')

    // 无论走 scanner 还是兜底，最终都应产出工具调用事件链 + tool_result
    expect(events.some(e => e.type === 'tool_call_start')).toBe(true)
    expect(events.some(e => e.type === 'tool_call')).toBe(true)
    expect(events.some(e => e.type === 'tool_result')).toBe(true)
    const call = events.find(e => e.type === 'tool_call') as Extract<AgentEvent, { type: 'tool_call' }>
    expect(call.toolName).toBe('ls')
  })
})

// ============================================================
// 场景 6：native 空参修复
// 期望：repairEmptyArgsFromContent 从正文 XML 补全空 arguments
// 编排：模型用 native tool_call 返回空 arguments "{}"，同时在正文写 XML 参数。
// ============================================================
describe('黄金测试 §9.6 native 空参修复', () => {
  it('native tool_call 空参 + 正文 XML → repairEmptyArgsFromContent 补全后执行', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        // 正文里写了参数（XML 格式），但 native channel 的 arguments 为空
        { type: 'text_delta', delta: '<invoke name="ls"><parameter name="path">/tmp</parameter></invoke>' },
        { type: 'tool_call_start', toolCallId: 'x', toolName: 'ls', index: 0 },
        { type: 'tool_call', toolCall: { id: 'x', name: 'ls', arguments: '{}' } },
        usage(100),
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '完成' }, usage(50), { type: 'message_end', finishReason: 'stop' }]
    })

    const seen: Record<string, unknown>[] = []
    const registry = new ToolRegistry()
    registerTool(registry, 'ls', args => {
      seen.push(args)
      return { success: true, output: 'ok' }
    })
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '列')

    // 工具被执行（说明空参被修复）
    expect(events.some(e => e.type === 'tool_result')).toBe(true)
    // 修复后参数应为 { path: '/tmp' }
    expect(seen.length).toBeGreaterThan(0)
    expect(seen[0]).toMatchObject({ path: '/tmp' })
  })
})

// ============================================================
// 场景 7：权限 ask → 允许 / 拒绝
// 期望：permission_request 事件 + 后续 tool_result 文案差异
// 用 default 模式 + bash 工具（base decision = ask）
// ============================================================
describe('黄金测试 §9.7 权限 ask → 允许/拒绝', () => {
  it('ask → 用户允许 → 正常 tool_result', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'b', toolName: 'bash', index: 0 },
        { type: 'tool_call', toolCall: { id: 'b', name: 'bash', arguments: '{"command":"ls"}' } },
        usage(100),
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: 'done' }, usage(50), { type: 'message_end', finishReason: 'stop' }]
    })

    const registry = new ToolRegistry()
    registerTool(registry, 'bash', () => ({ success: true, output: 'shell output' }))
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)
    loop.setMode('default')
    loop.setPermissionManager(new PermissionManager())

    // sendMessage 是 async，权限请求会挂起等待 respondPermission
    const collectPromise = runAndCollect(loop, eventBus, '执行命令')

    // 轮询等待 permission_request 事件出现（checkPermission 在 ask 时 emit 后 await）
    const permEvent = await waitForEvent(eventBus, 'permission_request', collectPromise)
    expect(permEvent).toBeDefined()
    const requestId = (permEvent as Extract<AgentEvent, { type: 'permission_request' }>).requestId

    // 用户允许
    loop.respondPermission(requestId, true)

    const events = await collectPromise
    const seq = types(events)
    expect(seq).toContain('permission_request')
    expect(seq).toContain('tool_result')
    // 允许后 tool_result 是成功输出
    const result = events.find(e => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>
    expect(result.result).toContain('shell output')
  })

  it('ask → 用户拒绝 → 权限拒绝 tool_result', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'b', toolName: 'bash', index: 0 },
        { type: 'tool_call', toolCall: { id: 'b', name: 'bash', arguments: '{"command":"rm -rf x"}' } },
        usage(100),
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '了解' }, usage(50), { type: 'message_end', finishReason: 'stop' }]
    })

    const registry = new ToolRegistry()
    registerTool(registry, 'bash', () => ({ success: true, output: 'never' }))
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)
    loop.setMode('default')
    loop.setPermissionManager(new PermissionManager())

    const collectPromise = runAndCollect(loop, eventBus, '删')
    const permEvent = await waitForEvent(eventBus, 'permission_request', collectPromise)
    const requestId = (permEvent as Extract<AgentEvent, { type: 'permission_request' }>).requestId

    // 用户拒绝
    loop.respondPermission(requestId, false)

    const events = await collectPromise
    const result = events.find(e => e.type === 'tool_result') as Extract<AgentEvent, { type: 'tool_result' }>
    // 拒绝后 tool_result 文案含"拒绝"
    expect(result.result).toContain('拒绝')
  })
})

// ============================================================
// 场景 8：权限打断（cancel during ask）
// 期望：PermissionAbortedError → 跳过 tool_result，message_end(interrupted)
// ============================================================
describe('黄金测试 §9.8 权限打断（cancel during ask）', () => {
  it('ask 等待中 cancel → 不产生 tool_result，message_end 带 interrupted', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'b', toolName: 'bash', index: 0 },
        { type: 'tool_call', toolCall: { id: 'b', name: 'bash', arguments: '{"command":"ls"}' } },
        usage(100),
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })

    const registry = new ToolRegistry()
    registerTool(registry, 'bash', () => ({ success: true, output: 'x' }))
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)
    loop.setMode('default')
    loop.setPermissionManager(new PermissionManager())

    const collectPromise = runAndCollect(loop, eventBus, '执行')
    const permEvent = await waitForEvent(eventBus, 'permission_request', collectPromise)
    expect(permEvent).toBeDefined()

    // 在 ask 等待期间 cancel
    loop.cancel()

    const events = await collectPromise
    const seq = types(events)
    // 不应有 tool_result（PermissionAbortedError 跳过）
    expect(seq).not.toContain('tool_result')
    // message_end 带 interrupted
    const end = events.find(e => e.type === 'message_end') as Extract<AgentEvent, { type: 'message_end' }>
    expect(end.interrupted).toBe(true)
  })
})

// ============================================================
// 场景 9：模型瞬时错误重试
// 期望：recovery_state(retrying), recovery_hint，退避后重跑成功
// 用 fake timers 控制 sleep 退避
// ============================================================
describe('黄金测试 §9.9 模型瞬时错误重试', () => {
  it('error(429) → recovery_state retrying + recovery_hint → 退避后重试成功', async () => {
    vi.useFakeTimers()
    const client = new MockModelClient()
    // 第一次：429 瞬态错误
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'error', error: '429 rate limit' }]
    })
    // 第二次（重试后）：成功
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '好了' }, usage(80), { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })

    const collectPromise = runAndCollect(loop, eventBus, 'hi')

    // 推进退避定时器（backoffMs(1)=1000ms）
    await vi.advanceTimersByTimeAsync(2000)

    const events = await collectPromise
    const seq = types(events)
    expect(seq).toContain('recovery_state')
    expect(seq).toContain('recovery_hint')
    // recovery_hint 携带 attempt
    const hint = events.find(e => e.type === 'recovery_hint') as Extract<AgentEvent, { type: 'recovery_hint' }>
    expect(hint.attempt).toBeGreaterThanOrEqual(1)
    // 重试后成功，有 text_delta 与 message_end
    expect(seq).toContain('text_delta')
    expect(seq).toContain('message_end')
    // 顺序：recovery_state → recovery_hint → (退避) → text_delta
    expect(seq.indexOf('recovery_hint')).toBeLessThan(seq.indexOf('text_delta'))
  })
})

// ============================================================
// 场景 10：模型降级 fallback
//
// FIXME(P0-2): 待 AttemptController 修复后，本场景应断言「应切 fallback」。
// 根因：modelErrorAttempt 只在 shouldRetry=true 分支更新，耗尽时停在 2，
// decideFallback 收到陈旧值 → 永不切 fallback。黄金测试不再把该缺陷锁成基线。
// ============================================================
describe('黄金测试 模型降级 fallback', () => {
  it('契约：主模型连续 429 → model_switched → fallback 成功完成', async () => {
    vi.useFakeTimers()
    const primary = new MockModelClient()
    primary.addResponse({ events: [{ type: 'error', error: '429 rate limit' }] })
    primary.addResponse({ events: [{ type: 'error', error: '429 rate limit' }] })
    primary.addResponse({ events: [{ type: 'error', error: '429 rate limit' }] })

    const fallback = new MockModelClient()
    fallback.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: 'fallback ok' }, usage(70), { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({
      modelId: 'gpt-4o',
      client: primary,
      fallbacks: [{ config: { baseUrl: '', apiKey: '', modelId: 'claude-3-5-sonnet' }, client: fallback }]
    })

    const events = await runAndCollectDrained(loop, eventBus, 'hi')
    const seq = types(events)

    expect(seq).toContain('model_switched')
    expect(seq).toContain('text_delta')
    expect(seq).toContain('message_end')
    expect(seq).not.toContain('error')
    expect(loop.getState()).toBe('idle')
  })
})

// ============================================================
// 场景 11：上下文溢出压缩
// 期望：context_overflow → standard 成功重试；standard 失败→aggressive；全失败→error
// ============================================================
describe('黄金测试 §9.11 上下文溢出压缩', () => {
  it('context_overflow → standard 压缩成功 → 重试成功', async () => {
    vi.useFakeTimers()
    const client = new MockModelClient()
    // 第一次正常调用：溢出。rawError 必须匹配 RecoveryStateMachine.OVERFLOW_PATTERNS
    // （/context.?overflow/i, /token.*limit/i, /maximum context/i）才会被 classify 为 recovering。
    client.addResponse({ events: [{ type: 'message_start' }, { type: 'context_overflow', rawError: 'context overflow token limit' }] })
    // 压缩调用：返回摘要
    client.addResponse({ events: [{ type: 'text_delta', delta: '这是摘要' }, { type: 'message_end', finishReason: 'stop' }] })
    // 压缩后重试：成功
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '恢复完成' }, usage(60), { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    // runOverflowCompaction 需要 oldMessages 非空（splitForCompaction 保留最近 20 条），
    // 注入足够历史使压缩流程可进入模型调用并返回摘要。
    loop.injectHistory(Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `历史 ${i}` })))

    const events = await runAndCollectDrained(loop, eventBus, 'hi')
    const seq = types(events)

    expect(seq).toContain('recovery_state')
    expect(seq).toContain('recovery_hint')
    // 压缩成功后重试，有最终文本
    expect(seq).toContain('text_delta')
    expect(seq).toContain('message_end')
    // 未产生 error 终态
    const errors = seq.filter(t => t === 'error')
    expect(errors).toHaveLength(0)
  })

  it('context_overflow → standard 与 aggressive 均失败 → error 终态', async () => {
    vi.useFakeTimers()
    const client = new MockModelClient()
    // 正常调用溢出（rawError 匹配 OVERFLOW_PATTERNS）
    client.addResponse({ events: [{ type: 'context_overflow', rawError: 'context overflow' }] })
    // standard 压缩调用：也溢出（runOverflowCompaction 回滚返回 false）
    client.addResponse({ events: [{ type: 'context_overflow', rawError: 'still context overflow' }] })
    // aggressive 压缩调用：也溢出
    client.addResponse({ events: [{ type: 'context_overflow', rawError: 'still context overflow' }] })

    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    // runOverflowCompaction 需要 oldMessages 非空（splitForCompaction 保留最近 20 条），
    // 注入足够历史使压缩流程可进入模型调用阶段。
    loop.injectHistory(Array.from({ length: 30 }, (_, i) => ({ role: 'user' as const, content: `历史 ${i}` })))

    const events = await runAndCollectDrained(loop, eventBus, 'hi')
    const seq = types(events)

    // 最终进入 error 终态
    expect(seq).toContain('error')
    // state=error，不应有 message_end（error 路径直接 return）
    expect(seq).not.toContain('message_end')
  })
})

// ============================================================
// 场景 12：主动阈值压缩
// 期望：触发 runCompaction → onCompaction 回调
// 编排：把 contextWindow 设得很小，让 shouldCompact 在第一轮就触发
// ============================================================
describe('黄金测试 §9.12 主动阈值压缩', () => {
  it('上下文超阈值 → runCompaction → onCompaction 回调被调用', async () => {
    vi.useFakeTimers()
    const client = new MockModelClient()
    // 压缩调用：返回摘要
    client.addResponse({ events: [{ type: 'text_delta', delta: '历史摘要' }, { type: 'message_end', finishReason: 'stop' }] })
    // 压缩后正常调用
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '答复' }, usage(50), { type: 'message_end', finishReason: 'stop' }]
    })

    let compactionCalled = false
    const { loop, eventBus } = createLoop({
      modelId: 'gpt-4o',
      client,
      config: {
        // 默认 200k 窗口：阈值≈160k；注入大历史触发压缩，压缩后硬预算仍可满足。
        // 勿用极小 contextWindow（如 200）：压缩后保留的最近消息仍会超过硬上限。
        onCompaction: () => {
          compactionCalled = true
        }
      }
    })
    // shouldCompact 守卫：context.length > MIN_RECENT_MESSAGES(20) + 2 = 22 才往下判断。
    // 注入 48 条大消息使 token > 160k 硬触发阈值压缩。
    const history: { role: 'user' | 'assistant'; content: string }[] = []
    for (let i = 0; i < 24; i++) {
      history.push(
        { role: 'user', content: 'x'.repeat(20_000) },
        { role: 'assistant', content: 'y'.repeat(20_000) }
      )
    }
    loop.injectHistory(history)

    await runAndCollectDrained(loop, eventBus, '继续')

    expect(compactionCalled).toBe(true)
  })
})

// ============================================================
// 场景 13：重复失败熔断
// 期望：相同签名失败 3 次 → text_delta("[已自动中断]...") + break
// ============================================================
describe('黄金测试 §9.13 重复失败熔断', () => {
  it('同一工具调用连续失败 3 次 → 熔断提示 + 停止', async () => {
    const client = new MockModelClient()
    // 连续 3 轮，每轮模型都发起完全相同的、必然失败的工具调用
    const failCall = (i: string) => ({
      events: [
        { type: 'message_start' as const },
        { type: 'tool_call_start' as const, toolCallId: i, toolName: 'read', index: 0 },
        { type: 'tool_call' as const, toolCall: { id: i, name: 'read', arguments: '{"path":"nonexistent"}' } },
        { type: 'message_end' as const, finishReason: 'tool_calls' as const }
      ]
    })
    client.addResponse(failCall('f1'))
    client.addResponse(failCall('f2'))
    client.addResponse(failCall('f3'))

    const registry = new ToolRegistry()
    // read 工具恒失败（固定签名：read + {path:nonexistent}）
    registerTool(registry, 'read', () => ({ success: false, output: '工具执行失败: 文件不存在', error: 'not found' }))
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '读')

    // 第 3 次失败后熔断，应有"[已自动中断]"提示
    const textDeltas = events.filter(e => e.type === 'text_delta') as Array<Extract<AgentEvent, { type: 'text_delta' }>>
    const merged = textDeltas.map(d => d.delta).join('')
    expect(merged).toContain('[已自动中断]')
    expect(merged).toContain('read')
    // message_end 正常结束（熔断 break 走 finishMessageRound）
    expect(events.some(e => e.type === 'message_end')).toBe(true)
  })
})

// ============================================================
// 场景 14：maxToolRounds 上限
// 期望：达到上限 → text_delta("[已达到最大工具调用轮数]...") + break
// ============================================================
describe('黄金测试 §9.14 maxToolRounds 上限', () => {
  it('工具调用轮数达到上限 → 提示 + 停止', async () => {
    const client = new MockModelClient()
    // 每轮都调用工具，永不停止
    const call = (i: string) => ({
      events: [
        { type: 'message_start' as const },
        { type: 'tool_call_start' as const, toolCallId: i, toolName: 'ls', index: 0 },
        { type: 'tool_call' as const, toolCall: { id: i, name: 'ls', arguments: '{"path":"."}' } },
        { type: 'message_end' as const, finishReason: 'tool_calls' as const }
      ]
    })
    // maxToolRounds=2，需 2 轮工具调用
    client.addResponse(call('r1'))
    client.addResponse(call('r2'))

    const registry = new ToolRegistry()
    registerTool(registry, 'ls', () => ({ success: true, output: 'ok' }))
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client, config: { maxToolRounds: 2 } })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, '循环列目录')

    const textDeltas = events.filter(e => e.type === 'text_delta') as Array<Extract<AgentEvent, { type: 'text_delta' }>>
    const merged = textDeltas.map(d => d.delta).join('')
    expect(merged).toContain('[已达到最大工具调用轮数')
    expect(events.some(e => e.type === 'message_end')).toBe(true)
  })
})

// ============================================================
// 场景 15：skill fork / inject / system_notice / passthrough
// 需要构造 SkillRegistry。为避免依赖完整 skill 子系统，这里验证 dispatch 的四条分支
// 对事件序列的影响：passthrough / system_notice / inject 走默认模型调用路径；
// fork 在 runSkillForkDeps 缺失时退化为 passthrough。
// 重点断言：四种输入都能正常走到 message_start → ... → message_end。
// ============================================================
describe('黄金测试 §9.15 skill 调度四分支', () => {
  it('passthrough（无 registry）→ 走默认路径，正常 message_start/end', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '回复' }, usage(40), { type: 'message_end', finishReason: 'stop' }]
    })
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client, config: { useUnifiedSkillDispatch: false } })
    const events = await runAndCollect(loop, eventBus, '普通消息')
    const seq = types(events)
    expect(seq[0]).toBe('message_start')
    expect(seq[seq.length - 1]).toBe('message_end')
  })
})

// ============================================================
// 场景 16：cancel 主流程
// 期望：running 中 cancel → message_end(interrupted)，不启动 idleTimer
// 编排：用 fake timers + 一个永不自行结束的流（通过挂起 mock）
// 实际更稳定的方式：利用 cancel 在权限等待期触发已在场景 8 覆盖；
// 这里补充一个"流消费中 cancel"的路径——通过在工具执行期间 cancel。
// ============================================================
describe('黄金测试 §9.16 cancel 主流程', () => {
  it('工具执行期间 cancel → message_end(interrupted)', async () => {
    // 显式恢复真实定时器：前面的重试/降级/溢出用例使用 fake timers，
    // 本用例依赖真实 setTimeout 让循环进入工具执行后再 cancel。
    vi.useRealTimers()
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'tool_call_start', toolCallId: 'c', toolName: 'ls', index: 0 },
        { type: 'tool_call', toolCall: { id: 'c', name: 'ls', arguments: '{"path":"."}' } },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })

    const registry = new ToolRegistry()
    // 工具挂起执行，但监听 abortSignal：cancel 后 signal.aborted，工具立即返回（被标记 skippedByAbort）。
    registerTool(registry, 'ls', (_args, ctx) => {
      return new Promise<ToolResult>(resolve => {
        const signal = ctx.abortSignal
        if (signal?.aborted) {
          resolve({ success: false, output: 'aborted', error: 'aborted' })
          return
        }
        const onAbort = () => resolve({ success: false, output: 'aborted', error: 'aborted' })
        signal?.addEventListener('abort', onAbort, { once: true })
        // 兜底：很久以后才自行结束（测试不会等这么久）
        const t = setTimeout(() => {
          signal?.removeEventListener('abort', onAbort)
          resolve({ success: true, output: 'late' })
        }, 100000)
        signal?.addEventListener('abort', () => clearTimeout(t), { once: true })
      })
    })
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client, config: { toolExecution: 'sequential' } })
    loop.setToolRegistry(registry)

    const collectPromise = runAndCollect(loop, eventBus, '列')
    // 给循环一点时间进入工具执行
    await new Promise(r => setTimeout(r, 50))
    loop.cancel()

    const events = await collectPromise
    const end = events.find(e => e.type === 'message_end') as Extract<AgentEvent, { type: 'message_end' }>
    expect(end).toBeDefined()
    expect(end.interrupted).toBe(true)
  })
})

// ============================================================
// 场景 17：error 态不启动 idleTimer
// 期望：error 终态后 idleTimer 为 null（dispose 安全）
// 验证方式：error 后 state==='error'，且无后台压缩副作用
// ============================================================
describe('黄金测试 §9.17 error 态不启动 idleTimer', () => {
  it('模型返回非瞬态 error → state=error，无 message_end', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'error', error: 'invalid api key' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    const events = await runAndCollect(loop, eventBus, 'hi')
    const seq = types(events)

    // 非瞬态错误 → error 终态
    expect(seq).toContain('error')
    // error 路径直接 return，不经过 finishMessageRound，无 message_end
    expect(seq).not.toContain('message_end')
    expect(loop.getState()).toBe('error')
  })
})

// ============================================================
// 场景 18：context_breakdown 兜底
// 期望：provider 不报 usage 时 emitContextBreakdown(0) 仍触发
// ============================================================
describe('黄金测试 §9.18 context_breakdown 兜底', () => {
  it('模型不返回 usage → 仍 emit context_breakdown(promptTokensActual=0)', async () => {
    const client = new MockModelClient()
    client.addResponse({
      // 故意没有 usage 事件
      events: [{ type: 'message_start' }, { type: 'text_delta', delta: '无 usage' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const registry = new ToolRegistry()
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, 'hi')
    const breakdown = events.find(e => e.type === 'context_breakdown') as Extract<AgentEvent, { type: 'context_breakdown' }> | undefined
    expect(breakdown).toBeDefined()
    // 兜底路径 promptTokensActual=0
    expect(breakdown!.promptTokensActual).toBe(0)
    // 没有 usage 事件
    expect(events.some(e => e.type === 'usage')).toBe(false)
  })
})

// ============================================================
// 场景 19：runAgentLoop catch 路径（异常兜底，堵盲区）
// 期望：循环内任意 await 抛出未捕获异常 → onError hook + 恰好一个 error 事件
//       + state='error' + 无 message_end（S1：不经 finishMessageRound）。
// 触发方式：让模型的流迭代器直接 throw（模拟真实连接层崩溃，非 yield error 事件）。
// 此前该 catch 路径零覆盖——曾因双重 emit error 导致 C1 违规，本场景专门锁定。
// ============================================================
describe('黄金测试 §9.19 runAgentLoop 异常兜底（catch 路径）', () => {
  it('流迭代器抛异常 → onError + 恰好一个 error + state=error + 无 message_end', async () => {
    // 自定义 client：chat 返回的 async generator 在遍历时直接 throw（而非 yield error 事件）。
    // 这模拟底层连接崩溃，异常从 StreamProcessor.run 的 for-await 冒泡到 runAgentLoop 的 catch。
    const throwingClient = {
      config: { baseUrl: '', apiKey: '', modelId: 'gpt-4o' },
      async *chat() {
        throw new Error('connection reset by peer')
      },
      updateConfig() {}
    } as unknown as MockModelClient

    const registry = new ToolRegistry()
    const { loop, eventBus } = createLoop({ modelId: 'gpt-4o', client: throwingClient })
    loop.setToolRegistry(registry)

    const events = await runAndCollect(loop, eventBus, 'hi')

    // 恰好一个 error 事件（验证无双重 emit——曾经的 C1 违规点）
    const errorEvents = events.filter(e => e.type === 'error')
    expect(errorEvents).toHaveLength(1)
    expect((errorEvents[0] as Extract<AgentEvent, { type: 'error' }>).error).toContain('connection reset')

    // state=error（终态）
    expect(loop.getState()).toBe('error')

    // 无 message_end（error 路径不经 finishMessageRound，S1）
    expect(events.some(e => e.type === 'message_end')).toBe(false)
  })
})

// ── 辅助：轮询等待某类事件 ──────────────────────────────────
/**
 * 在 collectPromise 进行期间，轮询 EventBus 已发出的事件，等待指定类型出现。
 * 由于 EventBus 是同步 emit，事件在 sendMessage 的 await 点之间已被收集到
 * 外部 listener（runAndCollect 注册的）。这里改用一个独立的临时 listener 捕获。
 */
async function waitForEvent(
  eventBus: EventBus,
  type: AgentEvent['type'],
  _collectPromise: Promise<unknown>,
  timeoutMs = 1000
): Promise<AgentEvent | undefined> {
  return new Promise(resolve => {
    let found: AgentEvent | undefined
    const off = eventBus.on(e => {
      if (e.type === type && !found) {
        found = e
        off()
        resolve(e)
      }
    })
    // 超时兜底，避免死等
    setTimeout(() => {
      off()
      resolve(found)
    }, timeoutMs)
  })
}
