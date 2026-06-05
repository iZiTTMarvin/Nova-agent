/**
 * partialJsonArgs — 流式工具调用参数的容错解析
 *
 * SSE 流中 tool_call_delta 的 argumentsDelta 是分块到达的 JSON 片段，
 * 任意时刻拼起来都可能未闭合，JSON.parse 必失败。
 * extractPartialString 从 partial JSON 中容错地提取指定 key 的字符串值，
 * 能读多少读多少，遇到截断就返回已收部分。
 * parsePartialToolArgs 按工具名选取需要实时展示的字段，派发到 extractPartialString。
 */

/**
 * 从 partial JSON 中容错地提取 string 字段当前累积值。
 *
 * 行为：
 * - 找不到 key 返回 undefined
 * - 字符串闭合：返回完整反转义后的值
 * - 字符串未闭合：返回到当前位置已累积、已反转义的内容
 * - 支持转义：\" \\ \/ \n \r \t \b \f \uXXXX
 * - 直接按 "key" 子串匹配（write/edit/bash 字段都在顶层，此方式足够可靠）
 *
 * 限制：不处理 key 出现在另一个 string 值里的污染场景
 * （实际场景极少，且最终 tool_call 会覆盖兜底）
 */
export function extractPartialString(partial: string, key: string): string | undefined {
  const keyToken = `"${key}"`
  const keyIdx = partial.indexOf(keyToken)
  if (keyIdx === -1) return undefined

  let i = keyIdx + keyToken.length
  // 跳过 key 和冒号之间的空白
  while (i < partial.length && /\s/.test(partial[i])) i++
  if (i >= partial.length || partial[i] !== ':') return undefined
  i++
  while (i < partial.length && /\s/.test(partial[i])) i++

  if (i >= partial.length || partial[i] !== '"') return undefined
  i++

  let value = ''
  while (i < partial.length) {
    const ch = partial[i]
    if (ch === '\\') {
      const next = partial[i + 1]
      if (next === undefined) return value
      switch (next) {
        case '"':  value += '"';  i += 2; break
        case '\\': value += '\\'; i += 2; break
        case '/':  value += '/';  i += 2; break
        case 'n':  value += '\n'; i += 2; break
        case 'r':  value += '\r'; i += 2; break
        case 't':  value += '\t'; i += 2; break
        case 'b':  value += '\b'; i += 2; break
        case 'f':  value += '\f'; i += 2; break
        case 'u': {
          if (i + 6 > partial.length) return value
          const hex = partial.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return value
          value += String.fromCharCode(parseInt(hex, 16))
          i += 6
          break
        }
        default:
          value += next
          i += 2
      }
    } else if (ch === '"') {
      return value
    } else {
      value += ch
      i++
    }
  }
  // 字符串未闭合，返回已累积部分
  return value
}

/**
 * 按工具名选取需要在流式期间实时展示的字段，返回当前进度对应的 args 对象。
 * 未识别工具返回空对象，由 final tool_call 兜底。
 *
 * 字段名与工具实现（writeTool/editTool/bashTool）的 parameters schema 保持一致：
 * - write: path, content
 * - edit: path, old, new
 * - bash: command
 */
export function parsePartialToolArgs(toolName: string, raw: string): Record<string, unknown> {
  if (!raw) return {}
  const args: Record<string, unknown> = {}

  switch (toolName) {
    case 'write': {
      const path = extractPartialString(raw, 'path')
      const content = extractPartialString(raw, 'content')
      if (path !== undefined) args.path = path
      if (content !== undefined) args.content = content
      break
    }
    case 'edit': {
      // 新 schema：filePath + edits[].oldText/newText；旧 schema：path + old/new。
      // 两套字段都尝试提取，命中谁用谁，保证 edit 流式预览在新旧格式下都能显示
      // 文件名与新内容（否则新格式下 StreamingFileCard 会一直显示「未命名文件」）。
      const filePath = extractPartialString(raw, 'filePath')
      const path = extractPartialString(raw, 'path')
      const oldText = extractPartialString(raw, 'oldText')
      const oldStr = extractPartialString(raw, 'old')
      const newText = extractPartialString(raw, 'newText')
      const newStr = extractPartialString(raw, 'new')
      if (filePath !== undefined) args.filePath = filePath
      if (path !== undefined) args.path = path
      if (oldText !== undefined) args.oldText = oldText
      if (oldStr !== undefined) args.old = oldStr
      if (newText !== undefined) args.newText = newText
      if (newStr !== undefined) args.new = newStr
      break
    }
    case 'bash': {
      const command = extractPartialString(raw, 'command')
      if (command !== undefined) args.command = command
      break
    }
    default:
      break
  }

  return args
}