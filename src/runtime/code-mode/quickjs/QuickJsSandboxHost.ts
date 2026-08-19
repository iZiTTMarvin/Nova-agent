/**
 * QuickJS 沙箱宿主：在 QuickJS/WASM 上下文中执行受限程序并桥回工具调用。
 *
 * 安全模型：
 * - 沙箱内只有 QuickJS 标准库 + tools Proxy + console；require/process/fs/network/Electron 不可达。
 * - 中断器周期性检查中止标志与截止时间，阻塞中的同步循环（如 while(true)）也会被切断。
 * - 堆内存有硬上限；超限由 QuickJS 抛出并归类为 limit_exceeded。
 *
 * 执行模型：程序被包进 async 函数，顶层 return 的值经宿主函数 __hostSettle 回传；
 * tools.<name>(args) 创建 Promise 并经 __hostToolCall 通知宿主，宿主完成统一流水线
 * 执行后调用沙箱内 __deliverToolResult 送回结果，随后 executePendingJobs 推进续跑。
 */
import { isFail, isSuccess } from 'quickjs-emscripten-core'
import type { QuickJSWASMModule } from 'quickjs-emscripten-core'
import type { CodeRuntimeLimits } from '../limits'
import type {
  CodeRuntimeExecutionInput,
  CodeRuntimeExecutionResult,
  CodeRuntimeToolCallRequest,
  CodeRuntimeToolCallResolution,
  RunCodeFailureKind
} from '../types'

/** 单条 console 日志的截断长度，防止日志本身撑爆沙箱内存 */
const MAX_LOG_LINE_CHARS = 4000

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function truncateUtf8(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text
  // 粗截到字节上限内（指数回退避免逐字符扫描大字符串），不做多字节精确切分
  let end = text.length
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes - 64) {
    end = Math.floor(end / 2)
  }
  return `${text.slice(0, end)}…[已截断，超过 ${maxBytes} 字节]`
}

/** 沙箱预置 glue：tools Proxy / console / 结果回送。工具名单以字面量嵌入（名单来自 Catalog，受控输入）。 */
function buildGlueSource(toolNames: readonly string[]): string {
  const allowList = JSON.stringify([...toolNames].sort())
  return `
globalThis.ToolCallError = class ToolCallError extends Error {
  constructor(toolName, message) {
    super(message)
    this.name = 'ToolCallError'
    this.toolName = toolName
  }
}
const __allowedTools = new Set(${allowList})
const __pendingCalls = new Map()
let __callSeq = 0
globalThis.__logs = []
const __pushLog = (line) => {
  if (globalThis.__logs.length < 256) {
    globalThis.__logs.push(line.length > ${MAX_LOG_LINE_CHARS} ? line.slice(0, ${MAX_LOG_LINE_CHARS}) + '…[日志过长已截断]' : line)
  } else if (globalThis.__logs.length === 256) {
    globalThis.__logs.push('[日志条数过多，后续输出已丢弃]')
  }
}
const __fmt = (v) => {
  if (typeof v === 'string') return v
  if (v instanceof Error) return v.name + ': ' + v.message
  try {
    const s = JSON.stringify(v)
    return s === undefined ? String(v) : s
  } catch (e) {
    return String(v)
  }
}
globalThis.console = {
  log: (...a) => __pushLog(a.map(__fmt).join(' ')),
  info: (...a) => __pushLog(a.map(__fmt).join(' ')),
  warn: (...a) => __pushLog('[warn] ' + a.map(__fmt).join(' ')),
  error: (...a) => __pushLog('[error] ' + a.map(__fmt).join(' '))
}
const __callTool = (name, args) => new Promise((resolve, reject) => {
  if (!__allowedTools.has(name)) {
    reject(new ToolCallError(name, '工具 ' + name + ' 不可用；可用工具：' + [...__allowedTools].join(', ')))
    return
  }
  const id = ++__callSeq
  __pendingCalls.set(id, { resolve, reject })
  __hostToolCall(id, name, JSON.stringify(args ?? {}))
})
globalThis.tools = new Proxy({}, {
  get(_target, name) {
    if (typeof name !== 'string') return undefined
    return (args) => __callTool(name, args)
  }
})
globalThis.__deliverToolResult = (id, isErrorFlag, payloadJson) => {
  const pending = __pendingCalls.get(id)
  if (!pending) return
  __pendingCalls.delete(id)
  if (isErrorFlag !== 0) {
    const err = JSON.parse(payloadJson)
    pending.reject(new ToolCallError(err.toolName, err.message))
  } else {
    pending.resolve(JSON.parse(payloadJson))
  }
}
globalThis.__serializeValue = (v) => {
  if (v === undefined) return 'undefined'
  try {
    const s = JSON.stringify(v)
    return s === undefined ? JSON.stringify({ unserializable: String(v) }) : s
  } catch (e) {
    return JSON.stringify({ unserializable: String(v) })
  }
}
`
}

