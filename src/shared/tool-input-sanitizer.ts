/**
 * tool-input-sanitizer — 工具输入/输出的摘要化与截断
 *
 * 防止大文件内容、长 bash 输出等撑爆渲染进程 V8 heap。
 * 核心思路：在内容进入 zustand store 之前，把超大字段替换成摘要形态，
 * 渲染端从此不再持有完整文件内容，只保留 head/tail 预览。
 *
 * 放在 shared 层，主进程和渲染端都可引用：
 * - 渲染端：useChatStore 在写入 message 前调用（主防线）
 * - 主进程：toolBatchExecutor 在 emit 事件前调用（双保险）
 */

// ── T01：write/edit 输入摘要化常量 ──────────────────────────

/** write 工具的 content 字段超过此阈值触发摘要化 */
export const WRITE_TOOL_INLINE_LIMIT = 4 * 1024
/** edit 工具的 newText/new 字段超过此阈值触发摘要化 */
export const EDIT_TOOL_INLINE_LIMIT = 2 * 1024
/** write 工具摘要保留的总预览字符数（head + tail） */
export const WRITE_TOOL_PREVIEW_CHARS = 1200
/** edit 工具摘要保留的总预览字符数（head + tail） */
export const EDIT_TOOL_PREVIEW_CHARS = 800
/** 摘要保留的尾部字符数（write 和 edit 共用） */
export const PREVIEW_TAIL_CHARS = 320

// ── T02：工具输出截断常量 ──────────────────────────────────

/** 普通工具输出截断阈值 */
export const MAX_TOOL_OUTPUT_TEXT_CHARS = 8_000
/** 错误输出截断阈值 */
export const MAX_TOOL_ERROR_CHARS = 2_000
/** 截断后保留的头部字符数 */
export const OUTPUT_HEAD_CHARS = 4 * 1024
/** 截断后保留的尾部字符数 */
export const OUTPUT_TAIL_CHARS = 2 * 1024

// ── 辅助函数 ────────────────────────────────────────────────

/**
 * FNV-1a 32-bit hash，生成速度快，碰撞率可接受。
 * 用于给摘要内容附加 hash，便于下游（如 DiffContentLoader）
 * 通过 hash 向主进程申请完整内容。
 *
 * 注：charCodeAt 拿的是 UTF-16 单元而非 codepoint，
 * 对 emoji/非常用中文会产生不同输入同 hash 的碰撞，
 * 但在摘要场景下（仅做索引）碰撞概率极低，可接受。
 */
function fnv1a32(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = (hash * 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/** 计算文本行数 */
function countLines(text: string): number {
  if (!text) return 0
  let count = 1
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') count++
  }
  return count
}

// ── T01：摘要化核心函数 ────────────────────────────────────

/** 摘要化后的大文本结构 */
export interface ContentSummary {
  content_omitted: true
  content_hash: string
  content_chars: number
  content_lines: number
  content_head: string
  content_tail: string
  content_truncated: true
}

/**
 * 将超大文本替换为摘要对象。
 * 保留 head 和 tail，供卡片展示预览。
 */
export function summarizeLargeText(
  text: string,
  headChars: number,
  tailChars: number = PREVIEW_TAIL_CHARS
): ContentSummary {
  return {
    content_omitted: true,
    content_hash: fnv1a32(text),
    content_chars: text.length,
    content_lines: countLines(text),
    content_head: text.slice(0, headChars),
    content_tail: text.slice(Math.max(0, text.length - tailChars)),
    content_truncated: true
  }
}

/** 判断一个值是否为摘要对象 */
export function isContentSummary(value: unknown): value is ContentSummary {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as ContentSummary).content_omitted === true &&
    typeof (value as ContentSummary).content_hash === 'string'
  )
}

/**
 * 对 write/edit 工具的 input 做摘要化。
 *
 * - write：input.content 超过 4KB → 替换为摘要对象
 * - edit（新 schema）：input.edits[].newText 超过 2KB → 逐项替换
 * - edit（旧 schema）：input.new_string 超过 2KB → 替换为摘要对象
 * - 其他工具：原样返回
 */
export function sanitizeToolInput(
  toolName: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (!input || typeof input !== 'object') return input

  if (toolName === 'write' || toolName === 'save_plan') {
    const content = input.content
    if (typeof content === 'string' && content.length > WRITE_TOOL_INLINE_LIMIT) {
      return {
        ...input,
        content: summarizeLargeText(content, WRITE_TOOL_PREVIEW_CHARS - PREVIEW_TAIL_CHARS)
      }
    }
    return input
  }

  if (toolName === 'edit') {
    let modified = false
    const result = { ...input }

    // 新 schema：edits 数组（只摘要 newText，oldText 不动——oldText 是 LLM 上下文参考，不需要截断）
    if (Array.isArray(input.edits)) {
      const editHeadChars = EDIT_TOOL_PREVIEW_CHARS - PREVIEW_TAIL_CHARS
      const nextEdits = input.edits.map((edit: Record<string, unknown>) => {
        if (typeof edit.newText === 'string' && edit.newText.length > EDIT_TOOL_INLINE_LIMIT) {
          modified = true
          return { ...edit, newText: summarizeLargeText(edit.newText, editHeadChars) }
        }
        return edit
      })
      if (modified) {
        result.edits = nextEdits
      }
    }

    // 旧 schema：new_string 单字段（同理，old_string 不动）
    if (typeof input.new_string === 'string' && input.new_string.length > EDIT_TOOL_INLINE_LIMIT) {
      result.new_string = summarizeLargeText(input.new_string, EDIT_TOOL_PREVIEW_CHARS - PREVIEW_TAIL_CHARS)
      modified = true
    }

    return modified ? result : input
  }

  return input
}

// ── T02：工具输出截断 ────────────────────────────────────────

/**
 * 对工具输出（tool_result）做截断。
 *
 * - 普通输出超过 8KB → 保留头 4KB + 尾 2KB + 元信息
 * - 错误输出超过 2KB → 截断到 2KB
 * - 不超过阈值 → 原样返回
 */
export function sanitizeToolOutput(
  _toolName: string,
  output: string,
  isError: boolean = false
): string {
  if (typeof output !== 'string') return output

  // 错误输出用更激进的阈值
  if (isError) {
    if (output.length <= MAX_TOOL_ERROR_CHARS) return output
    return (
      output.slice(0, MAX_TOOL_ERROR_CHARS) +
      `\n\n[...truncated, ${output.length - MAX_TOOL_ERROR_CHARS} more chars]\n`
    )
  }

  // 普通输出
  if (output.length <= MAX_TOOL_OUTPUT_TEXT_CHARS) return output

  const head = output.slice(0, OUTPUT_HEAD_CHARS)
  const tail = output.slice(Math.max(0, output.length - OUTPUT_TAIL_CHARS))
  const omittedChars = output.length - OUTPUT_HEAD_CHARS - OUTPUT_TAIL_CHARS
  const hash = fnv1a32(output)

  return (
    head +
    `\n\n[...truncated, ${omittedChars} more chars, hash: ${hash}, lines: ${countLines(output)}]\n\n` +
    tail
  )
}
