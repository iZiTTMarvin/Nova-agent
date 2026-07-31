/**
 * 子 agent 输出的归一化原语。
 *
 * 职责单一：把 `host.agent()` 返回的 `AgentResult`（模型输出，本质是 unknown）
 * 在 definition 边界收敛成确定形状，再交给各 workflow 的领域类型。
 * 模型即使拿到 schema 也会偶发漏字段或改字段名，所有归一化必须在这里过一遍，
 * 不允许在领域逻辑里直接 `as` 断言。
 *
 * 消费者：definitions/ 下各 workflow 的阶段函数。本文件不持有状态、不做业务判断，
 * 也不感知任何具体 workflow。
 *
 * 注：compose/ 下的阶段函数目前各自持有同名局部实现，属于先于本文件存在的重复债务，
 * 应在触碰 compose 阶段代码时逐步收敛到这里，不为整理而单独重构。
 */

/** 仅接受纯对象；数组和 null 一律视为非法结构 */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** 空串与纯空白视为缺失，避免把 "" 当成有效答案写进领域状态 */
export function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

/** 取第一个命中的枚举值；模型返回未知取值时返回 null 而不是回退到默认档 */
export function asEnum<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

/** 截断长文本用于提示词或证据字段，保留可读边界标记 */
export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false }
  return { text: `${text.slice(0, maxChars)}…`, truncated: true }
}
