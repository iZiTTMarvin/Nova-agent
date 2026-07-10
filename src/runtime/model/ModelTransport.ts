/**
 * ModelTransport — 模型 HTTP/SSE 传输边界（长任务阶段 1）
 *
 * 职责：
 * - 组合用户取消信号 + attempt 级 AbortController
 * - 建连、首个语义事件、语义事件间 idle 三类 timeout（可选总时长默认关闭）
 * - 将 HTTP/body/SSE/idle 错误规范化为可分类错误字符串
 * - timeout / 异常后取消 reader、清理 timer，不留残留
 *
 * 禁止：只在 fetch 外层套固定总时长 Promise.race（无法区分正常长回复与真空闲）。
 */
import type { ChatEvent } from './types'

/** 规范化错误类别（写入 ChatEvent.error 文本，供 Recovery 匹配） */
export type TransportErrorClass =
  | 'cancelled'
  | 'timeout_connect'
  | 'timeout_first_byte'
  | 'timeout_idle'
  | 'network_reset'
  | 'http_retryable'
  | 'http_fatal'

/** Transport 超时配置（毫秒） */
export interface ModelTransportTimeouts {
  /** 建连/等待响应头 */
  connectMs: number
  /** 响应头已到、等待首个模型语义事件 */
  firstByteMs: number
  /** 两个模型语义事件之间的空闲上限 */
  idleMs: number
  /** 可选总时长；undefined/0 = 不启用（避免误杀正常长回复） */
  totalMs?: number
}

/** 默认超时：足够覆盖慢网，又不会无限挂死 */
export const DEFAULT_TRANSPORT_TIMEOUTS: ModelTransportTimeouts = {
  connectMs: 30_000,
  firstByteMs: 60_000,
  idleMs: 90_000
  // totalMs 故意不设
}

/** fetch 请求参数（与 fetch 对齐的子集） */
export interface TransportFetchInit {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** 用户取消信号（与 attempt 信号合并） */
  userSignal?: AbortSignal
  timeouts?: Partial<ModelTransportTimeouts>
}

/** 单次 read 结果 */
export interface TransportReadResult {
  done: boolean
  value?: Uint8Array
}

/** 同一次模型请求共享的 transport 状态，负责统一回收计时器与取消监听。 */
export class TransportAttempt {
  readonly controller = new AbortController()
  private readonly userSignal?: AbortSignal
  private readonly onUserAbort: () => void
  private totalTimer: ReturnType<typeof setTimeout> | null = null
  private closed = false

