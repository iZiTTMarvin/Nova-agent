import { describe, expect, it, vi } from 'vitest'
import { RunExecutionRegistry } from '../../../../src/runtime/run'

describe('RunExecutionRegistry', () => {
  it('只允许匹配 generation 的句柄注销', () => {
    const registry = new RunExecutionRegistry()
    registry.register({
      runId: 'run_1',
      generation: 2,
      kind: 'agent',
      abort: vi.fn(),
      settled: Promise.resolve()
    })

    expect(registry.unregister('run_1', 1)).toBe(false)
    expect(registry.get('run_1')?.generation).toBe(2)
    expect(registry.unregister('run_1', 2)).toBe(true)
    expect(registry.get('run_1')).toBeNull()
  })

  it('超出 grace 后报告 lingering，不伪称执行已结束', async () => {
    const registry = new RunExecutionRegistry({ graceMs: 1 })
    const abort = vi.fn()
    registry.register({
      runId: 'run_1',
      generation: 1,
      kind: 'agent',
      abort,
      settled: new Promise<void>(() => {})
    })

    await expect(registry.abort('run_1', 'force_terminate')).resolves.toEqual({
      settled: false,
      lingering: true
    })
    expect(abort).toHaveBeenCalledWith('force_terminate')
  })
})
