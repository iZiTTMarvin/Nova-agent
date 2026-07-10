import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { appendFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventBus } from '../../../../src/runtime/agent/EventBus'
import { MockModelClient } from '../../../../src/test-support/builders/MockModelClient'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { createHostHooks, type HookContext } from '../../../../src/runtime/workflow/hooks'
import { makeRunSemaphore } from '../../../../src/runtime/workflow/semaphore'
import { TaskScope } from '../../../../src/runtime/workflow/TaskScope'
import {
  appendJournalSync,
  clearJournal,
  journalKeyBase,
  loadJournal,
  readScriptSha,
  scriptSha,
  writeScriptSha
} from '../../../../src/runtime/workflow/journal'
import { runJournalPath } from '../../../../src/runtime/workflow/paths'
import { ensureRunDir } from '../../../../src/runtime/workflow/paths'
import {
  runWorkflow,
  _resetWorkflowRuntimeForTests
} from '../../../../src/runtime/workflow/runtime'
import type { WorkflowRuntimeDeps } from '../../../../src/runtime/workflow/types'
import type { ToolResult } from '../../../../src/runtime/tools/types'

function makeDeps(workspaceRoot: string, client: MockModelClient): WorkflowRuntimeDeps {
  const reg = new ToolRegistry()
  reg.register({
    name: 'ls',
    description: 'list',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      return { success: true, output: 'ok' }
    }
  })
  return {
    modelClient: client,
    parentEventBus: new EventBus(),
    resolveTool: (n) => reg.getTool(n),
    workspaceRoot,
    mode: 'compose'
  }
}

function makeCtx(
  deps: WorkflowRuntimeDeps,
  journal = loadJournal(deps.workspaceRoot, 'j-run')
): HookContext {
  const { runSem, globalSem } = makeRunSemaphore(4)
  ensureRunDir(deps.workspaceRoot, 'j-run')
  const scope = new TaskScope({ label: 'test-journal' })
  return {
    runId: 'j-run',
    deps,
    abortSignal: scope.signal,
    scope,
    scopeGeneration: scope.captureGeneration(),
    currentPhase: { name: 'p1' },
    onPhase: () => {},
    onLog: () => {},
    journal,
    occ: new Map(),
    runSem,
    globalSem,
    ownedWorktrees: new Map(),
    composeState: {
      run: {
        id: 'j-run',
        command: 'test',
        script: 'test',
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        status: 'running'
      }
    },
    pendingAskUsers: new Map(),
    persistState: () => {}
  }
}

function addText(client: MockModelClient, text: string): void {
  client.addResponse({
    events: [
      { type: 'message_start' },
      { type: 'text_delta', delta: text },
      { type: 'message_end', finishReason: 'stop' }
    ]
  })
}

