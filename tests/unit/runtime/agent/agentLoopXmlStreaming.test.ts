/**
 * AgentLoop XML 流式工具调用集成测试
 *
 * 验证目标：XML 方言模型（DeepSeek/GLM/Kimi/Qwen/MiniMax）把工具调用以
 * <invoke><parameter> 写在正文里时，AgentLoop 在流式期间实时产出
 * tool_call_start → tool_call_delta → tool_call 事件序列，
 * 让前端文件卡片逐字流式渲染（复用 argumentsRaw 通道）。
 */
import { describe, it, expect } from 'vitest'
import { AgentLoop } from '../../../../src/runtime/agent/AgentLoop'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { ModelClientPool } from '../../../../src/runtime/model/ModelClientPool'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolResult } from '../../../../src/runtime/tools/types'

/** 构造 AgentLoop，通过 modelId 控制 dialect（xml / native） */
function createLoop(opts: { modelId: string; client: MockModelClient }) {
  const { modelId, client } = opts
  const pool = new ModelClientPool({
    primary: client,
    primaryConfig: { baseUrl: '', apiKey: '', modelId }
  })
  const eventBus = new EventBus()
  const loop = new AgentLoop(pool, eventBus)

  // 注册 ls / write / read 三个工具，覆盖流式预览场景
  const registry = new ToolRegistry()
  registry.register({
    name: 'ls',
    description: '列出目录',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录路径' } }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `目录内容: ${args.path ?? '.'}` }
    }
  })
  registry.register({
    name: 'write',
    description: '写文件',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '文件内容' }
      },
      required: ['path', 'content']
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `已写入 ${args.path}` }
    }
  })
  registry.register({
    name: 'read',
    description: '读文件',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' } }
    },
    async execute(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult> {
      return { success: true, output: `读取 ${args.path}` }
    }
  })
  loop.setToolRegistry(registry)

  return { loop, eventBus }
}

/** 收集 sendMessage 过程中的所有事件 */
async function runAndCollect(loop: AgentLoop, eventBus: EventBus, userText: string) {
  const events: any[] = []
  eventBus.on((e) => events.push(e))
  await loop.sendMessage(userText)
  return events
}

