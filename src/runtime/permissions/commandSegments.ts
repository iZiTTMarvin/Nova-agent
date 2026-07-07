/**
 * 将 shell 命令按控制操作符切分为独立段，用于白名单「每一段首 token 均命中」校验。
 * 覆盖 &&、||、;、|、反引号、$() 等常见拼接方式。
 */

/** shell 控制操作符：按优先级从长到短匹配 */
const SEGMENT_SPLIT_RE = /&&|\|\||;|\||`|\$\(/g

/**
 * 从单段命令中提取首 token（跳过前置环境变量赋值，如 FOO=bar cmd）。
 */
export function getFirstCommandToken(segment: string): string {
  const trimmed = segment.trim()
  if (!trimmed) return ''
  const match = trimmed.match(/^(?:\w+=\S+\s+)*(\S+)/)
  return match?.[1] ?? ''
}

/**
 * 按控制操作符切分整条命令；无分隔符时返回单段。
 */
export function splitCommandSegments(command: string): string[] {
  const segments = command
    .split(SEGMENT_SPLIT_RE)
    .map(s => s.trim())
    .filter(Boolean)
  return segments.length > 0 ? segments : command.trim() ? [command.trim()] : []
}

/**
 * 会话白名单：每一段的首 token 都必须在白名单内才算命中。
 */
export function isCommandFullyWhitelisted(command: string, whitelist: Set<string>): boolean {
  const segments = splitCommandSegments(command)
  if (segments.length === 0) return false
  return segments.every(seg => {
    const token = getFirstCommandToken(seg)
    return Boolean(token && whitelist.has(token))
  })
}
