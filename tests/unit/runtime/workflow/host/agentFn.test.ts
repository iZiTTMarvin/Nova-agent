import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  BASE_TOOLS,
  READONLY_TOOLS,
  createAgentFn,
  resolveAgentTools
} from '../../../../../src/runtime/workflow/host/agentFn'
import { runJournalPath, runLogPath } from '../../../../../src/runtime/workflow/state/paths'
import { addEmptyResponse, addTextResponse, makeHostHarness } from './hostTestContext'
import type { MockModelClient } from '../../../../../src/test-support/builders/MockModelClient'
import type { ToolExecutor, ToolResult } from '../../../../../src/runtime/tools/types'

function fakeTool(name: string): ToolExecutor {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'ok' }
    }
  }
}

const ALL_TOOLS = [...BASE_TOOLS, ...READONLY_TOOLS, 'askQuestion'].map(fakeTool)

/** 预设一轮「输出一段文本后调用工具」的响应；AgentLoop 执行工具后会消费下一条响应 */
function addToolCallResponse(
  client: MockModelClient,
  text: string,
  toolName: string,
  args: Record<string, unknown>
): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      {
        type: 'tool_call',
        toolCall: { id: 'tc-1', name: toolName, arguments: JSON.stringify(args) }
      },
      { type: 'message_end', finishReason: 'tool_calls' }
    ]
  })
}

describe('host agentFn 工具清单', () => {
  it('Auto 关 + 交互式 + shared 隔离时才携带 askQuestion', () => {
    const tools = resolveAgentTools({ isolation: 'shared', autoMode: false, interactive: true })
    expect(tools).toContain('askQuestion')
    expect(tools.filter((t) => t === 'askQuestion')).toHaveLength(1)
  })

  it('Auto 开时剔除 askQuestion', () => {
    const tools = resolveAgentTools({ isolation: 'shared', autoMode: true, interactive: true })
    expect(tools).not.toContain('askQuestion')
  })

  it('非交互调用即使显式传入 askQuestion 也被剔除', () => {
    const tools = resolveAgentTools({
      isolation: 'shared',
      autoMode: false,
      tools: ['read', 'askQuestion']
    })
    expect(tools).toEqual(['read'])
  })

  it('worktree / readonly 隔离一律不给提问工具（实现阶段不得阻塞等用户）', () => {
    for (const isolation of ['worktree', 'readonly'] as const) {
      const tools = resolveAgentTools({ isolation, autoMode: false, interactive: true })
      expect(tools).not.toContain('askQuestion')
    }
  })

  it('readonly 隔离默认只给只读工具', () => {
    const tools = resolveAgentTools({ isolation: 'readonly', autoMode: false })
    expect(tools).toEqual([...READONLY_TOOLS])
    expect(tools).not.toContain('write')
    expect(tools).not.toContain('bash')
  })

  it('shared 隔离默认给实现工具集', () => {
    expect(resolveAgentTools({ isolation: 'shared', autoMode: false })).toEqual([...BASE_TOOLS])
  })
})

describe('host agentFn never-throw 与 journal', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-agent-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('成功返回文本并写入 journal', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, 'done-1')
    const agent = createAgentFn(h.ctx)

    await expect(agent('工作 A')).resolves.toBe('done-1')

    const journal = readFileSync(runJournalPath(tmp, h.ctx.runId), 'utf-8')
    expect(journal).toContain('done-1')
  })

  it('相同调用第二次命中 journal 缓存，不再 spawn', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, 'cached')
    const agent = createAgentFn(h.ctx)

    await agent('同一 prompt')
    // 第二次没有可用响应；若真的 spawn 会拿不到文本而返回 null
    const second = await agent('同一 prompt')
    expect(second).toBeNull()

    // occurrence 计数使同一 prompt 的第 1 次结果可被 resume 复用
    h.ctx.occ.clear()
    const replay = await agent('同一 prompt')
    expect(replay).toBe('cached')
  })

  it('模型无产出返回 null 且不写 journal', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addEmptyResponse(h.client)
    const agent = createAgentFn(h.ctx)

    await expect(agent('空产出')).resolves.toBeNull()
    expect(existsSync(runJournalPath(tmp, h.ctx.runId))).toBe(false)
    expect(h.events.some((e) => e.type === 'workflow_agent_failed')).toBe(true)
  })

  it('schema 调用拿到非 JSON 文本时先修复重试，仍失败才返回 null，不抛错', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, '这不是 JSON')
    addTextResponse(h.client, '依然不是 JSON')
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('要结构化结果', { schema: { type: 'object' } })
    ).resolves.toBeNull()
    // 首次解析失败 + 一次无工具修复重试，共两次模型调用
    expect(h.client.getCalls()).toHaveLength(2)
  })

  it('schema 调用能解析出对象', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, '```json\n{"ok":true}\n```')
    const agent = createAgentFn(h.ctx)

    await expect(agent('结构化', { schema: { type: 'object' } })).resolves.toEqual({ ok: true })
  })

  it('scope 关闭后返回 null，不抛错', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, 'never-used')
    const agent = createAgentFn(h.ctx)
    await h.scope.close('cancelled')

    await expect(agent('取消后调用')).resolves.toBeNull()
  })

  it('交互式调用时模型确实看到 askQuestion，Auto 开时看不到', async () => {
    const interactive = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(interactive.client, 'ok')
    await createAgentFn(interactive.ctx)('问问用户', { interactive: true })
    const interactiveTools = interactive.client.getCalls()[0]?.tools?.map((t) => t.name) ?? []
    expect(interactiveTools).toContain('askQuestion')

    const auto = makeHostHarness(tmp, { autoMode: true, tools: ALL_TOOLS })
    addTextResponse(auto.client, 'ok')
    await createAgentFn(auto.ctx)('问问用户', { interactive: true })
    const autoTools = auto.client.getCalls()[0]?.tools?.map((t) => t.name) ?? []
    expect(autoTools).not.toContain('askQuestion')
  })
})

