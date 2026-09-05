/**
 * 结构化模型失败契约。
 *
 * transport 层（ModelTransport / OpenAICompatibleModelClient）把 HTTP 状态码、
 * 抛出异常和网关头解析成 ModelFailure；重试决策（RecoveryStateMachine /
 * AttemptController）只消费这个结构化对象，不再对错误字符串做正则。
 *
 * 字符串分类（正则）仍保留在 transport 与 recovery 的边界归一化里，
 * 作为把「无 failure 伴随的旧字符串错误」补齐成 ModelFailure 的手段，
 * 但它不是重试决策的依据——决策只读 retryable / retryAfterMs / kind。
 */

/** 失败大类。按同一形态归一化各 provider 差异，供重试决策消费。 */
export type ModelFailureKind =
  | 'network'
  | 'rate_limit'
  | 'timeout'
  | 'auth'
  | 'context_overflow'
  | 'provider_unavailable'
  | 'provider_billing'
  | 'unknown'

/**
 * 单次模型尝试的结构化失败。
 * 重试门闩只依赖 retryable + 调用方传入的 hasNoObservableOutput；
 * retryAfterMs 来自 Retry-After 头，存在时覆盖指数退避。
 */
export interface ModelFailure {
  /** 请求可能已被接收，远端生成结果与费用无法确认。 */
  dispatchOutcome?: 'unknown'
  kind: ModelFailureKind
  retryable: boolean
  /** provider 通过 Retry-After 头要求的下次重试延迟（毫秒）；存在时覆盖指数退避 */
  retryAfterMs?: number
  /** 网关请求 id（x-request-id），仅诊断用，不影响决策 */
  requestId?: string
  /** 面向用户/日志的展示文本，也是兼容旧 error 事件字符串的字段 */
  message: string
}