describe('workflow journal', () => {
  let tmp: string

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'nova-wf-journal-'))
    await _resetWorkflowRuntimeForTests()
  })

  afterEach(async () => {
    await _resetWorkflowRuntimeForTests()
    rmSync(tmp, { recursive: true, force: true })
  })

  it('命中：resume 后相同 prompt+opts 返回缓存（不调 agent）', async () => {
    // 同 run 内两次相同 prompt 占不同 occ 槽；缓存命中发生在 resume 重跑脚本时
    const client = new MockModelClient()
    addText(client, 'first')
    const script = `
export const meta = { name: "hit", description: "h" };
const r = await agent("same prompt");
return { r };
`
    const o1 = await runWorkflow({
      script,
      deps: makeDeps(tmp, client),
      runId: 'hit-1'
    })
    expect(o1.status).toBe('completed')
    expect(client.getCalls().length).toBe(1)

    const client2 = new MockModelClient()
    addText(client2, 'should-not-run')
    const o2 = await runWorkflow({
      script,
      deps: makeDeps(tmp, client2),
      runId: 'hit-1',
      resume: true
    })
    expect(o2.status).toBe('completed')
    if (o2.status === 'completed') expect(o2.result).toEqual({ r: 'first' })
    expect(client2.getCalls().length).toBe(0)
  })

  it('未命中：不同 prompt 重新跑', async () => {
    const client = new MockModelClient()
    addText(client, 'one')
    addText(client, 'two')
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    expect(await hooks.agent!('p1')).toBe('one')
    expect(await hooks.agent!('p2')).toBe('two')
    expect(client.getCalls().length).toBe(2)
  })

  it('失败重跑：null 结果不缓存', async () => {
    const client = new MockModelClient()
    // 第一次空输出 → null
    client.addResponse({
      events: [{ type: 'message_start' }, { type: 'message_end', finishReason: 'stop' }]
    })
    addText(client, 'recovered')
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    expect(await hooks.agent!('heal')).toBeNull()
    expect(await hooks.agent!('heal')).toBe('recovered')
    expect(client.getCalls().length).toBe(2)
  })

  it('hash 稳定性：opts 字段顺序无关', () => {
    const a = journalKeyBase('p', {
      agentType: 'br-debug',
      model: 'm',
      schema: { b: 2, a: 1 },
      phase: 'x'
    })
    const b = journalKeyBase('p', {
      phase: 'x',
      schema: { a: 1, b: 2 },
      model: 'm',
      agentType: 'br-debug'
    })
    expect(a).toBe(b)
  })

  it('hash 边界：tools/isolation/timeoutMs 参与哈希，label 不参与', () => {
    const base = { agentType: 'general', model: null, phase: 'p' }
    const k1 = journalKeyBase('prompt', { ...base, schema: null })
    const kTools = journalKeyBase('prompt', {
      ...base,
      schema: null,
      tools: ['bash', 'read']
    })
    expect(kTools).not.toBe(k1)

    const kIso = journalKeyBase('prompt', {
      ...base,
      schema: null,
      isolation: 'worktree'
    })
    expect(kIso).not.toBe(k1)

    const kTimeout = journalKeyBase('prompt', {
      ...base,
      schema: null,
      timeoutMs: 60_000
    })
    expect(kTimeout).not.toBe(k1)

    const kSchema = journalKeyBase('prompt', {
      ...base,
      schema: { type: 'object' }
    })
    expect(kSchema).not.toBe(k1)
  })

  it('corruption：末尾行无法 parse 时跳过', () => {
    ensureRunDir(tmp, 'corrupt')
    appendJournalSync(tmp, 'corrupt', [
      { t: 'agent', key: 'k1:0', result: 'ok', pass: 1 }
    ])
    // 追加半截行
    appendFileSync(runJournalPath(tmp, 'corrupt'), '{"t":"agent",broken', 'utf-8')
    const loaded = loadJournal(tmp, 'corrupt')
    expect(loaded.results.get('k1:0')).toBe('ok')
    expect(loaded.results.size).toBe(1)
  })

  it('resume：未失败 key 直接返回缓存；script_sha 不匹配默认拒绝，migrate 才清空', async () => {
    const client = new MockModelClient()
    addText(client, 'persisted')

    const scriptV1 = `
export const meta = { name: "jr", description: "j" };
const r = await agent("step");
return { r };
`
    const outcome1 = await runWorkflow({
      script: scriptV1,
      deps: makeDeps(tmp, client),
      runId: 'resume-1'
    })
    expect(outcome1.status).toBe('completed')
    expect(client.getCalls().length).toBe(1)

    // resume 同脚本：不调 agent
    const client2 = new MockModelClient()
    const outcome2 = await runWorkflow({
      script: scriptV1,
      deps: makeDeps(tmp, client2),
      runId: 'resume-1',
      resume: true
    })
    expect(outcome2.status).toBe('completed')
    if (outcome2.status === 'completed') {
      expect(outcome2.result).toEqual({ r: 'persisted' })
    }
    expect(client2.getCalls().length).toBe(0)

    // 改脚本 → 默认 reject
    const scriptV2 = `
export const meta = { name: "jr", description: "j" };
// script changed
const r = await agent("step");
return { r };
`
    const client3 = new MockModelClient()
    addText(client3, 'fresh')
    await expect(
      runWorkflow({
        script: scriptV2,
        deps: makeDeps(tmp, client3),
        runId: 'resume-1',
        resume: true
      })
    ).rejects.toThrow(/script source changed|refuse silent resume/i)
    expect(client3.getCalls().length).toBe(0)

    // 显式 migrate：清空 journal 后重跑
    const client4 = new MockModelClient()
    addText(client4, 'fresh')
    const outcome4 = await runWorkflow({
      script: scriptV2,
      deps: makeDeps(tmp, client4),
      runId: 'resume-1',
      resume: true,
      scriptShaMismatch: 'migrate'
    })
    expect(outcome4.status).toBe('completed')
    if (outcome4.status === 'completed') {
      expect(outcome4.result).toEqual({ r: 'fresh' })
    }
    expect(client4.getCalls().length).toBe(1)
    expect(readScriptSha(tmp, 'resume-1')).toBe(scriptSha(scriptV2))
  })

  it('skill 映射为 agentType：不同 skill 不命中缓存', async () => {
    const client = new MockModelClient()
    addText(client, 's1')
    addText(client, 's2')
    const hooks = createHostHooks(makeCtx(makeDeps(tmp, client)))
    expect(await hooks.agent!('same', { skill: 'br-debug' })).toBe('s1')
    expect(await hooks.agent!('same', { skill: 'br-verify' })).toBe('s2')
    expect(client.getCalls().length).toBe(2)
  })

  it('clearJournal 后 load 为空', () => {
    ensureRunDir(tmp, 'clr')
    appendJournalSync(tmp, 'clr', [{ t: 'agent', key: 'a:0', result: 1, pass: 1 }])
    clearJournal(tmp, 'clr')
    expect(loadJournal(tmp, 'clr').results.size).toBe(0)
  })

  it('writeScriptSha / readScriptSha', () => {
    ensureRunDir(tmp, 'sha')
    writeScriptSha(tmp, 'sha', 'abc')
    expect(readScriptSha(tmp, 'sha')).toBe('abc')
  })
})
