/** 可安全跨工具桥和 QuickJS 传输的数据；结构化结果不直接持久化到对话。 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue }

/** 外部结构化输出先按 unknown 进入，通过此检查后才能跨工具桥传输。 */
export function isJsonValue(value: unknown): value is JsonValue {
  return inspect(value, new Set<object>())
}

function inspect(value: unknown, seen: Set<object>): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  const valid = Array.isArray(value)
    ? value.every(item => inspect(item, seen))
    : Object.values(value as Record<string, unknown>).every(item => inspect(item, seen))
  seen.delete(value)
  return valid
}

/** 命令退出事实独立于工具调用是否成功；后台启动不代表命令退出。 */
export type ToolProcessOutcome =
  | { state: 'running' | 'unconfirmed' }
  | { state: 'exited'; exitCode: number | null }

/** 大输出截断元数据（工具 / 事件 / 持久化共用） */
export interface ToolTruncationMeta {
  totalBytes: number
  totalLines: number
  shownLines?: number
  truncated: boolean
}
/** 工具返回的图片正文；持久化保留当时的字节，不重新读取可变工作区文件。 */
export interface ImageContent {
  data: string
  mimeType: string
}
