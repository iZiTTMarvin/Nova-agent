/**
 * ModelTransport — 模型 HTTP/SSE 传输边界（长任务）
 *
 * 职责：
 * - 组合用户取消信号 + attempt 级 AbortController
 * - 建连、首个语义事件、语义事件间 idle 三类 timeout（可选总时长默认关闭）
 * - 将 HTTP/body/SSE/idle 错误规范化为可分类错误字符串
 * - timeout / 异常后取消 reader、清理 timer，不留残留
 *
 * 禁止：只在 fetch 外层套固定总时长 Promise.race（无法区分正常长回复与真空闲）。
 */
import type { ChatEvent, TransportFetchImpl } from './types'
import type { ModelFailure, ModelFailureKind } from './failureTypes'
import {
  createTransportTiming,
  type TransportOutcome,
  type TransportTiming
} from './transportObservation'

/** 规范化错误类别（写入 ChatEvent.error 文本，供 Recovery 匹配） */
export type TransportErrorClass =
  | 'cancelled'
  | 'timeout_connect'
  | 'timeout_first_byte'
  | 'timeout_idle'
  | 'timeout_total'
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
  /** 自定义传输实现（headless 代理注入）；缺省使用全局 fetch */
  fetchImpl?: TransportFetchImpl
  /**
   * 派发前交出本次物理 attempt 句柄，供调用方记录观测。
   * 纯观测钩子：不改变超时、取消与错误语义；派发失败时调用方仍能拿到已 settle 的 attempt。
   */
  onAttempt?: (attempt: TransportAttempt) => void
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
  /** 本地时序；只由本 attempt 单调填入，阶段未发生时保持 null */
  private readonly timing: TransportTiming
  private outcome: TransportOutcome | null = null

  constructor(userSignal: AbortSignal | undefined, totalMs: number | undefined) {
    this.timing = createTransportTiming(performance.timeOrigin + performance.now())
    this.userSignal = userSignal
    this.onUserAbort = () => this.abort()
    if (userSignal) {
      if (userSignal.aborted) this.abort()
      else userSignal.addEventListener('abort', this.onUserAbort, { once: true })
    }
    if (totalMs && totalMs > 0) {
      // 总时长覆盖 headers 与整个 body；abort reason 带 timeout_total，避免误判 cancelled
      this.totalTimer = setTimeout(() => {
        this.timing.abortRequestedAt ??= performance.timeOrigin + performance.now()
        this.controller.abort(
          new Error(formatTransportError('timeout_total', `总时长超时（${totalMs}ms）`))
        )
      }, totalMs)
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal
  }

  get cancelledByUser(): boolean {
    return Boolean(this.userSignal?.aborted)
  }

  /** 响应对象已到（响应头可用）。首次调用生效，不覆盖更早的时间戳。 */
  markHeaders(): void {
    if (this.timing.headersAt === null) this.timing.headersAt = performance.timeOrigin + performance.now()
  }

  /**
   * 记录一次模型语义事件。只有协议层真正解析到语义时才调用；
   * SSE comment / keepalive / role / usage 都不算语义进展。
   */
  markSemantic(): void {
    const now = performance.timeOrigin + performance.now()
    if (this.timing.firstSemanticAt === null) this.timing.firstSemanticAt = now
    this.timing.lastSemanticAt = now
  }

  /**
   * 记录本地终态。首次调用生效：终态唯一，后来的清理不得改写已确定的结局。
   * 本地 settle 不代表供应商已停止生成或停止计费。
   */
  settle(outcome: TransportOutcome): void {
    if (this.outcome !== null) return
    this.outcome = outcome
    this.timing.settledAt = performance.timeOrigin + performance.now()
  }

  /** 当前时序快照（只读投影） */
  getTiming(): TransportTiming {
    return { ...this.timing }
  }

  /** 当前本地终态；尚未 settle 时为 null */
  getOutcome(): TransportOutcome | null {
    return this.outcome
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
    this.timing.abortRequestedAt ??= performance.timeOrigin + performance.now()
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
  const msg = String((err as Error)?.message ?? err ?? '')
  const reasonMsg = String((err as { cause?: unknown })?.cause ?? (err as { reason?: unknown })?.reason ?? '')
  const combined = `${msg} ${reasonMsg}`

  if (/timeout_total/i.test(combined)) return 'timeout_total'
  if ((err as Error)?.name === 'AbortError') {
    return 'cancelled'
  }
  const code = String((err as NodeJS.ErrnoException)?.code ?? '')
  if (/ECONNRESET/i.test(combined) || /ECONNRESET/i.test(code) || /network_reset/i.test(combined)) {
    return 'network_reset'
  }
  if (/timeout_connect/i.test(combined)) return 'timeout_connect'
  if (/timeout_first_byte|first.?byte/i.test(combined)) return 'timeout_first_byte'
  if (/timeout_idle|idle/i.test(combined)) return 'timeout_idle'
  if (/timeout/i.test(combined)) return 'timeout_idle'
  return 'network_reset'
}

/**
 * 带超时的 Promise：超时则 abort attemptController 并抛分类错误。
 * 注意：超时后必须 abort，才能打断底层 fetch/reader。
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  attempt: TransportAttempt,
  cls: TransportErrorClass,
  detail: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      cleanup()
      reject(attempt.signal.reason ?? Object.assign(new Error('cancelled'), { name: 'AbortError' }))
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      attempt.signal.removeEventListener('abort', onAbort)
    }
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(formatTransportError(cls, detail)))
      attempt.abort()
    }, ms)
    if (attempt.signal.aborted) onAbort()
    else attempt.signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      v => {
        cleanup()
        resolve(v)
      },
      err => {
        cleanup()
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
  init.onAttempt?.(attempt)

  try {
    const doFetch = init.fetchImpl ?? fetch
    if (attempt.signal.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    const response = await withTimeout(
      doFetch(init.url, {
        method: init.method ?? 'POST',
        headers: init.headers,
        body: init.body,
        signal: attempt.signal
      }).then(response => {
        if (attempt.signal.aborted) {
          void response.body?.cancel().catch(() => {})
          throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
        }
        return response
      }),
      timeouts.connectMs,
      attempt,
      'timeout_connect',
      `建连超时（${timeouts.connectMs}ms）`
    )
    attempt.markHeaders()
    return { response, attempt }
  } catch (err) {
    attempt.settle(attempt.cancelledByUser ? 'cancelled' : 'transport_error')
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
    this.semanticFailure ??= this.attempt.cancelledByUser
      ? Object.assign(new Error('cancelled'), { name: 'AbortError' })
      : this.attempt.signal.reason instanceof Error ? this.attempt.signal.reason : new Error('network_reset: request aborted')
    this.rejectSemanticFailure?.(this.semanticFailure)
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
    // 消费者可以停在 yield 处；watchdog 拒绝仍需有接收者。
    void this.semanticFailurePromise.catch(() => {})
    if (this.attempt.signal.aborted) this.onUserAbort()
    else this.attempt.signal.addEventListener('abort', this.onUserAbort, { once: true })
    this.armSemanticTimer()
  }

  /**
   * 仅在已解析到 content/reasoning/tool call/finish/error 时调用。
   * SSE 注释、ping、keepalive、空行和非语义 JSON 都不能调用本方法。
   */
  markSemanticEvent(): void {
    if (this.closed) return
    this.sawSemanticEvent = true
    this.attempt.markSemantic()
    this.armSemanticTimer()
  }

  private armSemanticTimer(): void {
    if (this.closed) return
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
    if (this.semanticFailure) throw this.semanticFailure
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
        this.removeUserAbortListener()
        this.reader.releaseLock()
        this.attempt.settle(this.attempt.cancelledByUser ? 'cancelled' : 'completed')
        this.attempt.dispose()
        return { done: true }
      }
      return { done: false, value: result.value }
    } catch (err) {
      await this.cancel()
      if (this.attempt.cancelledByUser) {
        throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
      }
      if (this.semanticFailure) throw this.semanticFailure
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
    this.attempt.settle(this.attempt.cancelledByUser ? 'cancelled' : 'transport_error')
    void this.cancelReader()
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
    // 走到这里说明流没有以 EOF 收尾：用户取消记 cancelled，其余记 abandoned（远端结果未知）
    this.attempt.settle(this.attempt.cancelledByUser ? 'cancelled' : 'abandoned')
    this.attempt.dispose()
    this.attempt.abort()
    void this.cancelReader()
  }

  private clearSemanticTimer(): void {
    if (this.semanticTimer) clearTimeout(this.semanticTimer)
    this.semanticTimer = null
  }

  private removeUserAbortListener(): void {
    this.attempt.signal.removeEventListener('abort', this.onUserAbort)
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
    attempt.settle('http_error')
    attempt.dispose()
    return 'unknown'
  }
  const reader = body.getReader()
  const timeoutMs = Math.min(10_000, { ...DEFAULT_TRANSPORT_TIMEOUTS, ...timeouts }.firstByteMs)
  let timer: ReturnType<typeof setTimeout> | null = null
  let bytes = 0
  const chunks: Uint8Array[] = []
  let rejectAbort: (reason: unknown) => void = () => {}
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = (): void => rejectAbort(attempt.signal.reason ?? Object.assign(new Error('cancelled'), { name: 'AbortError' }))
  if (attempt.signal.aborted) onAbort()
  else attempt.signal.addEventListener('abort', onAbort, { once: true })
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        attempt.abort()
        reject(new Error('错误响应体读取超时'))
      }, timeoutMs)
    })
    while (true) {
      const result = await Promise.race([reader.read(), timeout, aborted])
      if (result.done) break
      if (!result.value) continue
      bytes += result.value.byteLength
      if (bytes > MAX_ERROR_BODY_BYTES) throw new Error('错误响应体超过最大字节数')
      chunks.push(result.value)
    }
    return new TextDecoder().decode(concatChunks(chunks, bytes))
  } catch {
    if (attempt.cancelledByUser) throw Object.assign(new Error('cancelled'), { name: 'AbortError' })
    return 'unknown'
  } finally {
    if (timer) clearTimeout(timer)
    attempt.signal.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => {})
    try {
      reader.releaseLock()
    } catch {
      /* 忽略已释放锁 */
    }
    attempt.settle(attempt.cancelledByUser ? 'cancelled' : 'http_error')
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
 * 用户取消 → cancelled；其余 → error（携带结构化 failure，供重试决策消费）。
 */
