/**
 * reasoning 字段协议观测。
 *
 * 部分 provider（Kimi 等）的 reasoning 字段名在不同端点存在变体：
 * 有的返回 reasoning_content，有的返回 reasoning。本模块观测响应实际使用的字段，
 * 回放历史时按观测到的字段写入，而非静态假设。
 *
 * 观测状态定为 client 实例级，且允许被后续响应覆盖。
 * 不写回 cacheProfile 静态表——那张表是声明式能力描述，写入运行时观测会让它承担两种职责。
 *
 * 已知局限（接受）：新建 client 实例会丢失观测，需一次请求重新学习；
 * 观测结果不跨进程持久化。
 */

/** 可观测的 reasoning 字段名 */
export type ObservedReasoningField = 'reasoning_content' | 'reasoning'

/**
 * 从一个 delta / message 载体中观测 reasoning 字段。
 * reasoning_content 优先于 reasoning，与 usage 归一化及增量发射顺序一致。
 * 载体形状不符或字段非字符串时返回 undefined（不抛异常）。
 */
export function observeReasoningField(carrier: unknown): ObservedReasoningField | undefined {
  if (typeof carrier !== 'object' || carrier === null) return undefined
  const obj = carrier as Record<string, unknown>
  if (typeof obj.reasoning_content === 'string') return 'reasoning_content'
  if (typeof obj.reasoning === 'string') return 'reasoning'
  return undefined
}
