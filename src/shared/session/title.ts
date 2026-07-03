/** 新建空会话的占位标题 */
export const SESSION_PLACEHOLDER_TITLE = '新会话'

/** 迁移时空老会话（无用户消息）的占位标题 */
export const SESSION_MIGRATED_EMPTY_TITLE = '历史会话'

/** 侧边栏/编辑框标题最大码点数 */
export const SESSION_TITLE_MAX_LENGTH = 30

/** 按 Unicode 码点截断（避免 emoji surrogate pair 被切半） */
export function clampSessionTitle(text: string, maxLength = SESSION_TITLE_MAX_LENGTH): string {
  const chars = Array.from(text.trim())
  if (chars.length <= maxLength) return chars.join('')
  return chars.slice(0, maxLength).join('')
}

/** 从纯文本生成会话标题（最多 30 码点，超出截断加省略号） */
export function generateSessionTitleFromText(text: string): string {
  const chars = Array.from(text.trim())
  if (chars.length <= SESSION_TITLE_MAX_LENGTH) return chars.join('')
  return chars.slice(0, SESSION_TITLE_MAX_LENGTH).join('') + '…'
}
