/**
 * Worker 承载的 Code Runtime 集成验证：真实 worker_threads + 构建产物 + 消息协议。
 * 保护跨线程链路：工具桥往返、SharedArrayBuffer 中止打断阻塞循环（同线程事件式
 * signal 做不到这一点）。依赖 out/main/codeModeWorker.js（npm run build 产物），
 * 未构建时跳过——完整链路由构建后的 E2E 与开发态覆盖。
 */
import { existsSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { QuickJsCodeRuntime } from '@runtime/code-mode/quickjs/QuickJsCodeRuntime'
import { DEFAULT_CODE_MODE_LIMITS } from '@runtime/code-mode/limits'

const workerPath = resolve(__dirname, '../../../../out/main/codeModeWorker.js')
const workerBuilt = existsSync(workerPath)
const suite = workerBuilt ? describe : describe.skip

suite('QuickJsCodeRuntime（真实 worker）', () => {
  it('跨线程执行受限程序并完成工具桥往返', async () => {
    const runtime = new QuickJsCodeRuntime({ workerPath })
    try {
      const result = await runtime.execute({
        source: `
          console.log('worker probe')
          const a = await tools.read({ path: 'a.ts' })
          return { ok: true, len: a.output.length }
        `,
        toolNames: ['read', 'grep'],
        limits: DEFAULT_CODE_MODE_LIMITS,
        dispatchToolCall: async request => ({
          ok: true,
          resultJson: JSON.stringify({ output: `host:${request.toolName}` })
        })
      })
      expect(result.status).toBe('ok')
      expect(JSON.parse(result.valueJson!)).toEqual({ ok: true, len: 'host:read'.length })
      expect(result.logs).toEqual(['worker probe'])
      expect(result.toolCallCount).toBe(1)
    } finally {
      runtime.dispose()
    }
  }, 20_000)

  it('宿主工具桥异常会回结为工具失败，不等待 watchdog 超时', async () => {
    const runtime = new QuickJsCodeRuntime({ workerPath })
    try {
      const startedAt = Date.now()
      const result = await runtime.execute({
        source: `await tools.read({ path: 'a.ts' })`,
        toolNames: ['read'],
        limits: { ...DEFAULT_CODE_MODE_LIMITS, maxSandboxTimeMs: 2_000 },
        dispatchToolCall: async () => {
          throw new Error('bridge exploded')
        }
      })
      expect(result.status).toBe('failed')
      expect(result.kind).toBe('tool_failure')
      expect(result.message).toContain('bridge exploded')
      expect(Date.now() - startedAt).toBeLessThan(2_000)
    } finally {
      runtime.dispose()
    }
  }, 10_000)

  it('外部中止经共享内存标志打断另一线程中阻塞的同步循环', async () => {
    const runtime = new QuickJsCodeRuntime({ workerPath })
    try {
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 300)
      const result = await runtime.execute({
        source: 'while (true) { }',
        toolNames: [],
        limits: { ...DEFAULT_CODE_MODE_LIMITS, maxSandboxTimeMs: 60_000 },
        signal: controller.signal,
        dispatchToolCall: async () => ({ ok: true, resultJson: 'null' })
      })
      expect(result.status).toBe('failed')
      expect(result.kind).toBe('aborted')
    } finally {
      runtime.dispose()
    }
  }, 20_000)
})
