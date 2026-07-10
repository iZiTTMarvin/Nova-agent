/**
 * Node vm 沙箱：注入 host hook，跑编排脚本 body。
 * 禁止 require / process / fs；禁止 Function/eval 代码生成；返回值经 JSON 拷贝。
 * parallel/pipeline 走 TaskScope child，不裸 Promise.all。
 */
import vm from 'node:vm'
import type { HostFn } from './types'
import { marshalIn, marshalOut } from './marshal'
import { TaskScope, withTaskScope } from './TaskScope'

export interface SandboxOptions {
  /** 整脚本墙钟预算，默认 12h */
  deadlineMs?: number
  /** 注入全局 args */
  args?: unknown
  /**
   * 外部 TaskScope（runtime 传入）。
   * 未传时 sandbox 自建根 scope，保证 deadline 真正 abort。
   */
  scope?: TaskScope
}

const DEFAULT_DEADLINE_MS = 12 * 60 * 60 * 1000

/**
 * guest 侧 prelude：parallel / pipeline 委托 host.__parallel / __pipeline，
 * 由 TaskScope child 管理，分支失败时取消兄弟任务。
 */
const PRELUDE = `
globalThis.parallel = (thunks) => globalThis.__parallel(thunks);
globalThis.pipeline = (items, ...stages) => globalThis.__pipeline(items, stages);
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
 * 在父 scope 下并行跑 thunks：每个 thunk 一个 child scope。
 * 任一失败 → 关闭父级 parallel scope → abort 兄弟 → 再抛错。
 */
async function runParallel(
  parent: TaskScope,
  thunks: unknown
): Promise<unknown[]> {
  if (!Array.isArray(thunks)) {
    throw new Error('parallel: expected array of thunks')
  }
  const parallelScope = parent.child('parallel')
  try {
    const tasks = thunks.map((thunk, index) => {
      const child = parallelScope.child(`parallel[${index}]`)
      return child.spawn(async () => {
        if (typeof thunk !== 'function') {
          throw new Error(`parallel: thunk[${index}] is not a function`)
        }
        return await (thunk as () => unknown)()
      })
    })

    // 任一失败立刻 close → abort 兄弟，再 allSettled 收敛（禁止裸等全部完成）
    let firstError: unknown = null
    const results: unknown[] = new Array(tasks.length)
    await new Promise<void>((resolve) => {
      let pending = tasks.length
      if (pending === 0) {
        resolve()
        return
      }
      tasks.forEach((task, index) => {
        task
          .then((value) => {
            results[index] = value
          })
          .catch((err) => {
            if (!firstError) {
              firstError = err
              // 立即 abort 兄弟分支
              void parallelScope.close('failed')
            }
          })
          .finally(() => {
            pending -= 1
            if (pending === 0) resolve()
          })
      })
    })

    if (firstError) {
      if (!parallelScope.isClosed) await parallelScope.close('failed')
      throw firstError
    }
    await parallelScope.close('completed')
    return results
  } catch (err) {
    if (!parallelScope.isClosed) {
      await parallelScope.close('failed')
    }
    throw err
  }
}

/**
 * pipeline：对每个 item 串行跑 stages，items 之间并行（各 child scope）。
 */
async function runPipeline(
  parent: TaskScope,
  items: unknown,
  stages: unknown
): Promise<unknown[]> {
  if (!Array.isArray(items)) {
    throw new Error('pipeline: expected items array')
  }
  if (!Array.isArray(stages)) {
    throw new Error('pipeline: expected stages array')
  }
  const pipelineScope = parent.child('pipeline')
  try {
    const tasks = items.map((item, index) => {
      const child = pipelineScope.child(`pipeline[${index}]`)
      return child.spawn(async () => {
        let acc: unknown = item
        for (const stage of stages) {
          if (typeof stage !== 'function') {
            throw new Error(`pipeline: stage is not a function`)
          }
          if (child.signal.aborted) {
            throw new Error('pipeline: aborted')
          }
          acc = await (stage as (prev: unknown, item: unknown, index: number) => unknown)(
            acc,
            item,
            index
          )
        }
        return acc
      })
    })

    let firstError: unknown = null
    const results: unknown[] = new Array(tasks.length)
    await new Promise<void>((resolve) => {
      let pending = tasks.length
      if (pending === 0) {
        resolve()
        return
      }
      tasks.forEach((task, index) => {
        task
          .then((value) => {
            results[index] = value
          })
          .catch((err) => {
            if (!firstError) {
              firstError = err
              void pipelineScope.close('failed')
            }
          })
          .finally(() => {
            pending -= 1
            if (pending === 0) resolve()
          })
      })
    })

    if (firstError) {
      if (!pipelineScope.isClosed) await pipelineScope.close('failed')
      throw firstError
    }
    await pipelineScope.close('completed')
    return results
  } catch (err) {
    if (!pipelineScope.isClosed) {
      await pipelineScope.close('failed')
    }
    throw err
  }
}

/**
 * 在隔离 context 中执行脚本 body（meta 已空白化）。
 * body 顶层可 await / return，语义等同 MiMo `(async () => { body })()`。
 * deadline 通过 TaskScope 真正 abort，不会留下可写 host 的旧 continuation。
 */
export async function evalScript(
  body: string,
  hooks: Record<string, HostFn>,
  opts: SandboxOptions = {}
): Promise<unknown> {
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS

  const runInScope = async (scope: TaskScope): Promise<unknown> => {
    const sandbox: Record<string, unknown> = {
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
      args: marshalIn(opts.args ?? null)
    }

    for (const [name, fn] of Object.entries(hooks)) {
      sandbox[name] = wrapHostFn(fn)
    }

    // 注入结构化并发入口（不经 marshal，保留 thunk 函数）
    sandbox.__parallel = (thunks: unknown) => runParallel(scope, thunks)
    sandbox.__pipeline = (items: unknown, stages: unknown) => runPipeline(scope, items, stages)

    for (const name of [
      'require',
      'process',
      'fs',
      'module',
      'exports',
      'Buffer',
      '__dirname',
      '__filename'
    ]) {
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
        strings: false,
        wasm: false
      }
    })

    vm.runInContext(PRELUDE, context, { filename: 'workflow-prelude.js' })

    const wrapped = `(async () => {\n${body}\n})()`
    let resultPromise: Promise<unknown>
    try {
      const maybePromise = vm.runInContext(wrapped, context, {
        filename: 'workflow-script.js',
        timeout: Math.min(deadlineMs, 2_147_483_647)
      }) as unknown
      resultPromise = Promise.resolve(maybePromise)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`workflow script error: ${msg}`)
    }

    // 在 scope 内 await：deadline abort 后 isCurrent 失败，host 不再写副作用
    const gen = scope.captureGeneration()
    const result = await scope.spawn(async () => {
      try {
        return await resultPromise
      } catch (err) {
        if (scope.signal.aborted || !scope.isCurrent(gen)) {
          throw new Error(
            scope.reason === 'deadline'
              ? 'workflow script deadline exceeded'
              : `workflow script aborted: ${scope.reason ?? 'aborted'}`
          )
        }
        throw err
      }
    }, { label: 'script-body' })

    if (!scope.isCurrent(gen)) {
      throw new Error(
        scope.reason === 'deadline'
          ? 'workflow script deadline exceeded'
          : `workflow script aborted: ${scope.reason ?? 'aborted'}`
      )
    }

    return result === undefined ? undefined : marshalOut(result)
  }

  try {
    if (opts.scope) {
      return await runInScope(opts.scope)
    }
    return await withTaskScope({ label: 'workflow-sandbox', deadlineMs }, runInScope)
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('workflow ')) throw err
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`workflow script rejected: ${msg}`)
  }
}
