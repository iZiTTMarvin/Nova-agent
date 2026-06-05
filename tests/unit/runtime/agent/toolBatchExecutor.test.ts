import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ToolRegistry } from '../../../../src/runtime/tools/ToolRegistry'
import type { ToolContext, ToolExecutor, ToolResult } from '../../../../src/runtime/tools/types'
import { executeToolBatch } from '../../../../src/runtime/agent/toolBatchExecutor'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) {
      throw new Error('waitFor timeout')
    }
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function createContext(): ToolContext {
  return {
    workingDir: process.cwd(),
    supportsVision: true
  }
}

function registerTool(
  registry: ToolRegistry,
  name: string,
  executor: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>
): void {
  registry.register({
    name,
    description: name,
    executionMode: 'parallel',
    isConcurrencySafe: () => true,
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: executor
  })
}

describe('executeToolBatch', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('并发安全工具会并发执行，tool_result 按完成顺序发出，outcomes 按原始顺序返回', async () => {
    const registry = new ToolRegistry()
    const releaseRead = deferred<void>()
    const started: string[] = []
    let active = 0
    let maxActive = 0

    registerTool(registry, 'read', async () => {
      started.push('read:start')
      active++
      maxActive = Math.max(maxActive, active)
      await releaseRead.promise
      active--
      started.push('read:end')
      return { success: true, output: 'read-ok' }
    })

    registerTool(registry, 'grep', async () => {
      started.push('grep:start')
      active++
      maxActive = Math.max(maxActive, active)
      active--
      started.push('grep:end')
      return { success: true, output: 'grep-ok' }
    })

    const events: string[] = []
    const runPromise = executeToolBatch({
      toolCalls: [
        { id: 'tc_read', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tc_grep', name: 'grep', arguments: '{"pattern":"foo"}' }
      ],
      messageId: 'msg_parallel',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: event => {
        if (event.type === 'tool_result') {
          events.push(event.toolCallId)
        }
      },
      applyTruncation: output => output,
      maxParallelToolCalls: 4,
      toolExecution: 'parallel'
    })

    await waitFor(() => started.includes('read:start') && started.includes('grep:start'))
    expect(maxActive).toBeGreaterThanOrEqual(2)

    releaseRead.resolve()
    const result = await runPromise

    expect(events).toEqual(['tc_grep', 'tc_read'])
    expect(result.outcomes.map(item => item.toolCall.id)).toEqual(['tc_read', 'tc_grep'])
    expect(started).toContain('read:end')
  })

  it('toolExecution=sequential 时即使工具声明 parallel 也必须串行', async () => {
    const registry = new ToolRegistry()
    const releaseFirst = deferred<void>()
    let active = 0
    let maxActive = 0

    registerTool(registry, 'read', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      await releaseFirst.promise
      active--
      return { success: true, output: 'first' }
    })

    registerTool(registry, 'grep', async () => {
      active++
      maxActive = Math.max(maxActive, active)
      active--
      return { success: true, output: 'second' }
    })

    const runPromise = executeToolBatch({
      toolCalls: [
        { id: 'tc_read', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tc_grep', name: 'grep', arguments: '{"pattern":"foo"}' }
      ],
      messageId: 'msg_sequential',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: vi.fn(),
      applyTruncation: output => output,
      maxParallelToolCalls: 4,
      toolExecution: 'sequential'
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    expect(maxActive).toBe(1)
    releaseFirst.resolve()
    await runPromise
    expect(maxActive).toBe(1)
  })

  it('连续批次会保持 read+grep 并发、edit 独占、ls+find 并发的边界', async () => {
    const registry = new ToolRegistry()
    const releaseRead = deferred<void>()
    const releaseLs = deferred<void>()
    const timeline: string[] = []
    let active = 0
    let maxActive = 0

    const makeTool = (
      name: string,
      mode: 'parallel' | 'sequential',
      run: () => Promise<ToolResult>
    ): void => {
      registry.register({
        name,
        description: name,
        executionMode: mode,
        isConcurrencySafe: () => mode === 'parallel',
        parameters: { type: 'object', properties: {} },
        execute: run
      })
    }

    makeTool('read', 'parallel', async () => {
      timeline.push('read:start')
      active++
      maxActive = Math.max(maxActive, active)
      await releaseRead.promise
      active--
      timeline.push('read:end')
      return { success: true, output: 'read' }
    })

    makeTool('grep', 'parallel', async () => {
      timeline.push('grep:start')
      active++
      maxActive = Math.max(maxActive, active)
      active--
      timeline.push('grep:end')
      return { success: true, output: 'grep' }
    })

    makeTool('edit', 'sequential', async () => {
      timeline.push('edit:start')
      active++
      maxActive = Math.max(maxActive, active)
      active--
      timeline.push('edit:end')
      return { success: true, output: 'edit' }
    })

    makeTool('ls', 'parallel', async () => {
      timeline.push('ls:start')
      active++
      maxActive = Math.max(maxActive, active)
      await releaseLs.promise
      active--
      timeline.push('ls:end')
      return { success: true, output: 'ls' }
    })

    makeTool('find', 'parallel', async () => {
      timeline.push('find:start')
      active++
      maxActive = Math.max(maxActive, active)
      active--
      timeline.push('find:end')
      return { success: true, output: 'find' }
    })

    const runPromise = executeToolBatch({
      toolCalls: [
        { id: 'tc_read', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tc_grep', name: 'grep', arguments: '{"pattern":"foo"}' },
        { id: 'tc_edit', name: 'edit', arguments: '{}' },
        { id: 'tc_ls', name: 'ls', arguments: '{"path":"."}' },
        { id: 'tc_find', name: 'find', arguments: '{"pattern":"**/*.ts"}' }
      ],
      messageId: 'msg_batches',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: vi.fn(),
      applyTruncation: output => output,
      maxParallelToolCalls: 2,
      toolExecution: 'parallel'
    })

    await waitFor(() => timeline.includes('read:start') && timeline.includes('grep:start'))
    expect(maxActive).toBe(2)

    releaseRead.resolve()
    await waitFor(() => timeline.includes('edit:start'))
    expect(timeline.indexOf('edit:start')).toBeGreaterThan(timeline.indexOf('read:end'))
    expect(timeline.indexOf('edit:start')).toBeGreaterThan(timeline.indexOf('grep:end'))

    await waitFor(() => timeline.includes('ls:start') && timeline.includes('find:start'))
    expect(timeline.indexOf('ls:start')).toBeGreaterThan(timeline.indexOf('edit:end'))
    expect(timeline.indexOf('find:start')).toBeGreaterThan(timeline.indexOf('edit:end'))

    releaseLs.resolve()
    await runPromise
    expect(maxActive).toBe(2)
  })

  it('单个工具失败不会中断同批次的其他工具', async () => {
    const registry = new ToolRegistry()

    registerTool(registry, 'read', async () => {
      return { success: false, output: '', error: 'boom' }
    })

    registerTool(registry, 'grep', async () => {
      return { success: true, output: 'ok' }
    })

    const events: string[] = []
    const result = await executeToolBatch({
      toolCalls: [
        { id: 'tc_read', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tc_grep', name: 'grep', arguments: '{"pattern":"foo"}' }
      ],
      messageId: 'msg_fail',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: undefined,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: event => {
        if (event.type === 'tool_result') {
          events.push(event.toolCallId)
        }
      },
      applyTruncation: output => output,
      maxParallelToolCalls: 4,
      toolExecution: 'parallel'
    })

    expect(events).toEqual(['tc_read', 'tc_grep'])
    expect(result.outcomes[0].resultText).toContain('工具执行失败')
    expect(result.outcomes[1].resultText).toBe('ok')
  })

  it('cancel 在权限等待期间不会产生权限拒绝结果，也不会启动工具执行', async () => {
    const registry = new ToolRegistry()
    const abortController = new AbortController()
    const permissionGate = deferred<{ allowed: boolean; reason: string; aborted?: boolean }>()
    const events: string[] = []

    registerTool(registry, 'read', async () => {
      return { success: true, output: 'should-not-run' }
    })

    const runPromise = executeToolBatch({
      toolCalls: [
        { id: 'tc_read', name: 'read', arguments: '{"path":"a.ts"}' }
      ],
      messageId: 'msg_cancel',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: abortController.signal,
      checkPermission: async () => {
        const result = await permissionGate.promise
        return result
      },
      emit: event => {
        if (event.type === 'tool_result') {
          events.push(event.result)
        }
      },
      applyTruncation: output => output,
      maxParallelToolCalls: 4,
      toolExecution: 'parallel'
    })

    await new Promise(resolve => setTimeout(resolve, 0))
    abortController.abort()
    permissionGate.resolve({ allowed: false, reason: '', aborted: true })

    const result = await runPromise
    expect(events).toHaveLength(0)
    expect(result.outcomes[0].skippedByAbort).toBe(true)
  })

  it('maxParallelToolCalls 会限制并发任务数量', async () => {
    const registry = new ToolRegistry()

    const createWaitingTool = (name: string, gate: ReturnType<typeof deferred<void>>) => {
      registerTool(registry, name, async () => {
        await gate.promise
        return { success: true, output: name }
      })
    }

    for (const limit of [1, 2]) {
      const gate = deferred<void>()
      const localRegistry = new ToolRegistry()
      const activeState = { active: 0, max: 0 }
      for (let i = 0; i < 3; i++) {
        registerTool(localRegistry, `tool_${limit}_${i}`, async () => {
          activeState.active++
          activeState.max = Math.max(activeState.max, activeState.active)
          await gate.promise
          activeState.active--
          return { success: true, output: `tool_${i}` }
        })
      }

      const runPromise = executeToolBatch({
        toolCalls: [
          { id: `tc_${limit}_1`, name: `tool_${limit}_0`, arguments: '{}' },
          { id: `tc_${limit}_2`, name: `tool_${limit}_1`, arguments: '{}' },
          { id: `tc_${limit}_3`, name: `tool_${limit}_2`, arguments: '{}' }
        ],
        messageId: `msg_limit_${limit}`,
        toolRegistry: localRegistry,
        workingDir: process.cwd(),
        mode: 'default',
        supportsVision: true,
        checkpointManager: null,
        abortSignal: undefined,
        checkPermission: async () => ({ allowed: true, reason: '' }),
        emit: vi.fn(),
        applyTruncation: output => output,
        maxParallelToolCalls: limit,
        toolExecution: 'parallel'
      })

      await waitFor(() => activeState.max >= Math.min(limit, 2))
      gate.resolve()
      await runPromise
      expect(activeState.max).toBe(limit)
    }
  })

  it('并发批次执行期间 cancel，不再启动新工具，已完成工具结果不污染 context', async () => {
    const registry = new ToolRegistry()
    const abortController = new AbortController()
    const releaseRead = deferred<void>()
    const releaseGrep = deferred<void>()
    const started: string[] = []

    // 第一个工具等待，占用一个并发槽
    registerTool(registry, 'read', async () => {
      started.push('read')
      await releaseRead.promise
      return { success: true, output: 'read-ok' }
    })

    // 第二个工具也等待，占用另一个并发槽
    registerTool(registry, 'grep', async () => {
      started.push('grep')
      await releaseGrep.promise
      return { success: true, output: 'grep-ok' }
    })

    // 第三个工具不应被启动（cancel 后 maybeStart 停止调度）
    registerTool(registry, 'find', async () => {
      started.push('find')
      return { success: true, output: 'find-ok' }
    })

    const events: string[] = []
    const runPromise = executeToolBatch({
      toolCalls: [
        { id: 'tc_read', name: 'read', arguments: '{"path":"a.ts"}' },
        { id: 'tc_grep', name: 'grep', arguments: '{"pattern":"foo"}' },
        { id: 'tc_find', name: 'find', arguments: '{"pattern":"**/*.ts"}' }
      ],
      messageId: 'msg_cancel_during_exec',
      toolRegistry: registry,
      workingDir: process.cwd(),
      mode: 'default',
      supportsVision: true,
      checkpointManager: null,
      abortSignal: abortController.signal,
      checkPermission: async () => ({ allowed: true, reason: '' }),
      emit: event => {
        if (event.type === 'tool_result') {
          events.push(event.toolCallId)
        }
      },
      applyTruncation: output => output,
      maxParallelToolCalls: 2,
      toolExecution: 'parallel'
    })

    // 等待前两个工具启动（并发上限为 2，两个槽位都被占用）
    await waitFor(() => started.includes('read') && started.includes('grep'))

    // 两个工具都在等待中，此时触发 cancel。
    // maybeStart 的 while 循环条件 !abortSignal.aborted 为 false，不再启动 find。
    abortController.abort()
    releaseRead.resolve()
    releaseGrep.resolve()

    const result = await runPromise

    // find 不应被启动（cancel 后 maybeStart 停止调度新任务）
    expect(started).not.toContain('find')

    // 结果应标记 aborted
    expect(result.aborted).toBe(true)

    // find 的 outcome 应标记为 skippedByAbort
    const findOutcome = result.outcomes.find(o => o.toolCall.id === 'tc_find')
    expect(findOutcome?.skippedByAbort).toBe(true)
  })
})