describe('host agentFn 结构化输出鲁棒性', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-agent-schema-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('解析失败时自动做一次无工具修复重试，重试成功即返回对象', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, '这不是 JSON，但包含分析结论')
    addTextResponse(h.client, '```json\n{"ok":true}\n```')
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('要结构化结果', { schema: { type: 'object', required: ['ok'] } })
    ).resolves.toEqual({ ok: true })

    const calls = h.client.getCalls()
    expect(calls).toHaveLength(2)
    // 修复重试不携带任何工具：纯文本整理，避免再次跑题
    expect(calls[1]?.tools ?? []).toHaveLength(0)
    // 修复重试的 prompt 带上了首轮原文
    const repairUser = calls[1]?.messages.find((m) => m.role === 'user')
    expect(typeof repairUser?.content === 'string' ? repairUser.content : '').toContain(
      '这不是 JSON，但包含分析结论'
    )
  })

  it('schema 候选必须覆盖 required 字段：散文里的示例对象不被误选', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(
      h.client,
      '举个例子 ```json\n{"example":1}\n```，真正的结论是 ```json\n{"ok":"right"}\n```'
    )
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('结构化', { schema: { type: 'object', required: ['ok'] } })
    ).resolves.toEqual({ ok: 'right' })
  })

  it('最后一条 assistant 消息优先：中间轮次的同名字段噪声不污染结果', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    // 第一轮：思考散文里带一个同名 required 字段的噪声 JSON，然后调用工具
    addToolCallResponse(h.client, '```json\n{"ok":"wrong"}\n```', 'read', { path: 'a.ts' })
    // 第二轮（最终消息）：裸文本给出真正的 JSON
    addTextResponse(h.client, '{"ok":"right"}')
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('结构化', { schema: { type: 'object', required: ['ok'] } })
    ).resolves.toEqual({ ok: 'right' })
  })

  it('修复重试也失败时：workflow_agent_failed 带具体原因，且落 run 日志', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, '这不是 JSON')
    addTextResponse(h.client, '依然无法解析')
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('结构化', { schema: { type: 'object', required: ['ok'] } })
    ).resolves.toBeNull()

    const failed = h.events.filter((e) => e.type === 'workflow_agent_failed')
    expect(failed.length).toBeGreaterThan(0)
    expect(failed[failed.length - 1]).toMatchObject({ reason: 'schema-parse-failed' })

    const logFile = runLogPath(tmp, h.ctx.runId)
    expect(existsSync(logFile)).toBe(true)
    const content = readFileSync(logFile, 'utf-8')
    expect(content).toContain('schema-parse-failed')
    expect(content).toContain('修复重试')
  })

  it('空产出不上报修复重试，直接以 empty-output 诊断落盘', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addEmptyResponse(h.client)
    const agent = createAgentFn(h.ctx)

    await expect(agent('空产出')).resolves.toBeNull()
    const failed = h.events.filter((e) => e.type === 'workflow_agent_failed')
    expect(failed[failed.length - 1]).toMatchObject({ reason: 'empty-output' })
    expect(h.client.getCalls()).toHaveLength(1)
    expect(readFileSync(runLogPath(tmp, h.ctx.runId), 'utf-8')).toContain('empty-output')
  })
})

describe('host agentFn 活动可观测性', () => {
  let tmp: string

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-host-agent-activity-'))
  })

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true })
  })

  it('子代理工具调用以 workflow_log 活动行上行，并落 run 日志', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addToolCallResponse(h.client, '', 'read', { path: 'src/shared/ipc/types.ts' })
    addTextResponse(h.client, 'done')
    const agent = createAgentFn(h.ctx)

    await expect(agent('干活', { label: 'compose-brainstorm' })).resolves.toBe('done')

    const logs = h.events.filter((e) => e.type === 'workflow_log')
    expect(
      logs.some(
        (e) =>
          e.type === 'workflow_log' &&
          e.message.includes('[compose-brainstorm]') &&
          e.message.includes('read') &&
          e.message.includes('src/shared/ipc/types.ts')
      )
    ).toBe(true)

    const content = readFileSync(runLogPath(tmp, h.ctx.runId), 'utf-8')
    expect(content).toContain('[compose-brainstorm] 调用工具 read：src/shared/ipc/types.ts')
  })

  it('相邻重复活动行不刷屏', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addToolCallResponse(h.client, '', 'read', { path: 'a.ts' })
    addToolCallResponse(h.client, '', 'read', { path: 'a.ts' })
    addTextResponse(h.client, 'done')
    const agent = createAgentFn(h.ctx)

    await agent('干活', { label: 'l' })
    const lines = h.events.filter(
      (e) => e.type === 'workflow_log' && e.message.includes('a.ts')
    )
    expect(lines).toHaveLength(1)
  })
})
