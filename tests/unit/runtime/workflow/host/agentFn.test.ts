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
import { runJournalPath } from '../../../../../src/runtime/workflow/state/paths'
import { addEmptyResponse, addTextResponse, makeHostHarness } from './hostTestContext'
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

  it('schema 调用拿到非 JSON 文本时返回 null，不抛错', async () => {
    const h = makeHostHarness(tmp, { tools: ALL_TOOLS })
    addTextResponse(h.client, '这不是 JSON')
    const agent = createAgentFn(h.ctx)

    await expect(
      agent('要结构化结果', { schema: { type: 'object' } })
    ).resolves.toBeNull()
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
