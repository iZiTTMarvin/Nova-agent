/**
 * Code Runtime 沙箱宿主测试（§56）：
 * 保护安全边界（无宿主 API 可达）、资源上限、中止/超时与工具桥契约。
 */
import { describe, expect, it } from 'vitest'
import { executeInQuickJsSandbox } from '@runtime/code-mode/quickjs/QuickJsSandboxHost'
import { loadQuickJsModule } from '@runtime/code-mode/quickjs/quickJsModule'
import { DEFAULT_CODE_MODE_LIMITS } from '@runtime/code-mode/limits'
import type { CodeRuntimeExecutionInput, CodeRuntimeToolCallRequest } from '@runtime/code-mode/types'

const modulePromise = loadQuickJsModule()

type Dispatch = (request: CodeRuntimeToolCallRequest) => Promise<{ ok: boolean; resultJson?: string; errorMessage?: string }>

function makeInput(
  source: string,
  options: {
    toolNames?: string[]
    dispatch?: Dispatch
    limits?: Partial<typeof DEFAULT_CODE_MODE_LIMITS>
    signal?: AbortSignal
    isAborted?: () => boolean
  } = {}
): CodeRuntimeExecutionInput {
  const dispatch: Dispatch =
    options.dispatch ??
    (async request => ({ ok: true, resultJson: JSON.stringify({ output: `mock:${request.toolName}` }) }))
  return {
    source,
    toolNames: options.toolNames ?? ['ls', 'read', 'grep', 'find'],
    limits: { ...DEFAULT_CODE_MODE_LIMITS, ...options.limits },
    signal: options.signal,
    ...(options.isAborted ? { isAborted: options.isAborted } : {}),
    dispatchToolCall: dispatch
  }
}

async function run(
  source: string,
  options?: Parameters<typeof makeInput>[1]
) {
  return executeInQuickJsSandbox(await modulePromise, makeInput(source, options))
}