export function transportErrorToChatEvent(err: unknown): ChatEvent {
  const cls = classifyThrownError(err)
  if (cls === 'cancelled') {
    return { type: 'cancelled' }
  }
  const msg = String((err as Error)?.message ?? err)
  const failure = thrownToFailure(cls, msg)
  return { type: 'error', error: failure.message, failure }
}


/** TransportErrorClass（含超时/网络子类）→ ModelFailureKind */
function thrownFailureKind(cls: TransportErrorClass): ModelFailureKind {
  switch (cls) {
    case 'timeout_connect':
    case 'timeout_first_byte':
    case 'timeout_idle':
    case 'timeout_total':
      return 'timeout'
    case 'network_reset':
      return 'network'
    default:
      return 'unknown'
  }
}

/** 把抛出的 transport 异常归一化为结构化失败 */
export function thrownToFailure(cls: TransportErrorClass, message: string): ModelFailure {
  // cancelled 不应进入失败路径（调用方已先行返回 cancelled 事件）
  const kind = thrownFailureKind(cls)
  return { kind, retryable: false, dispatchOutcome: 'unknown',
    message: `${message}；请求可能已送达，远端结果与费用未知，已停止自动重试。` }
}

/**
 * HTTP 状态码 → 结构化失败。
 * 429 → rate_limit；5xx → provider_unavailable；401/403 → auth；
 * 402 → provider_billing；其余 4xx → 不可重试 unknown。
 * Retry-After 头（429/503）解析为 retryAfterMs，存在时由调用方覆盖指数退避。
 */
