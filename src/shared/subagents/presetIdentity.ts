/**
 * 子代理稳定身份规则：显示名与 ID 分离，ID 创建后不可变。
 * 项目层与全局层同 ID 表示显式覆盖；内置 ID 为保留字，自定义配置不得占用。
 */

export const SUBAGENT_PRESET_ID_MAX_LENGTH = 64

/** 合法 preset ID：小写字母/数字/`.`/`_`/`-`，首尾为字母或数字。 */
export const SUBAGENT_PRESET_ID_PATTERN =
  /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/

const ID_FALLBACK_BASE = 'subagent'

export const BUILTIN_SUBAGENT_IDS = {
  explore: 'explore',
  code: 'code',
  review: 'review',
  generalPurpose: 'general-purpose'
} as const

export type BuiltinSubagentId = (typeof BUILTIN_SUBAGENT_IDS)[keyof typeof BUILTIN_SUBAGENT_IDS]

const BUILTIN_SUBAGENT_ID_LIST: readonly BuiltinSubagentId[] = [
  BUILTIN_SUBAGENT_IDS.explore,
  BUILTIN_SUBAGENT_IDS.code,
  BUILTIN_SUBAGENT_IDS.review,
  BUILTIN_SUBAGENT_IDS.generalPurpose
]

export function isBuiltinSubagentId(value: string): value is BuiltinSubagentId {
  return (BUILTIN_SUBAGENT_ID_LIST as readonly string[]).includes(value)
}

export function isValidSubagentPresetId(value: string): boolean {
  return (
    value.length <= SUBAGENT_PRESET_ID_MAX_LENGTH &&
    SUBAGENT_PRESET_ID_PATTERN.test(value)
  )
}

/** 从显示名归一化出 ID 基底：小写、空白转连字符、剔除非法字符；结果可能为空。 */
export function normalizeSubagentPresetId(displayName: string): string {
  const lowered = displayName.trim().toLowerCase()
  const collapsed = lowered
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return clampIdBase(collapsed)
}

/**
 * 创建时由显示名派生稳定 ID；中文等无法转写的名称落到有界兜底基底，
 * 与既有 ID 冲突时追加确定性的数字后缀，绝不静默复用。
 */
export function generateSubagentPresetId(
  displayName: string,
  takenIds: Iterable<string>
): string {
  const taken = new Set<string>([...BUILTIN_SUBAGENT_ID_LIST, ...takenIds])
  const base = normalizeSubagentPresetId(displayName) || ID_FALLBACK_BASE
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const tag = `-${suffix}`
    const candidate = `${clampIdBase(base, SUBAGENT_PRESET_ID_MAX_LENGTH - tag.length)}${tag}`
    if (!taken.has(candidate)) return candidate
  }
  throw new Error(`无法为「${displayName}」生成不冲突的子代理 ID`)
}

function clampIdBase(value: string, maxLength = SUBAGENT_PRESET_ID_MAX_LENGTH): string {
  const cut = value.slice(0, maxLength)
  return cut.replace(/[-._]+$/g, '')
}