  constructor(userSignal: AbortSignal | undefined, totalMs: number | undefined) {
    this.userSignal = userSignal
    this.onUserAbort = () => this.controller.abort()
    if (userSignal) {
      if (userSignal.aborted) this.controller.abort()
      else userSignal.addEventListener('abort', this.onUserAbort, { once: true })
    }
    if (totalMs && totalMs > 0) {
      // 总时长覆盖 headers 与整个 body，不能在 fetch 返回后提前清除。
      this.totalTimer = setTimeout(() => this.controller.abort(), totalMs)
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get cancelledByUser(): boolean {
    return Boolean(this.userSignal?.aborted)
  }

  /** 结束 attempt，释放总时长 timer 与用户取消监听。幂等。 */
  dispose(): void {
    if (this.closed) return
    this.closed = true
    if (this.totalTimer) clearTimeout(this.totalTimer)
    this.totalTimer = null
    this.userSignal?.removeEventListener('abort', this.onUserAbort)
  }

  abort(): void {
    this.controller.abort()
  }
}

/** transportFetch 成功后必须由响应体消费者调用 attempt.dispose()。 */
export interface TransportFetchResult {
  response: Response
  attempt: TransportAttempt
}

/**
 * 格式化分类错误：前缀带类别名，便于 RecoveryStateMachine / FallbackDecider 匹配。
 * 例：`timeout_connect: 建连超时（30000ms）`
 */
export function formatTransportError(cls: TransportErrorClass, detail: string): string {
  return `${cls}: ${detail}`
}

/** 从未知错误推断类别 */
export function classifyThrownError(err: unknown): TransportErrorClass {
  if ((err as Error)?.name === 'AbortError') return 'cancelled'
  const msg = String((err as Error)?.message ?? err ?? '')
  const code = String((err as NodeJS.ErrnoException)?.code ?? '')
  if (/ECONNRESET/i.test(msg) || /ECONNRESET/i.test(code) || /network_reset/i.test(msg)) {
    return 'network_reset'
  }
  if (/timeout_connect/i.test(msg)) return 'timeout_connect'
  if (/timeout_first_byte|first.?byte/i.test(msg)) return 'timeout_first_byte'
  if (/timeout_idle|idle/i.test(msg)) return 'timeout_idle'
  if (/timeout/i.test(msg)) return 'timeout_idle'
  return 'network_reset'
}

/**
 * 带超时的 Promise：超时则 abort attemptController 并抛分类错误。
 * 注意：超时后必须 abort，才能打断底层 fetch/reader。
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  attempt: AbortController,
  cls: TransportErrorClass,
  detail: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      attempt.abort()
      reject(new Error(formatTransportError(cls, detail)))
    }, ms)
    promise.then(
      v => {
        clearTimeout(timer)
        resolve(v)
      },
      err => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

/**
 * 执行一次带 liveness 的 fetch，返回 Response。
 * 建连超时后 abort attempt，不留悬挂 fetch。
 */
export async function transportFetch(init: TransportFetchInit): Promise<TransportFetchResult> {
  const timeouts = { ...DEFAULT_TRANSPORT_TIMEOUTS, ...init.timeouts }
  const attempt = new TransportAttempt(init.userSignal, timeouts.totalMs)

  try {
    const response = await withTimeout(
      fetch(init.url, {
        method: init.method ?? 'POST',
        headers: init.headers,
        body: init.body,
        signal: attempt.signal
      }),
      timeouts.connectMs,
      attempt,
      'timeout_connect',
      `建连超时（${timeouts.connectMs}ms）`
    )
    return { response, attempt }
  } catch (err) {
    attempt.dispose()
    if (attempt.cancelledByUser || (err as Error)?.name === 'AbortError') {
      // 用户取消优先
      if (attempt.cancelledByUser) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    }
    const cls = classifyThrownError(err)
    if (cls === 'timeout_connect' || /timeout_connect/.test(String((err as Error)?.message))) {
      throw err
    }
    if ((err as Error)?.name === 'AbortError') {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    }
    throw new Error(formatTransportError(cls, (err as Error)?.message ?? String(err)))
  }
}

/**
 * 带语义首事件 / 语义 idle watchdog 的 SSE body 读取器。
 *
 * 每次 read()：
 * - 尚未看到模型语义事件 → firstByte 超时（字段名为兼容旧配置保留）
 * - 已看到语义事件 → idle 超时
 * 超时后 cancel reader + abort attempt，抛分类错误。
 */
export class TransportBodyReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>
  private readonly attempt: TransportAttempt
  private readonly userSignal?: AbortSignal
  private readonly firstByteMs: number
  private readonly idleMs: number
  private sawSemanticEvent = false
  private closed = false
  private semanticTimer: ReturnType<typeof setTimeout> | null = null
  private semanticFailure: Error | null = null
  private rejectSemanticFailure: ((reason: Error) => void) | null = null
  private readonly semanticFailurePromise: Promise<never>
  private readonly onUserAbort = (): void => {
    // 某些 mock/自定义 ReadableStream 不会响应 fetch signal，需主动释放 reader。
    void this.cancel()
  }

  constructor(
    body: ReadableStream<Uint8Array>,
    opts: {
      userSignal?: AbortSignal
      timeouts?: Partial<ModelTransportTimeouts>
      /** 外部注入的 attempt（与 fetch 共用） */
      attempt?: TransportAttempt
    }
  ) {
    const timeouts = { ...DEFAULT_TRANSPORT_TIMEOUTS, ...opts.timeouts }
    this.reader = body.getReader()
    this.attempt = opts.attempt ?? new TransportAttempt(opts.userSignal, timeouts.totalMs)
    this.userSignal = opts.userSignal
    this.firstByteMs = timeouts.firstByteMs
    this.idleMs = timeouts.idleMs

    this.semanticFailurePromise = new Promise<never>((_, reject) => {
      this.rejectSemanticFailure = reject
    })
    if (opts.userSignal) {
      if (opts.userSignal.aborted) void this.cancel()
      else opts.userSignal.addEventListener('abort', this.onUserAbort, { once: true })
    }
    this.armSemanticTimer()
  }

  /**
   * 仅在已解析到 content/reasoning/tool call/finish/error 时调用。
   * SSE 注释、ping、keepalive、空行和非语义 JSON 都不能调用本方法。
   */
  markSemanticEvent(): void {
    if (this.closed) return
    this.sawSemanticEvent = true
    this.armSemanticTimer()
  }

  private armSemanticTimer(): void {
    if (this.semanticTimer) clearTimeout(this.semanticTimer)
    const timeoutMs = this.sawSemanticEvent ? this.idleMs : this.firstByteMs
    const cls: TransportErrorClass = this.sawSemanticEvent ? 'timeout_idle' : 'timeout_first_byte'
    const detail = this.sawSemanticEvent
      ? `模型语义事件空闲超时（${timeoutMs}ms）`
      : `首个模型语义事件超时（${timeoutMs}ms）`
    this.semanticTimer = setTimeout(() => {
      const failure = new Error(formatTransportError(cls, detail))
      this.semanticFailure = failure
      this.attempt.abort()
      this.rejectSemanticFailure?.(failure)
      void this.cancelReader()
    }, timeoutMs)
  }

  /** 读取下一块；超时/网络错误抛分类 Error */
  async read(): Promise<TransportReadResult> {
    if (this.closed) return { done: true }
    if (this.attempt.cancelledByUser) {
      await this.cancel()
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    }

    try {
      const result = await Promise.race([this.reader.read(), this.semanticFailurePromise])
      if (result.done) {
        this.closed = true
        this.clearSemanticTimer()
        this.attempt.dispose()
        return { done: true }
      }
      return { done: false, value: result.value }
    } catch (err) {
      await this.cancel()
      if (this.attempt.cancelledByUser) {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      }
      const msg = String((err as Error)?.message ?? err)
      // 已是分类错误则原样抛出
      if (/^timeout_|^network_reset:/.test(msg)) throw err
      const thrownCls = classifyThrownError(err)
      throw new Error(formatTransportError(thrownCls, msg))
    }
  }

  /** 取消 reader 并标记关闭（幂等） */
  async cancel(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearSemanticTimer()
    this.removeUserAbortListener()
    this.attempt.dispose()
    this.attempt.abort()
    await this.cancelReader()
  }

  private async cancelReader(): Promise<void> {
    try {
      await this.reader.cancel()
    } catch {
      /* ignore */
    }
    try {
      this.reader.releaseLock()
    } catch {
      /* ignore */
    }
  }

  /** 正常结束时释放锁 */
  release(): void {
    if (this.closed) return
    this.closed = true
    this.clearSemanticTimer()
    this.removeUserAbortListener()
    this.attempt.dispose()
    try {
      this.reader.releaseLock()
    } catch {
      /* ignore */
    }
  }

  private clearSemanticTimer(): void {
    if (this.semanticTimer) clearTimeout(this.semanticTimer)
    this.semanticTimer = null
  }

  private removeUserAbortListener(): void {
    this.userSignal?.removeEventListener('abort', this.onUserAbort)
  }
}

/** 非 2xx 响应体的安全读取上限，避免错误页无限流耗尽 attempt。 */
const MAX_ERROR_BODY_BYTES = 64 * 1024

/**
 * 读取非 2xx 错误体。它使用独立 timer 与大小上限，不依赖 response.text()，
 * 因而错误服务端持续挂起或无限输出时也能释放 reader 和 attempt。
 */
export async function readErrorResponseBody(
  response: Response,
  attempt: TransportAttempt,
  timeouts?: Partial<ModelTransportTimeouts>
): Promise<string> {
  const body = response.body
  if (!body) {
    attempt.dispose()
    return 'unknown'
  }
  const reader = body.getReader()
  const timeoutMs = Math.min(10_000, { ...DEFAULT_TRANSPORT_TIMEOUTS, ...timeouts }.firstByteMs)
  let timer: ReturnType<typeof setTimeout> | null = null
  let bytes = 0
  const chunks: Uint8Array[] = []
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        attempt.abort()
        reject(new Error('错误响应体读取超时'))
      }, timeoutMs)
    })
    while (true) {
      const result = await Promise.race([reader.read(), timeout])
      if (result.done) break
      if (!result.value) continue
      bytes += result.value.byteLength
      if (bytes > MAX_ERROR_BODY_BYTES) throw new Error('错误响应体超过最大字节数')
      chunks.push(result.value)
    }
    return new TextDecoder().decode(concatChunks(chunks, bytes))
  } catch {
    return 'unknown'
  } finally {
    if (timer) clearTimeout(timer)
    try {
      await reader.cancel()
    } catch {
      /* 忽略已关闭 reader */
    }
    try {
      reader.releaseLock()
    } catch {
      /* 忽略已释放锁 */
    }
    attempt.dispose()
  }
}

function concatChunks(chunks: Uint8Array[], bytes: number): Uint8Array {
  const output = new Uint8Array(bytes)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

/**
 * 将 transport 层异常转为 ChatEvent（供 ModelClient yield）。
 * 用户取消 → cancelled；其余 → error（带分类前缀）。
 */
export function transportErrorToChatEvent(err: unknown): ChatEvent {
  if ((err as Error)?.name === 'AbortError' || classifyThrownError(err) === 'cancelled') {
    return { type: 'cancelled' }
  }
  const msg = String((err as Error)?.message ?? err)
  if (/^timeout_|^network_reset:|^http_/.test(msg)) {
    return { type: 'error', error: msg }
  }
  const cls = classifyThrownError(err)
  return { type: 'error', error: formatTransportError(cls, msg) }
}

/** HTTP 状态码 → 分类错误文本 */
export function httpStatusToError(status: number, bodyText: string): string {
  const retryable = status === 429 || (status >= 500 && status < 600)
  const cls: TransportErrorClass = retryable ? 'http_retryable' : 'http_fatal'
  return formatTransportError(cls, `API 错误 ${status}: ${bodyText}`)
}