export function httpStatusToFailure(
  status: number,
  bodyText: string,
  headers?: Headers
): ModelFailure {
  const requestId = readRequestId(headers)
  const message = formatTransportError(
    httpErrorClass(status),
    `API 错误 ${status}: ${bodyText}`
  )
  let kind: ModelFailureKind
  let retryable: boolean
  if (status === 429) {
    kind = 'rate_limit'
    retryable = true
  } else if (status === 503 || status === 502 || status === 504) {
    kind = 'provider_unavailable'
    retryable = true
  } else if (status >= 500 && status < 600) {
    kind = 'provider_unavailable'
    retryable = true
  } else if (status === 401 || status === 403) {
    kind = 'auth'
    retryable = false
  } else if (status === 402) {
    kind = 'provider_billing'
    retryable = false
  } else {
    kind = 'unknown'
    retryable = false
  }
  const retryAfterMs = parseRetryAfter(headers)
  const failure: ModelFailure = { kind, retryable, message }
  if (retryAfterMs !== undefined) failure.retryAfterMs = retryAfterMs
  if (requestId !== undefined) failure.requestId = requestId
  return failure
}

/** HTTP 状态码 → transport 错误类（用于消息前缀） */
function httpErrorClass(status: number): TransportErrorClass {
  const retryable = status === 429 || (status >= 500 && status < 600)
  return retryable ? 'http_retryable' : 'http_fatal'
}

/** 读取网关请求 id，仅诊断用 */
function readRequestId(headers?: Headers): string | undefined {
  if (!headers) return undefined
  return headers.get('x-request-id') ?? headers.get('request-id') ?? undefined
}

/**
 * 解析 Retry-After 头（RFC 7231）。
 * 支持两种格式：秒数（`120`）与 HTTP-date（`Wed, 21 Oct 2026 07:28:00 GMT`）。
 * 解析失败或为负/过大（>1h，避免网关异常值导致长时间冻结）时返回 undefined。
 */
export function parseRetryAfter(headers?: Headers): number | undefined {
  if (!headers) return undefined
  const raw = headers.get('retry-after')
  if (!raw) return undefined

  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds >= 0) {
    const ms = Math.ceil(seconds * 1000)
    return ms <= MAX_RETRY_AFTER_MS ? ms : undefined
  }

  const dateMs = Date.parse(raw.trim())
  if (!Number.isNaN(dateMs)) {
    const ms = Math.ceil(dateMs - Date.now())
    if (ms <= 0) return 0
    return ms <= MAX_RETRY_AFTER_MS ? ms : undefined
  }
  return undefined
}

/** Retry-After 上界：超过 1h 视为网关异常值，忽略以退回指数退避 */
const MAX_RETRY_AFTER_MS = 60 * 60 * 1000
