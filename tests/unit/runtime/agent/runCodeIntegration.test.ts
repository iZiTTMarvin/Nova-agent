/**
 * Code Mode 集成测试：run_code → 嵌套 grep/read → return 全链路。
 * 真实 ToolRegistry（真实只读工具实现）+ 真实 QuickJS 沙箱 + 统一执行流水线，
 * 验证嵌套调用真实执行、父子关联可观测、嵌套结果不进入主上下文、
 * direct-only 与未激活 deferred 工具无法经 SDK 调用。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import { lsTool } from '../../../../src/runtime/tools/lsTool'
import { readTool } from '../../../../src/runtime/tools/readTool'
import { createGrepTool } from '../../../../src/runtime/tools/grepTool'
import { findTool } from '../../../../src/runtime/tools/findTool'
import { createRunCodeTool } from '../../../../src/runtime/tools/runCode'
import { InProcessCodeRuntime } from '../../../../src/runtime/code-mode'
import { ToolAvailability } from '../../../../src/runtime/tools/availability'
import { executeToolBatch } from '../../../../src/runtime/agent/execution/toolBatchExecutor'
import { createReadState } from '../../../../src/runtime/tools/editTool'
import type { AgentEvent } from '../../../../src/runtime/agent/types'

describe('run_code 集成（统一流水线 + 真实沙箱）', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'nova-run-code-'))
    writeFileSync(join(workspace, 'auth.ts'), ['export function verifyToken(token: string) {', '  return token.length > 0', '}', ''].join('\n'))
    writeFileSync(join(workspace, 'session.ts'), ['export const SESSION_MARKER = "verifyToken"', ''].join('\n'))
    mkdirSync(join(workspace, 'lib'))
    writeFileSync(join(workspace, 'lib', 'util.ts'), 'export const id = 1\n')
  })

  afterEach(() => {
    try {
      rmSync(workspace, { recursive: true, force: true })
    } catch {
      // ignore
    }
  })

  interface Harness {
    run: (code: string, options?: { economy?: 'off' | 'on' }) => Promise<{
      outcome: { resultText: string; failed?: boolean }
      events: AgentEvent[]
    }>
  }

  function createHarness(): Harness {
    const registry = new ToolRegistry()
    const availability = new ToolAvailability()
    registry.register(lsTool)
    registry.register(readTool)
    registry.register(createGrepTool({ maxResultSizeChars: 100_000 }))
    registry.register(findTool)
    registry.register(
      createRunCodeTool({
        getToolAvailability: () => availability,
        getPresentationMode: () => 'code-readonly',
        createCodeRuntime: () => new InProcessCodeRuntime()
      })
    )
    availability.bindRegisteredToolNames(registry.getToolDefinitions().map(def => def.name))

    const events: AgentEvent[] = []
    return {
      run: async (code, options) => {
        availability.setEconomyMode(options?.economy ?? 'off')
        const { outcomes } = await executeToolBatch({
          toolCalls: [
            {
              id: 'tc_run_code',
              name: 'run_code',
              arguments: JSON.stringify({ code, description: 'integration' })
            }
          ],
          messageId: 'msg_int',
          toolRegistry: registry,
          workingDir: workspace,
          runId: 'run_int',
          sessionId: 'sess_int',
          mode: 'default',
          supportsVision: false,
          checkpointManager: null,
          abortSignal: undefined,
          checkPermission: async () => ({ allowed: true, reason: '' }),
          emit: event => {
            events.push(event)
          },
          applyTruncation: output => output,
          maxParallelToolCalls: 4,
          toolExecution: 'parallel',
          readState: createReadState(),
          isToolAvailable: name => availability.isToolAvailable(name),
          allowNestedToolDispatch: true
        })
        expect(outcomes).toHaveLength(1)
        return { outcome: outcomes[0], events }
      }
    }
  }

  it('run_code → grep → read → return：嵌套工具真实执行，主上下文只有 curated output', async () => {
    const harness = createHarness()
    const { outcome, events } = await harness.run(`
      const matches = await tools.grep({ pattern: 'verifyToken', output_mode: 'files_with_matches' })
      console.log('files:', matches.output.trim())
      const auth = await tools.read({ path: 'auth.ts' })
      return { lines: auth.output.split('\\n').length, marker: auth.output.includes('verifyToken') }
    `)

    // run_code 是唯一进入主上下文的工具结果
    expect(outcome.failed).toBeFalsy()
    expect(outcome.resultText).toContain('[console]')
    expect(outcome.resultText).toContain('files:')
    expect(outcome.resultText).toContain('[return]')
    expect(outcome.resultText).toContain('"marker": true')

    // 嵌套调用真实执行（grep 找到了两个文件、read 读到了真实内容）
    expect(outcome.resultText).toContain('auth.ts')
    expect(outcome.resultText).toContain('session.ts')

    // 嵌套事件带父标识且成对；嵌套结果文本不等于主上下文内容（隐藏中间结果）
    const nestedCalls = events.filter(
      e => e.type === 'tool_call' && e.toolCallId.startsWith('tc_run_code#nested-')
    )
    const nestedResults = events.filter(
      e => e.type === 'tool_result' && e.toolCallId.startsWith('tc_run_code#nested-')
    )
    expect(nestedCalls).toHaveLength(2)
    expect(nestedResults).toHaveLength(2)
    for (const event of nestedCalls) {
      expect((event as Extract<AgentEvent, { type: 'tool_call' }>).parentToolCallId).toBe('tc_run_code')
    }
    for (const event of nestedResults) {
      expect((event as Extract<AgentEvent, { type: 'tool_result' }>).parentToolCallId).toBe('tc_run_code')
    }
    // 嵌套调用的完整输出只出现在事件流；主上下文只包含代码主动 log/return 的内容
    const nestedReadResult = nestedResults.find(
      e => (e as Extract<AgentEvent, { type: 'tool_result' }>).toolName === 'read'
    ) as Extract<AgentEvent, { type: 'tool_result' }>
    expect(nestedReadResult.result).toContain('export function verifyToken')
    // 代码没有 log 文件正文，只 return 了行数与标记——正文不进入主上下文
    expect(outcome.resultText).not.toContain('export function verifyToken')
  })

  it('direct-only 工具无法通过 SDK 调用（edit 不可达）', async () => {
    const harness = createHarness()
    const { outcome } = await harness.run(`
      try {
        await tools.edit({ filePath: 'x.ts', edits: [] })
        return 'unexpected'
      } catch (e) {
        return { blocked: true, name: e.name }
      }
    `)
    expect(outcome.failed).toBeFalsy()
    expect(outcome.resultText).toContain('"blocked": true')
    expect(outcome.resultText).toContain('ToolCallError')
  })

  it('economy on 时未激活的 deferred 工具不进入 SDK（task 不可达）', async () => {
    const harness = createHarness()
    const { outcome } = await harness.run(
      `
      try {
        await tools.task({ subagent_type: 'explore', task: 'x' })
        return 'unexpected'
      } catch (e) {
        return { blocked: true }
      }
    `,
      { economy: 'on' }
    )
    expect(outcome.failed).toBeFalsy()
    expect(outcome.resultText).toContain('"blocked": true')
  })

  it('嵌套调用失败可被代码捕获并继续探索', async () => {
    const harness = createHarness()
    const { outcome } = await harness.run(`
      let first = 'none'
      try {
        await tools.read({ path: 'missing-file.ts' })
        return 'unexpected'
      } catch (e) {
        first = e.name
      }
      const fallback = await tools.ls({ path: '.' })
      return { recovered: first === 'ToolCallError', listed: fallback.output.includes('auth.ts') }
    `)
    expect(outcome.failed).toBeFalsy()
    expect(outcome.resultText).toContain('"recovered": true')
    expect(outcome.resultText).toContain('"listed": true')
  })
})
