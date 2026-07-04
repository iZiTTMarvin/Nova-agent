/**
 * 沙箱边界 marshaling：只允许纯 JSON 数据跨边界，杜绝 AgentLoop / 函数引用泄漏。
 */

/** 将 host 值拷贝为纯数据；不可序列化则抛错 */
export function marshalOut(value: unknown): unknown {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  // 函数 / symbol / bigint 等不可过边界
  if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    throw new Error('workflow marshal: non-JSON value cannot cross sandbox boundary')
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    throw new Error('workflow marshal: value is not JSON-serializable')
  }
}

/** 注入脚本前把 args 变成纯数据 */
export function marshalIn(value: unknown): unknown {
  if (value === undefined) return null
  return marshalOut(value)
}

/** 断言值可被 JSON.stringify（单测用） */
export function assertPlainData(value: unknown): void {
  JSON.stringify(value)
}
