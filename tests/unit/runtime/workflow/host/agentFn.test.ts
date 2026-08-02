import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpawnSubagentPort } from '../../../../../src/runtime/subagents'
import {
  BASE_TOOLS,
  READONLY_TOOLS,
  createAgentFn,
  resolveAgentTools
} from '../../../../../src/runtime/workflow/host/agentFn'
import { runJournalPath, runLogPath } from '../../../../../src/runtime/workflow/state/paths'
import { makeHostHarness } from './hostTestContext'

function completed(summary: string, index = 1) {
  return {
    childSessionId: `child-session-${index}`,
    childRunId: `child-run-${index}`,
    status: 'completed' as const,
    summary,
    artifactIds: [],
    startedAt: 1,
    completedAt: 2
  }
}

describe('host agentFn 工具清单', () => {
  it('只有非 Auto 的 shared interactive 调用携带 askQuestion', () => {
    expect(resolveAgentTools({ isolation: 'shared', autoMode: false, interactive: true }))
      .toEqual([...BASE_TOOLS, 'askQuestion'])
    expect(resolveAgentTools({ isolation: 'shared', autoMode: true, interactive: true }))
      .toEqual([...BASE_TOOLS])
    expect(resolveAgentTools({ isolation: 'readonly', autoMode: false, interactive: true }))
      .toEqual([...READONLY_TOOLS])
  })

  it('显式工具清单去重并在非交互调用剔除 askQuestion', () => {
    expect(resolveAgentTools({
      isolation: 'shared',
      autoMode: false,
      tools: ['read', 'askQuestion', 'read']
    })).toEqual(['read'])
  })
})