function buildProgramWrapper(source: string): string {
  return `
;(async () => {
${source}
})().then(
  (v) => __hostSettle(0, __serializeValue(v)),
  (e) => __hostSettle(1, __serializeValue({
    name: e && e.name ? e.name : 'Error',
    message: e && e.message ? e.message : String(e),
    toolName: e && e.toolName ? e.toolName : undefined
  }))
)
`
}

interface SettledOutcome {
  isError: boolean
  payload: string
}

/** QuickJS 异常 → 失败分类（内存超限归 limit_exceeded，其余执行错误） */
function classifyRuntimeError(err: unknown): { kind: 'limit_exceeded' | 'execution_error'; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  if (/memory overflow|out of memory|INTERNAL_LIMIT/i.test(message)) {
    return { kind: 'limit_exceeded', message: `沙箱内存超限（上限内无法完成计算）：${message}` }
  }
  return { kind: 'execution_error', message }
}

/**
 * evalCode 阶段的错误句柄 → 失败分类。dump() 可能返回 Error 形状对象，
 * 也可能返回 "Name: message" 形式的字符串（如 "InternalError: out of memory"）。
 */
function describeSandboxFailure(
  dumped: unknown,
  ctx: {
    isAborted: () => boolean
    timedOut: () => boolean
    maxSandboxTimeMs: number
  }
): { kind: RunCodeFailureKind; message: string } {
  let name = ''
  let message = ''
  if (typeof dumped === 'string') {
    const separator = dumped.indexOf(': ')
    if (separator > 0) {
      name = dumped.slice(0, separator)
      message = dumped.slice(separator + 2)
    } else {
      message = dumped
    }
  } else if (typeof dumped === 'object' && dumped !== null) {
    const record = dumped as { name?: unknown; message?: unknown }
    name = record.name !== undefined ? String(record.name) : ''
    message = record.message !== undefined ? String(record.message) : JSON.stringify(dumped)
  } else {
    message = String(dumped)
  }
  if (ctx.isAborted()) {
    return { kind: 'aborted', message: '执行已取消' }
  }
  if (ctx.timedOut()) {
    return { kind: 'limit_exceeded', message: `沙箱执行超时（上限 ${ctx.maxSandboxTimeMs}ms）` }
  }
  if (name === 'SyntaxError') {
    return { kind: 'parse_error', message }
  }
  if (/memory overflow|out of memory|INTERNAL_LIMIT/i.test(message) || /memory overflow/i.test(name)) {
    return { kind: 'limit_exceeded', message: `沙箱内存超限：${message}` }
  }
  return { kind: 'execution_error', message: name && name !== 'Error' ? `${name}: ${message}` : message }
}

/**
 * 在给定 QuickJS 模块上执行一次受限程序。每次调用使用全新 context，结束后销毁，
 * 不携带任何跨执行状态。
 */
