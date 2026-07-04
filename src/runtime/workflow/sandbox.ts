/**
 * Node vm 沙箱：注入 host hook，跑编排脚本 body。
 * 禁止 require / process / fs；禁止 Function/eval 代码生成；返回值经 JSON 拷贝。
 */
import vm from 'node:vm'
import type { HostFn } from './types'
import { marshalIn, marshalOut } from './marshal'

export interface SandboxOptions {
  /** 整脚本墙钟预算，默认 12h */
  deadlineMs?: number
  /** 注入全局 args */
  args?: unknown
}

const DEFAULT_DEADLINE_MS = 12 * 60 * 60 * 1000

/**
 * guest 侧纯辅助：parallel 只是 Promise.all，不节流。
 * 并发限流由 host agent() 内信号量负责（阶段 B）。
 */
const PRELUDE = `
globalThis.parallel = (thunks) =>
  Promise.all(thunks.map((t) => Promise.resolve().then(t)));
globalThis.pipeline = (items, ...stages) =>
  Promise.all(items.map((item, index) =>
    stages.reduce((acc, stage) => acc.then((prev) => stage(prev, item, index)), Promise.resolve(item))));
`

function denyAccess(name: string): () => never {
  return () => {
    throw new Error(`sandbox: access to '${name}' is denied`)
  }
}

/** 包装 host fn：入参/出参均 marshal，保证纯数据边界 */
function wrapHostFn(fn: HostFn): HostFn {
  return (...rawArgs: unknown[]) => {
    const args = rawArgs.map((a) => {
      try {
        return marshalOut(a)
      } catch {
        // 脚本传入的原始值若含函数（如 thunk），parallel 需要保留；仅对非函数做拷贝
        if (typeof a === 'function') return a
        throw new Error('sandbox: host argument is not marshalable')
      }
    })
    const out = fn(...args)
    if (out instanceof Promise) {
      return out.then((v) => (v === undefined ? undefined : marshalOut(v)))
    }
    return out === undefined ? undefined : marshalOut(out)
  }
}

/**
 * 在隔离 context 中执行脚本 body（meta 已空白化）。
 * body 顶层可 await / return，语义等同 MiMo `(async () => { body })()`。
 */
export async function evalScript(
  body: string,
  hooks: Record<string, HostFn>,
  opts: SandboxOptions = {}
): Promise<unknown> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS

  const sandbox: Record<string, unknown> = {
    // 安全内建
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    JSON,
    Promise,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    NaN,
    Infinity,
    undefined,
    Date,
    RegExp,
    // 注入 args（纯数据）
    args: marshalIn(opts.args ?? null)
  }

  for (const [name, fn] of Object.entries(hooks)) {
    sandbox[name] = wrapHostFn(fn)
  }

  // 敏感全局：访问即抛错（满足逃逸单测）
  for (const name of ['require', 'process', 'fs', 'module', 'exports', 'Buffer', '__dirname', '__filename']) {
    Object.defineProperty(sandbox, name, {
      configurable: false,
      enumerable: false,
      get: denyAccess(name),
      set: denyAccess(name)
    })
  }

  const context = vm.createContext(sandbox, {
    name: 'nova-workflow-sandbox',
    codeGeneration: {
      // 阻断 eval / new Function，堵住 ({ }).constructor.constructor(...) 逃逸
      strings: false,
      wasm: false
    }
  })

  // prelude：parallel / pipeline
  vm.runInContext(PRELUDE, context, { filename: 'workflow-prelude.js' })

  const wrapped = `(async () => {\n${body}\n})()`
  let resultPromise: Promise<unknown>
  try {
    const maybePromise = vm.runInContext(wrapped, context, {
      filename: 'workflow-script.js',
      // timeout 只杀同步死循环；异步挂起靠下方 deadline race
      timeout: Math.min(deadlineMs, 2_147_483_647)
    }) as unknown
    resultPromise = Promise.resolve(maybePromise)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`workflow script error: ${msg}`)
  }

  let deadlineTimer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(
      () => reject(new Error('workflow script deadline exceeded')),
      deadlineMs
    )
  })

  try {
    const result = await Promise.race([resultPromise, deadline])
    return result === undefined ? undefined : marshalOut(result)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('workflow ')) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`workflow script rejected: ${msg}`)
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer)
  }
}