describe('host agentFn 统一 SpawnSubagentPort', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nova-workflow-agent-port-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('构造完整 Workflow origin、动态受限 profile 与明确等待策略', async () => {
    const spawn = vi.fn(async () => completed('done'))
    const port: SpawnSubagentPort = { spawn }
    const h = makeHostHarness(root, { spawnSubagentPort: port })

    await expect(createAgentFn(h.ctx)('研究边界', {
      phase: 'research',
      taskId: 'question-a',
      batchId: 'research-0',
      isolation: 'readonly'
    })).resolves.toBe('done')

    expect(spawn).toHaveBeenCalledTimes(1)
    const [command, context] = spawn.mock.calls[0]!
    expect(command).toEqual(expect.objectContaining({
      parentSessionId: 'sess-1',
      parentRunId: 'parent-run',
      workingDirectory: root,
      isolation: 'readonly',
      invocation: {
        kind: 'workflow',
        workflowRunId: 'test-run',
        phase: 'research',
        parentMessageId: 'parent-message',
        parentToolCallId: 'parent-tool',
        taskId: 'question-a',
        batchId: 'research-0',
        occurrence: 0
      }
    }))
    expect(context).toEqual(expect.objectContaining({
      waitForPermit: true,
      abortSignal: h.ctx.abortSignal,
      profile: expect.objectContaining({
        name: command.profileId,
        allowedTools: [...READONLY_TOOLS]
      })
    }))
  })

  it('成功 journal 同时保存 child refs 与结果，resume 命中后不重复 spawn', async () => {
    const spawn = vi.fn(async () => completed('cached'))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })
    const agent = createAgentFn(h.ctx)

    await expect(agent('同一任务', { taskId: 'stable-task' })).resolves.toBe('cached')
    h.ctx.occ.clear()
    await expect(agent('同一任务', { taskId: 'stable-task' })).resolves.toBe('cached')

    expect(spawn).toHaveBeenCalledTimes(1)
    const events = readFileSync(runJournalPath(root, h.ctx.runId), 'utf-8')
      .trim().split('\n').map((line) => JSON.parse(line))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(expect.objectContaining({
      t: 'agent',
      result: 'cached',
      childSessionId: 'child-session-1',
      childRunId: 'child-run-1'
    }))
  })

  it('相同内容的不同 occurrence 生成不同 stable child identity', async () => {
    const spawn = vi.fn(async (_command, _context) => completed('ok', spawn.mock.calls.length))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })
    const agent = createAgentFn(h.ctx)

    await agent('重复任务', { taskId: 'repeat' })
    await agent('重复任务', { taskId: 'repeat' })

    const commands = spawn.mock.calls.map(([command]) => command)
    expect(commands.map((command) => command.invocation)).toEqual([
      expect.objectContaining({ occurrence: 0 }),
      expect.objectContaining({ occurrence: 1 })
    ])
  })

  it('批次 item 以 taskId 隔离 journal，不受相同 prompt 干扰', async () => {
    const spawn = vi.fn(async (_command, _context) => completed('ok', spawn.mock.calls.length))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })
    const agent = createAgentFn(h.ctx)

    await agent('相同内容', { taskId: 'item-a', batchId: 'batch-1' })
    await agent('相同内容', { taskId: 'item-b', batchId: 'batch-1' })

    expect(spawn).toHaveBeenCalledTimes(2)
    expect(spawn.mock.calls.map(([command]) => command.invocation)).toEqual([
      expect.objectContaining({ taskId: 'item-a', batchId: 'batch-1', occurrence: 0 }),
      expect.objectContaining({ taskId: 'item-b', batchId: 'batch-1', occurrence: 0 })
    ])
  })

  it('同一 taskId 的多次不同输入递增 occurrence，避免 stable spawnKey 冲突', async () => {
    const spawn = vi.fn(async (_command, _context) => completed('ok', spawn.mock.calls.length))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })
    const agent = createAgentFn(h.ctx)

    await agent('第一次输入', { taskId: 'same-item' })
    await agent('第二次输入', { taskId: 'same-item' })

    expect(spawn.mock.calls.map(([command]) => command.invocation)).toEqual([
      expect.objectContaining({ taskId: 'same-item', occurrence: 0 }),
      expect.objectContaining({ taskId: 'same-item', occurrence: 1 })
    ])
  })

  it('schema 只解释统一 child 结果，不再创建第二次 repair spawn', async () => {
    const spawn = vi.fn(async () => completed('分析后得到 ```json\n{"ok":true}\n```'))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })

    await expect(createAgentFn(h.ctx)('结构化', {
      schema: { type: 'object', required: ['ok'] }
    })).resolves.toEqual({ ok: true })

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]![0].resultSchema).toEqual({
      type: 'object',
      required: ['ok']
    })
  })

  it('schema 解析失败返回 null、只记非 Agent 诊断且不写成功 journal', async () => {
    const spawn = vi.fn(async () => completed('not-json'))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })

    await expect(createAgentFn(h.ctx)('结构化', {
      label: 'plan',
      schema: { type: 'object', required: ['ok'] }
    })).resolves.toBeNull()

    expect(spawn).toHaveBeenCalledTimes(1)
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'workflow_agent_failed',
      reason: 'schema-parse-failed'
    }))
    expect(readFileSync(runLogPath(root, h.ctx.runId), 'utf-8'))
      .toContain('schema-parse-failed')
    expect(existsSync(runJournalPath(root, h.ctx.runId))).toBe(false)
  })

  it('scope 关闭后不调用端口且按取消返回 null', async () => {
    const spawn = vi.fn(async () => completed('should-not-run'))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })
    await h.scope.close('cancelled')

    await expect(createAgentFn(h.ctx)('取消后')).resolves.toBeNull()
    expect(spawn).not.toHaveBeenCalled()
  })

  it('child 失败保持 never-throw，且不把工具活动伪装为 workflow_log', async () => {
    const spawn = vi.fn(async () => ({
      ...completed(''),
      status: 'failed' as const,
      failure: { code: 'model' as const, message: 'provider failed' }
    }))
    const h = makeHostHarness(root, { spawnSubagentPort: { spawn } })

    await expect(createAgentFn(h.ctx)('失败任务')).resolves.toBeNull()
    expect(h.events.filter((event) => event.type === 'workflow_log')).toHaveLength(1)
    expect(h.events.find((event) => event.type === 'workflow_log'))
      .toEqual(expect.objectContaining({ message: expect.stringContaining('model') }))
  })
})