export async function executeInQuickJsSandbox(
  module: QuickJSWASMModule,
  input: CodeRuntimeExecutionInput
): Promise<CodeRuntimeExecutionResult> {
  const limits: CodeRuntimeLimits = input.limits
  const sourceBytes = byteLength(input.source)
  if (sourceBytes > limits.maxSourceBytes) {
    return {
      status: 'failed',
      kind: 'limit_exceeded',
      message: `源码过大（${sourceBytes} 字节，上限 ${limits.maxSourceBytes}）`,
      logs: [],
      toolCallCount: 0
    }
  }
  const isAbortedProbe = (): boolean => input.signal?.aborted === true || input.isAborted?.() === true
  if (isAbortedProbe()) {
    return { status: 'failed', kind: 'aborted', message: '执行前已取消', logs: [], toolCallCount: 0 }
  }

  const context = module.newContext()
  const allowedTools = new Set(input.toolNames)
  const isAborted = isAbortedProbe
  const pendingRequests: CodeRuntimeToolCallRequest[] = []
  // settle 只在宿主回调内写入；容器形式避免 TS 把它收窄为 null
  const outcome: { settled: SettledOutcome | null } = { settled: null }
  let issuedCalls = 0
  let failure: { kind: RunCodeFailureKind; message: string } | null = null

  try {
    const deadline = Date.now() + limits.maxSandboxTimeMs
    const timedOut = () => Date.now() > deadline
    context.runtime.setMemoryLimit(limits.maxSandboxMemoryBytes)
    context.runtime.setInterruptHandler(() => isAborted() || timedOut())

    const hostToolCall = context.newFunction('__hostToolCall', (idHandle, nameHandle, argsHandle) => {
      pendingRequests.push({
        callId: context.getNumber(idHandle),
        toolName: context.getString(nameHandle),
        argsJson: context.getString(argsHandle)
      })
      return context.undefined
    })
    context.setProp(context.global, '__hostToolCall', hostToolCall)
    hostToolCall.dispose()

    const hostSettle = context.newFunction('__hostSettle', (isErrorHandle, payloadHandle) => {
      outcome.settled = {
        isError: context.getNumber(isErrorHandle) !== 0,
        payload: context.getString(payloadHandle)
      }
      return context.undefined
    })
    context.setProp(context.global, '__hostSettle', hostSettle)
    hostSettle.dispose()

    const glueResult = context.evalCode(buildGlueSource(input.toolNames))
    if (glueResult.error) {
      const dumped = context.dump(glueResult.error)
      glueResult.error.dispose()
      failure = describeSandboxFailure(dumped, { isAborted, timedOut, maxSandboxTimeMs: limits.maxSandboxTimeMs })
    } else {
      glueResult.value.dispose()
    }

    if (!failure) {
      const wrapperResult = context.evalCode(buildProgramWrapper(input.source))
      if (wrapperResult.error) {
        const dumped = context.dump(wrapperResult.error)
        wrapperResult.error.dispose()
        failure = describeSandboxFailure(dumped, { isAborted, timedOut, maxSandboxTimeMs: limits.maxSandboxTimeMs })
      } else {
        wrapperResult.value.dispose()
      }
    }

    const deliverHandle = failure ? null : context.getProp(context.global, '__deliverToolResult')
    try {
    /** 把一次工具结果送回沙箱（resolve/reject 的后续反应由 executePendingJobs 推进） */
      const deliver = (request: CodeRuntimeToolCallRequest, resolution: CodeRuntimeToolCallResolution): void => {
        if (!deliverHandle || !deliverHandle.alive) return
        const isError = !resolution.ok
        const payload = isError
          ? JSON.stringify({ toolName: request.toolName, message: resolution.errorMessage ?? '工具调用失败' })
          : resolution.resultJson ?? 'null'
        const idArg = context.newNumber(request.callId)
        const flagArg = context.newNumber(isError ? 1 : 0)
        const payloadArg = context.newString(payload)
        try {
          const callResult = context.callFunction(deliverHandle, context.undefined, idArg, flagArg, payloadArg)
          if (callResult.error) {
            callResult.error.dispose()
          } else {
            callResult.value.dispose()
          }
        } finally {
          idArg.dispose()
          flagArg.dispose()
          payloadArg.dispose()
        }
      }

      /** 以受限并发批量派发队列中的工具调用；任何一项完成即送回沙箱 */
      const drainQueue = async (batch: readonly CodeRuntimeToolCallRequest[]): Promise<void> => {
        let next = 0
        const workerCount = Math.max(1, Math.min(limits.maxToolConcurrency, batch.length))
        const runWorker = async (): Promise<void> => {
          while (next < batch.length && !failure) {
            if (isAborted()) {
              failure = { kind: 'aborted', message: '执行已取消' }
              return
            }
            if (timedOut()) {
              failure = { kind: 'limit_exceeded', message: `沙箱执行超时（上限 ${limits.maxSandboxTimeMs}ms）` }
              return
            }
            const request = batch[next++]
            if (issuedCalls >= limits.maxToolCalls) {
              failure = { kind: 'limit_exceeded', message: `工具调用次数超过上限（${limits.maxToolCalls}）` }
              return
            }
            if (!allowedTools.has(request.toolName)) {
              issuedCalls++
              deliver(request, {
                ok: false,
                errorMessage: `工具 ${request.toolName} 不在 code mode 可用清单中`
              })
              continue
            }
            const argsBytes = byteLength(request.argsJson)
            if (argsBytes > limits.maxToolInputBytes) {
              issuedCalls++
              deliver(request, {
                ok: false,
                errorMessage: `工具入参过大（${argsBytes} 字节，上限 ${limits.maxToolInputBytes}），请缩小参数`
              })
              continue
            }
            issuedCalls++
            let resolution: CodeRuntimeToolCallResolution
            try {
              resolution = await input.dispatchToolCall(request)
            } catch (err) {
              resolution = { ok: false, errorMessage: err instanceof Error ? err.message : String(err) }
            }
            if (failure) return
            if (resolution.ok && byteLength(resolution.resultJson ?? '') > limits.maxToolOutputBytes) {
              deliver(request, {
                ok: false,
                errorMessage: `工具输出过大（超过 ${limits.maxToolOutputBytes} 字节），请缩小读取范围（如 offset/limit/head_limit）后重试`
              })
            } else {
              deliver(request, resolution)
            }
          }
        }
        await Promise.all(Array.from({ length: workerCount }, () => runWorker()))
      }

      if (!failure) {
        const loopPromise = (async () => {
          while (!failure && !outcome.settled) {
            if (isAborted()) {
              failure = { kind: 'aborted', message: '执行已取消' }
              break
            }
            if (timedOut()) {
              failure = { kind: 'limit_exceeded', message: `沙箱执行超时（上限 ${limits.maxSandboxTimeMs}ms）` }
              break
            }
            let executedJobs = 0
            try {
              const jobsResult = context.runtime.executePendingJobs()
              if (isFail(jobsResult)) {
                const dumped = context.dump(jobsResult.error)
                jobsResult.error.dispose()
                failure = classifyRuntimeError(dumped)
                break
              }
              if (isSuccess(jobsResult)) {
                executedJobs = jobsResult.value
              }
            } catch (err) {
              failure = classifyRuntimeError(err)
              break
            }
            if (outcome.settled || failure) break
            if (pendingRequests.length > 0) {
              await drainQueue(pendingRequests.splice(0, pendingRequests.length))
              continue
            }
            if (executedJobs === 0) {
              // 没有待执行任务、没有在途工具调用且未 settle：程序在等待一个
              // 永远不会完成的 Promise（沙箱内没有定时器等宏任务来源）
              failure = {
                kind: 'execution_error',
                message: '程序在等待一个永远不会完成的 Promise（沙箱内没有定时器；只有 tools.* 调用可以等待）'
              }
              break
            }
          }
        })()

        const signal = input.signal
        const abortCleanup: { removeListener?: () => void } = {}
        let abortWait: Promise<void> | null = null
        if (signal) {
          // 中止提前结束宿主侧等待；阻塞中的沙箱执行由中断器切断，未 settle 的
          // 结果由下方 fallback 归类为 aborted
          if (signal.aborted) {
            abortWait = Promise.resolve()
          } else {
            abortWait = new Promise<void>(resolve => {
              const listener = (): void => resolve()
              signal.addEventListener('abort', listener, { once: true })
              abortCleanup.removeListener = () => signal.removeEventListener('abort', listener)
            })
          }
        }
        try {
          await (abortWait ? Promise.race([loopPromise, abortWait]) : loopPromise)
        } finally {
          abortCleanup.removeListener?.()
        }
      }

      // 收集 console 日志（即使失败也保留，便于模型自我修正）
      let logs: string[] = []
      try {
        const logsHandle = context.getProp(context.global, '__logs')
        const dumped = context.dump(logsHandle)
        logsHandle.dispose()
        if (Array.isArray(dumped)) {
          logs = dumped.map(entry => String(entry))
        }
      } catch {
        // 日志收集失败不改变执行结果语义
      }

      if (failure) {
        return { status: 'failed', kind: failure.kind, message: failure.message, logs, toolCallCount: issuedCalls }
      }
      if (!outcome.settled) {
        return {
          status: 'failed',
          kind: isAborted() ? 'aborted' : 'execution_error',
          message: isAborted() ? '执行已取消' : '程序未产生结果即结束',
          logs,
          toolCallCount: issuedCalls
        }
      }
      const settled = outcome.settled
      if (settled !== null && settled.isError) {
        let parsed: { name?: string; message?: string; toolName?: string } = {}
        try {
          parsed = JSON.parse(settled.payload) as typeof parsed
        } catch {
          parsed = { message: settled.payload }
        }
        const isToolError = parsed.name === 'ToolCallError' || typeof parsed.toolName === 'string'
        // async 包装会把同步阶段的异常转成 rejection：内存超限在这里同样要归类为资源上限
        const isMemoryLimit = !isToolError && /memory overflow|out of memory|INTERNAL_LIMIT/i.test(parsed.message ?? '')
        return {
          status: 'failed',
          kind: isToolError ? 'tool_failure' : isMemoryLimit ? 'limit_exceeded' : 'execution_error',
          message: isToolError
            ? `tools.${parsed.toolName ?? ''}: ${parsed.message ?? ''}`.trim()
            : `${parsed.name && parsed.name !== 'Error' ? `${parsed.name}: ` : ''}${parsed.message ?? ''}`,
          logs,
          toolCallCount: issuedCalls
        }
      }
      return {
        status: 'ok',
        valueJson: settled !== null && settled.payload === 'undefined' ? null : truncateUtf8(settled.payload, limits.maxModelOutputBytes),
        logs,
        toolCallCount: issuedCalls
      }
    } finally {
      deliverHandle?.dispose()
    }
  } finally {
    context.dispose()
  }
}
