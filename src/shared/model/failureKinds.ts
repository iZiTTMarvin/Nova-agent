/**
 * 模型失败分类的跨进程呈现契约。
 *
 * ModelFailure 结构化对象止步于 runtime（重试决策消费）；终态错误以字符串
 * 穿越 IPC 与落盘边界。为了让展示侧不靠正则猜分类，终态字符串携带
 * `ModelFailure:<kind>:` 前缀，由本模块统一编解码。kind 的唯一权威定义在此，
 * runtime 的 failureTypes 与展示侧翻译表都从这里取。
 */

export type ModelFailureKind =
  | 'network'
  | 'rate_limit'
  | 'timeout'
  | 'auth'
  | 'context_overflow'
  | 'provider_unavailable'
  | 'provider_billing'
  | 'unknown'

export const MODEL_FAILURE_KINDS: readonly ModelFailureKind[] = [
  'network',
  'rate_limit',
  'timeout',
  'auth',
  'context_overflow',
  'provider_unavailable',
  'provider_billing',
  'unknown'
]

export const MODEL_FAILURE_ERROR_PREFIX = 'ModelFailure:'

export function isModelFailureKind(value: string): value is ModelFailureKind {
  return (MODEL_FAILURE_KINDS as readonly string[]).includes(value)
}

/** 终态错误字符串编码：`ModelFailure:<kind>:<原始文本>` */
export function encodeModelFailureError(kind: ModelFailureKind, message: string): string {
  return `${MODEL_FAILURE_ERROR_PREFIX}${kind}:${message}`
}

export interface ParsedModelFailureError {
  kind: ModelFailureKind
  message: string
}

/** 解析终态错误字符串里的分类前缀；非本协议文本返回 null。 */
export function parseModelFailureError(error: string): ParsedModelFailureError | null {
  if (!error.startsWith(MODEL_FAILURE_ERROR_PREFIX)) return null
  const rest = error.slice(MODEL_FAILURE_ERROR_PREFIX.length)
  const colon = rest.indexOf(':')
  if (colon <= 0) return null
  const kind = rest.slice(0, colon)
  if (!isModelFailureKind(kind)) return null
  return { kind, message: rest.slice(colon + 1) }
}
