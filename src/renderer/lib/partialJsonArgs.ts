/**
 * 流式工具调用参数的容错解析。
 *
 * SSE 流中的 argumentsDelta 是分块到达的 JSON 片段，任意时刻都可能未闭合。
 * extractPartialString 从 partial JSON 中容错提取指定 key 的字符串值，
 * parsePartialToolArgs 再按工具名选取实时展示字段。
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
  const start = findStringValueStart(partial, key)
  if (start === -1) return undefined
  return decodeJsonStringFrom(partial, start).value
}

/** 定位 `"key" : "` 之后字符串值的起点；找不到返回 -1 */
function findStringValueStart(partial: string, key: string): number {
  const keyToken = `"${key}"`
  const keyIdx = partial.indexOf(keyToken)
  if (keyIdx === -1) return -1

  let i = keyIdx + keyToken.length
  // 跳过 key 和冒号之间的空白
  while (i < partial.length && /\s/.test(partial[i])) i++
  if (i >= partial.length || partial[i] !== ':') return -1
  i++
  while (i < partial.length && /\s/.test(partial[i])) i++

  if (i >= partial.length || partial[i] !== '"') return -1
  return i + 1
}

interface DecodedStringChunk {
  /** 本次新解码出的文本 */
  value: string
  /** 最后一个完整解码字符之后的位置；被截断的转义序列（如 `\`、`\u00`）留在 end 之后等下次再解 */
  end: number
  /** 是否遇到了闭合引号 */
  closed: boolean
}

function decodeJsonStringFrom(partial: string, start: number): DecodedStringChunk {
  let value = ''
  let i = start
  while (i < partial.length) {
    const ch = partial[i]
    if (ch === '\\') {
      const next = partial[i + 1]
      if (next === undefined) return { value, end: i, closed: false }
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
          if (i + 6 > partial.length) return { value, end: i, closed: false }
          const hex = partial.slice(i + 2, i + 6)
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) return { value, end: i, closed: false }
          value += String.fromCharCode(parseInt(hex, 16))
          i += 6
          break
        }
        default:
          value += next
          i += 2
      }
    } else if (ch === '"') {
      return { value, end: i + 1, closed: true }
    } else {
      value += ch
      i++
    }
  }
  // 字符串未闭合，返回已累积部分
  return { value, end: i, closed: false }
}

/**
 * 同一字段的增量读取器：argumentsRaw 只追加，记住已解码终点后每次只解新增部分，
 * 总成本与参数长度成正比而不是每次都从头扫描。raw 变短说明换了新的一串累积，从头重来。
 */
export function createPartialStringReader(key: string): { read(raw: string): string | undefined; isClosed(): boolean } {
  let start = -1
  let end = -1
  let closed = false
  let value = ''
  let lastLength = -1
  return {
    read(raw: string): string | undefined {
      if (raw.length < lastLength) {
        start = -1
        end = -1
        closed = false
        value = ''
      }
      lastLength = raw.length
      if (closed) return value
      if (start === -1) {
        start = findStringValueStart(raw, key)
        if (start === -1) return undefined
        end = start
      }
      const chunk = decodeJsonStringFrom(raw, end)
      value += chunk.value
      end = chunk.end
      closed = chunk.closed
      return value
    },
    /** 最近一次 read 时字段的字符串值已闭合：值已完整 */
    isClosed(): boolean {
      return closed
    }
  }
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
    case 'write':
    case 'save_plan': {
      const path = extractPartialString(raw, 'path')
      const title = extractPartialString(raw, 'title')
      const content = extractPartialString(raw, 'content')
      if (path !== undefined) args.path = path
      if (title !== undefined) args.title = title
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
    // 通用轨迹只需标题；draft 由可视化卡片交给共享编译器增量预览
    case 'present_visualization': {
      const title = extractPartialString(raw, 'title')
      if (title !== undefined) args.title = title
      break
    }
    default:
      break
  }

  return args
}