describe('AgentLoop XML 流式工具调用', () => {
  // ==================== 核心流式链路 ====================

  it('XML 方言：单个工具调用产出 tool_call_start → tool_call_delta → tool_call 序列', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '我先看看目录。\n' },
        {
          type: 'text_delta',
          delta: '<invoke name="ls"><parameter name="path">.</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client })
    const events = await runAndCollect(loop, eventBus, '列出文件')

    const toolCallStarts = events.filter(e => e.type === 'tool_call_start')
    const toolCallDeltas = events.filter(e => e.type === 'tool_call_delta')
    const toolCalls = events.filter(e => e.type === 'tool_call')

    // 应有且仅有 1 个工具调用的完整事件链
    expect(toolCallStarts).toHaveLength(1)
    expect(toolCallDeltas.length).toBeGreaterThan(0)
    expect(toolCalls).toHaveLength(1)

    // toolCallId 跨 start / delta / call 一致
    const startId = toolCallStarts[0].toolCallId
    expect(toolCallDeltas.every((d: any) => d.toolCallId === startId)).toBe(true)
    expect(toolCalls[0].toolCallId).toBe(startId)

    // 工具名正确
    expect(toolCallStarts[0].toolName).toBe('ls')
    expect(toolCalls[0].toolName).toBe('ls')
  })

  it('argumentsDelta 拼接成合法 JSON，且能正确提取参数', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta:
            '<invoke name="write">' +
            '<parameter name="path">a.ts</parameter>' +
            '<parameter name="content">hello\nworld</parameter>' +
            '</invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'glm-4', client })
    const events = await runAndCollect(loop, eventBus, '写文件')

    const toolCallDeltas = events.filter(e => e.type === 'tool_call_delta')
    const toolCall = events.find(e => e.type === 'tool_call')

    // 拼接所有 argumentsDelta 得到完整 JSON
    const fullArgsJson = toolCallDeltas
      .map((d: any) => d.argumentsDelta)
      .join('')

    // 应是合法 JSON
    const parsed = JSON.parse(fullArgsJson)
    expect(parsed.path).toBe('a.ts')
    expect(parsed.content).toBe('hello\nworld')

    // tool_call 事件携带完整 args
    expect(toolCall.args).toEqual({ path: 'a.ts', content: 'hello\nworld' })
  })

  it('参数值跨多 chunk 到达时，content 逐块累积', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '<invoke name="write"><parameter name="path">a.ts</parameter>'
        },
        { type: 'text_delta', delta: '<parameter name="content">第一行\n' },
        { type: 'text_delta', delta: '第二行\n' },
        { type: 'text_delta', delta: '第三行</parameter></invoke>' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'qwen-max', client })
    const events = await runAndCollect(loop, eventBus, '写文件')

    const toolCallDeltas = events.filter(e => e.type === 'tool_call_delta')
    // content 应该分多块到达（至少 3 块：第一行/第二行/第三行）
    expect(toolCallDeltas.length).toBeGreaterThanOrEqual(3)

    const fullArgsJson = toolCallDeltas.map((d: any) => d.argumentsDelta).join('')
    const parsed = JSON.parse(fullArgsJson)
    expect(parsed.content).toBe('第一行\n第二行\n第三行')
  })

  // ==================== 正文剥离 ====================

  it('text_delta 不含 <invoke>/<parameter> 原始标签', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta:
            '开始写文件。' +
            '<invoke name="write"><parameter name="path">a.ts</parameter></invoke>' +
            '写完了。'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'kimi', client })
    const events = await runAndCollect(loop, eventBus, '写文件')

    const textDeltas = events.filter(e => e.type === 'text_delta')
    const fullText = textDeltas.map((e: any) => e.delta).join('')

    // 正文不应包含任何 XML 标签
    expect(fullText).not.toContain('<invoke')
    expect(fullText).not.toContain('<parameter')
    expect(fullText).not.toContain('</invoke>')
    expect(fullText).not.toContain('</parameter>')
    // 应保留正文
    expect(fullText).toContain('开始写文件。')
  })

  it('assistantContent（上下文中的 assistant 消息）为剥离后的纯正文', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta:
            '好的，我来看看。' +
            '<invoke name="ls"><parameter name="path">.</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'minimax-m3', client })
    await runAndCollect(loop, eventBus, '列出文件')

    const context = loop.getContext()
    const assistantWithTool = context.find(
      m => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
    )

    // assistant 消息内容应只含纯正文，不含任何 XML 标签
    const content = assistantWithTool?.content as string
    expect(content).not.toContain('<invoke')
    expect(content).not.toContain('<parameter')
    expect(content).toContain('好的，我来看看。')
    // 应带 toolCalls
    expect(assistantWithTool?.toolCalls).toHaveLength(1)
    expect(assistantWithTool?.toolCalls?.[0].name).toBe('ls')
    // toolCalls 的 arguments 应是合法 JSON
    const args = JSON.parse(assistantWithTool!.toolCalls![0].arguments)
    expect(args).toEqual({ path: '.' })
  })

  // ==================== 多工具调用 + 流式执行 ====================

  it('多个 XML 工具调用流式识别，且工具被执行', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta:
            '先看目录再读文件。\n' +
            '<invoke name="ls"><parameter name="path">.</parameter></invoke>' +
            '<invoke name="read"><parameter name="path">README.md</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-v4', client })
    const events = await runAndCollect(loop, eventBus, '查看项目')

    const toolCallStarts = events.filter(e => e.type === 'tool_call_start')
    const toolCalls = events.filter(e => e.type === 'tool_call')
    const toolResults = events.filter(e => e.type === 'tool_result')

    expect(toolCallStarts).toHaveLength(2)
    expect(toolCalls).toHaveLength(2)
    expect(toolCallStarts[0].toolName).toBe('ls')
    expect(toolCallStarts[1].toolName).toBe('read')

    // 两个工具调用 id 应不同
    expect(toolCallStarts[0].toolCallId).not.toBe(toolCallStarts[1].toolCallId)

    // 工具应被执行（两个 tool_result）
    expect(toolResults.length).toBeGreaterThanOrEqual(2)

    // 模型被调用两次（第一次返回工具调用，第二次收到结果后结束）
    expect(client.getCalls()).toHaveLength(2)
  })

  // ==================== finishReason 正确性 ====================

  it('XML 方言检测到工具调用时 finishReason 被正确设为 tool_calls', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '<invoke name="ls"><parameter name="path">.</parameter></invoke>'
        },
        // 即使 message_end 报 stop，scanner 已检测到工具调用应覆盖
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client })
    await runAndCollect(loop, eventBus, '列出文件')

    // 工具被实际执行（驱动了第二轮模型调用），说明 finishReason='tool_calls'
    expect(client.getCalls()).toHaveLength(2)
  })

  it('XML 方言无工具调用时不触发工具执行循环', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '这是一个普通回答，没有工具调用。' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client })
    const events = await runAndCollect(loop, eventBus, '你好')

    expect(events.some(e => e.type === 'tool_call_start')).toBe(false)
    expect(events.some(e => e.type === 'tool_call')).toBe(false)
    // 只调用一次模型
    expect(client.getCalls()).toHaveLength(1)
  })

  // ==================== 与 native 路径行为对比 ====================

  it('XML 流式路径与 native 路径终态 tool_call 形态一致、工具都被执行', async () => {
    // native：模型直接产 tool_call 终态事件（MockModelClient 不模拟 SSE start/delta 逐块）
    const nativeClient = new MockModelClient()
    nativeClient.addResponse({
      events: [
        { type: 'message_start' },
        { type: 'text_delta', delta: '查看目录。' },
        {
          type: 'tool_call',
          toolCall: { id: 'call_1', name: 'ls', arguments: '{"path":"."}' }
        },
        { type: 'message_end', finishReason: 'tool_calls' }
      ]
    })
    nativeClient.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop: nativeLoop, eventBus: nativeBus } = createLoop({
      modelId: 'gpt-4o',
      client: nativeClient
    })
    const nativeEvents = await runAndCollect(nativeLoop, nativeBus, '列出文件')

    // xml：模型把调用写在正文里，scanner 流式识别
    const xmlClient = new MockModelClient()
    xmlClient.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta:
            '查看目录。<invoke name="ls"><parameter name="path">.</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    xmlClient.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop: xmlLoop, eventBus: xmlBus } = createLoop({
      modelId: 'deepseek-chat',
      client: xmlClient
    })
    const xmlEvents = await runAndCollect(xmlLoop, xmlBus, '列出文件')

    // 两条路径都应产出终态 tool_call 事件
    const nativeCalls = nativeEvents.filter(e => e.type === 'tool_call')
    const xmlCalls = xmlEvents.filter(e => e.type === 'tool_call')
    expect(nativeCalls).toHaveLength(1)
    expect(xmlCalls).toHaveLength(1)

    // 工具名一致
    expect(nativeCalls[0].toolName).toBe('ls')
    expect(xmlCalls[0].toolName).toBe('ls')

    // tool_call 事件的 args 形态一致（都是对象）
    expect(nativeCalls[0].args).toEqual({ path: '.' })
    expect(xmlCalls[0].args).toEqual({ path: '.' })

    // 上下文中的 assistant.toolCalls 形态一致（name + 合法 JSON arguments）
    const nativeCtx = nativeLoop.getContext()
    const xmlCtx = xmlLoop.getContext()
    const nativeToolCalls = nativeCtx.find(
      m => m.role === 'assistant' && m.toolCalls?.length
    )?.toolCalls
    const xmlToolCalls = xmlCtx.find(
      m => m.role === 'assistant' && m.toolCalls?.length
    )?.toolCalls

    expect(nativeToolCalls).toHaveLength(1)
    expect(xmlToolCalls).toHaveLength(1)
    expect(nativeToolCalls![0].name).toBe(xmlToolCalls![0].name)
    expect(JSON.parse(nativeToolCalls![0].arguments)).toEqual({ path: '.' })
    expect(JSON.parse(xmlToolCalls![0].arguments)).toEqual({ path: '.' })

    // 都执行了工具并触发第二轮模型调用
    expect(nativeClient.getCalls()).toHaveLength(2)
    expect(xmlClient.getCalls()).toHaveLength(2)
  })

  // ==================== 兜底协同：scanner + 全量解析不重复 ====================

  it('scanner 识别的调用不会被兜底全量解析重复 emit', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '<invoke name="ls"><parameter name="path">.</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client })
    const events = await runAndCollect(loop, eventBus, '列出文件')

    // scanner 已识别，兜底不应重复 emit —— 只应有 1 个 tool_call_start / tool_call
    expect(events.filter(e => e.type === 'tool_call_start')).toHaveLength(1)
    expect(events.filter(e => e.type === 'tool_call')).toHaveLength(1)
  })

  // ==================== XML entity 在流式参数中正确还原 ====================

  it('XML entity 转义在流式参数中正确还原（&lt; &amp; &quot;）', async () => {
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta:
            '<invoke name="write">' +
            '<parameter name="path">a.ts</parameter>' +
            '<parameter name="content">if (a &lt; b &amp;&amp; c &gt; d) { return &quot;ok&quot;; }</parameter>' +
            '</invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client })
    const events = await runAndCollect(loop, eventBus, '写文件')

    const toolCallDeltas = events.filter(e => e.type === 'tool_call_delta')
    const fullArgsJson = toolCallDeltas.map((d: any) => d.argumentsDelta).join('')
    const parsed = JSON.parse(fullArgsJson)

    // entity 应被还原
    expect(parsed.content).toBe('if (a < b && c > d) { return "ok"; }')
  })

  // ==================== P0 守护：entity 跨 chunk 切分时执行数据正确 ====================

  it('entity 跨 chunk 切分时，工具执行依据（ChatToolCall.arguments）正确还原，不被流式累积的字面值污染', async () => {
    // 关键：把 &lt; 切在 chunk 边界（&l | t;），模拟真实 SSE token 边界切开 entity。
    // 流式 toolArgDelta 逐段 decode 不匹配，scanner 的 currentArgs 会累积成字面 &lt;，
    // 但 finalDecodeArgs 在 toolEnd 时最终还原成 <。
    // 风险点：若 ChatToolCall.arguments 用流式累积的 jsonBuffer（含字面 &lt;）而非
    // scanner 最终的权威 arguments，写文件内容会损坏。executeToolBatch 用的就是这个字段。
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta:
            '<invoke name="write">' +
            '<parameter name="path">a.ts</parameter>' +
            '<parameter name="content">if (a &l'
        },
        {
          type: 'text_delta',
          delta: 't; b) { return x; }</parameter></invoke>'
        },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client })
    const events = await runAndCollect(loop, eventBus, '写文件')

    // 1. tool_call 事件携带的 args（scanner 权威值）应正确
    const toolCall = events.find(e => e.type === 'tool_call')
    expect(toolCall.args).toEqual({
      path: 'a.ts',
      content: 'if (a < b) { return x; }'
    })

    // 2. ChatToolCall.arguments（executeToolBatch 的执行依据）解析后必须正确
    //    —— 这是 P0 的核心：写入文件的内容不能含字面 &lt;
    const context = loop.getContext()
    const assistantWithTool = context.find(
      m => m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0
    )
    const execArgs = JSON.parse(assistantWithTool!.toolCalls![0].arguments)
    expect(execArgs).toEqual({
      path: 'a.ts',
      content: 'if (a < b) { return x; }'
    })
  })

  it('entity 跨 chunk 切分时，流式 toolArgDelta 拼接仍为合法 JSON（结构守护）', async () => {
    // 固化现状：流式增量在 entity 被切开时可能短暂含未解码字面（前端 finalize 时
    // 由 tool_call.args 覆盖，最终显示正确）。但无论中间状态如何，delta 拼接
    // 必须始终是结构合法的 JSON，否则前端 partialJsonArgs 会解析失败、文件卡片不流式。
    const client = new MockModelClient()
    client.addResponse({
      events: [
        { type: 'message_start' },
        {
          type: 'text_delta',
          delta: '<invoke name="write"><parameter name="content">a &l'
        },
        { type: 'text_delta', delta: 't; b</parameter></invoke>' },
        { type: 'message_end', finishReason: 'stop' }
      ]
    })
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })

    const { loop, eventBus } = createLoop({ modelId: 'deepseek-chat', client })
    const events = await runAndCollect(loop, eventBus, '写文件')

    const toolCallDeltas = events.filter(e => e.type === 'tool_call_delta')
    const fullArgsJson = toolCallDeltas.map((d: any) => d.argumentsDelta).join('')

    // 拼接必须是合法 JSON（JSON.parse 不抛错）
    expect(() => JSON.parse(fullArgsJson)).not.toThrow()
    const parsed = JSON.parse(fullArgsJson)
    // 结构正确（含 content key）
    expect(parsed).toHaveProperty('content')
  })
})