describe('QuickJsSandboxHost', () => {
  it('执行合法程序：工具调用 + console + return 值', async () => {
    const calls: CodeRuntimeToolCallRequest[] = []
    const result = await run(
      `
      console.log('start')
      const a = await tools.read({ path: 'a.ts' })
      const b = await tools.grep({ pattern: 'x' })
      console.log('two calls done')
      return { first: a.output, second: b.output, total: 2 }
      `,
      {
        dispatch: async request => {
          calls.push(request)
          return { ok: true, resultJson: JSON.stringify({ output: `out:${request.argsJson.length}` }) }
        }
      }
    )
    expect(result.status).toBe('ok')
    expect(result.valueJson).toBe(JSON.stringify({ first: 'out:15', second: 'out:15', total: 2 }))
    expect(result.logs).toEqual(['start', 'two calls done'])
    expect(result.toolCallCount).toBe(2)
    expect(calls.map(c => c.toolName)).toEqual(['read', 'grep'])
  })

  it('语法错误归类为 parse_error', async () => {
    const result = await run('const a = { this is not valid')
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('parse_error')
  })

  it('运行时异常归类为 execution_error 且包含自我修正信息', async () => {
    const result = await run('throw new Error("boom")')
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('execution_error')
    expect(result.message).toContain('boom')
  })

  it('同步死循环被超时中断（limit_exceeded）', async () => {
    const result = await run('while (true) { }', {
      limits: { maxSandboxTimeMs: 200 }
    })
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('limit_exceeded')
    expect(result.message).toContain('超时')
  }, 10_000)

  it('同步中止探针可打断阻塞中的同步循环（Worker SAB 同一机制）并归类 aborted', async () => {
    // 进程内宿主无法用事件式 signal 打断阻塞循环（事件循环被占用）；
    // Worker 部署通过 SharedArrayBuffer 标志走本探针路径，中断器同步读取
    const result = await run('while (true) { }', { isAborted: () => true })
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('aborted')
  }, 10_000)

  it('中止信号打断工具调用等待并归类 aborted', async () => {
    const controller = new AbortController()
    const result = run(
      `
      await tools.read({ path: 'never-returns' })
      return 'unreachable'
      `,
      {
        signal: controller.signal,
        dispatch: async () => {
          controller.abort()
          await new Promise(resolve => setTimeout(resolve, 20))
          return { ok: true, resultJson: 'null' }
        }
      }
    )
    const settled = await result
    expect(settled.status).toBe('failed')
    expect(settled.kind).toBe('aborted')
  })

  it('源码超过 maxSourceBytes 直接拒绝', async () => {
    const result = await run(`const s = "${'x'.repeat(500)}"`, {
      limits: { maxSourceBytes: 64 }
    })
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('limit_exceeded')
    expect(result.message).toContain('源码过大')
  })

  it('工具调用次数超过 maxToolCalls 归类 limit_exceeded', async () => {
    const result = await run(
      `
      for (let i = 0; i < 10; i++) {
        await tools.read({ path: 'f' + i })
      }
      return 'done'
      `,
      { limits: { maxToolCalls: 3 } }
    )
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('limit_exceeded')
    expect(result.message).toContain('上限')
  })

  it('单次工具入参超过 maxToolInputBytes 返回可自救错误', async () => {
    const result = await run(
      `
      try {
        await tools.read({ path: 'x'.repeat(100) })
        return 'should-not-happen'
      } catch (e) {
        return e.name
      }
      `,
      { limits: { maxToolInputBytes: 64 } }
    )
    expect(result.status).toBe('ok')
    expect(result.valueJson).toBe(JSON.stringify('ToolCallError'))
  })

  it('单次工具输出超过 maxToolOutputBytes 返回可自救错误', async () => {
    const result = await run(
      `
      try {
        await tools.read({ path: 'big' })
        return 'should-not-happen'
      } catch (e) {
        return { name: e.name, tool: e.toolName }
      }
      `,
      {
        limits: { maxToolOutputBytes: 32 },
        dispatch: async () => ({ ok: true, resultJson: JSON.stringify({ output: 'y'.repeat(200) }) })
      }
    )
    expect(result.status).toBe('ok')
    expect(JSON.parse(result.valueJson!)).toEqual({ name: 'ToolCallError', tool: 'read' })
  })

  it('未列入清单的工具在沙箱内抛 ToolCallError（unknown_tool）', async () => {
    const result = await run(
      `
      try {
        await tools.edit({ path: 'a', content: 'b' })
        return 'should-not-happen'
      } catch (e) {
        return { name: e.name, tool: e.toolName, hasTool: typeof e.toolName === 'string' }
      }
      `,
      { toolNames: ['ls', 'read'] }
    )
    expect(result.status).toBe('ok')
    const value = JSON.parse(result.valueJson!)
    expect(value.name).toBe('ToolCallError')
    expect(value.tool).toBe('edit')
    expect(value.hasTool).toBe(true)
  })

  it('宿主侧防御：请求未列出工具时回送错误而不是执行', async () => {
    const dispatched: string[] = []
    // 沙箱 Proxy 已拦截未知工具；此用例构造绕过场景由宿主兜底——
    // 通过 glue 白名单与宿主集合不一致模拟（宿主只允许 read）
    const result = await run(
      `
      try {
        await tools.ls({ path: '.' })
        return 'unexpected-ok'
      } catch (e) {
        return e.message
      }
      `,
      {
        toolNames: ['ls', 'read'],
        dispatch: async request => {
          dispatched.push(request.toolName)
          if (request.toolName !== 'read') {
            return { ok: false, errorMessage: `工具 ${request.toolName} 不在 code mode 可用清单中` }
          }
          return { ok: true, resultJson: 'null' }
        }
      }
    )
    expect(result.status).toBe('ok')
    expect(result.valueJson).toContain('不在 code mode 可用清单中')
    expect(dispatched).toEqual(['ls'])
  })

  it('嵌套工具失败以 ToolCallError 形式暴露 toolName 与 message', async () => {
    const result = await run(
      `
      try {
        await tools.grep({ pattern: 'secret' })
        return 'should-not-happen'
      } catch (e) {
        return { name: e.name, tool: e.toolName, message: e.message }
      }
      `,
      {
        dispatch: async () => ({ ok: false, errorMessage: '权限拒绝: 该目录不可读' })
      }
    )
    const value = JSON.parse(result.valueJson!)
    expect(value).toEqual({
      name: 'ToolCallError',
      tool: 'grep',
      message: '权限拒绝: 该目录不可读'
    })
  })

  it('顶层未捕获的 ToolCallError 归类 tool_failure', async () => {
    const result = await run(
      `await tools.read({ path: 'denied' })`,
      { dispatch: async () => ({ ok: false, errorMessage: '权限拒绝' }) }
    )
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('tool_failure')
    expect(result.message).toContain('read')
  })

  it('Promise.all 并发发起多个工具调用并全部回结', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const result = await run(
      `
      const results = await Promise.all([
        tools.read({ path: 'a' }),
        tools.read({ path: 'b' }),
        tools.grep({ pattern: 'c' })
      ])
      return results.map(r => r.output)
      `,
      {
        dispatch: async request => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise(resolve => setTimeout(resolve, 20))
          inFlight--
          return { ok: true, resultJson: JSON.stringify({ output: request.toolName }) }
        }
      }
    )
    expect(result.status).toBe('ok')
    expect(JSON.parse(result.valueJson!)).toEqual(['read', 'read', 'grep'])
    expect(maxInFlight).toBe(3)
  })

  it('工具并发受 maxToolConcurrency 限制', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const result = await run(
      `
      await Promise.all([
        tools.read({ path: '1' }),
        tools.read({ path: '2' }),
        tools.read({ path: '3' }),
        tools.read({ path: '4' }),
        tools.read({ path: '5' }),
        tools.read({ path: '6' })
      ])
      return 'ok'
      `,
      {
        limits: { maxToolConcurrency: 2 },
        dispatch: async () => {
          inFlight++
          maxInFlight = Math.max(maxInFlight, inFlight)
          await new Promise(resolve => setTimeout(resolve, 20))
          inFlight--
          return { ok: true, resultJson: 'null' }
        }
      }
    )
    expect(result.status).toBe('ok')
    expect(maxInFlight).toBeLessThanOrEqual(2)
  })

  it('沙箱内无 Node 宿主 API：process / require / fs / globalThis.process 不可达', async () => {
    const result = await run(
      `
      return {
        process: typeof process,
        require: typeof require,
        module: typeof module,
        __dirname: typeof __dirname,
        Buffer: typeof Buffer,
        fetch: typeof fetch,
        XMLHttpRequest: typeof XMLHttpRequest,
        globalProcess: typeof globalThis.process,
        globalFetch: typeof globalThis.fetch,
        setTimeout: typeof setTimeout
      }
      `
    )
    expect(result.status).toBe('ok')
    expect(JSON.parse(result.valueJson!)).toEqual({
      process: 'undefined',
      require: 'undefined',
      module: 'undefined',
      __dirname: 'undefined',
      Buffer: 'undefined',
      fetch: 'undefined',
      XMLHttpRequest: 'undefined',
      globalProcess: 'undefined',
      globalFetch: 'undefined',
      setTimeout: 'undefined'
    })
  })

  it('沙箱无法通过构造函数/反射逃逸：Function 构造器无法访问宿主', async () => {
    // QuickJS 的 Function 构造器只解析沙箱内语法，不携带宿主作用域；
    // 验证其求值结果同样看不到宿主 API
    const result = await run(
      `
      const probe = new Function('return typeof process + "/" + typeof require')
      return probe()
      `
    )
    expect(result.status).toBe('ok')
    expect(result.valueJson).toBe(JSON.stringify('undefined/undefined'))
  })

  it('最终 return 的超大值被截断到 maxModelOutputBytes', async () => {
    const result = await run(`return 'z'.repeat(50_000)`, {
      limits: { maxModelOutputBytes: 2048 }
    })
    expect(result.status).toBe('ok')
    expect(Buffer.byteLength(result.valueJson!, 'utf8')).toBeLessThanOrEqual(2048 + 128)
    expect(result.valueJson).toContain('已截断')
  })

  it('无 return 时 valueJson 为 null，console 输出仍收集', async () => {
    const result = await run(`console.log('only logs')`)
    expect(result.status).toBe('ok')
    expect(result.valueJson).toBeNull()
    expect(result.logs).toEqual(['only logs'])
  })

  it('等待永不能完成的 Promise 被判定为执行错误而非挂起', async () => {
    const result = await run(
      `await new Promise(() => {})`,
      { limits: { maxSandboxTimeMs: 60_000 } }
    )
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('execution_error')
  }, 10_000)

  it('工具桥异常被收敛为 ToolCallError 而不是击穿宿主', async () => {
    const result = await run(
      `
      try {
        await tools.find({ pattern: '*' })
        return 'should-not-happen'
      } catch (e) {
        return e.message
      }
      `,
      {
        dispatch: async () => {
          throw new Error('bridge exploded')
        }
      }
    )
    expect(result.status).toBe('ok')
    expect(result.valueJson).toBe(JSON.stringify('bridge exploded'))
  })

  it('内存超限归类 limit_exceeded', async () => {
    const result = await run(`const arr = []; while (true) { arr.push('x'.repeat(1024)) }`, {
      limits: { maxSandboxMemoryBytes: 8 * 1024 * 1024, maxSandboxTimeMs: 60_000 }
    })
    expect(result.status).toBe('failed')
    expect(result.kind).toBe('limit_exceeded')
  }, 20_000)
})
