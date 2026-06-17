/**
 * XML Inband Scanner —— 从 assistant 正文中实时扫描 XML 风格工具调用。
 *
 * 支持格式：
 *   <invoke name="ls">
 *     <parameter name="path">.</parameter>
 *   </invoke>
 *
 * 也支持被 MiniMax 特殊 token 污染的文本，例如：
 *   ]\u003cminimax\u003e[\u003cinvoke name="bash">...</invoke\u003e]\u003c/minimax\u003e[
 * 扫描器会把这些占位符去掉后再解析。
 *
 * 使用方式（流式）：
 *   const scanner = new XmlToolScanner()
 *   for (const textDelta of stream) {
 *     for (const toolCall of scanner.feed(textDelta)) { ... }
 *   }
 *   const remainingText = scanner.flushText()
 */

export interface ScannedToolCall {
  /** 工具名 */
  name: string
  /** 解析后的参数对象 */
  arguments: Record<string, unknown>
}

/** MiniMax 等模型会在 XML 调用外层插入的占位符 token */
const MINIMAX_ARTIFACTS = /\]?<minimax>\[?|\]?<\/minimax>\[?/g

/** 清理文本中的 MiniMax 占位符，避免它们破坏 XML 解析。 */
export function stripMinimaxArtifacts(text: string): string {
  return text.replace(MINIMAX_ARTIFACTS, '')
}

/**
 * 从一段完整文本中解析所有 XML invoke 调用。
 * 返回 { toolCalls, visibleText }，其中 visibleText 是去掉工具调用后的剩余文本。
 */
export function parseXmlToolCalls(text: string): {
  toolCalls: ScannedToolCall[]
  visibleText: string
} {
  const cleaned = stripMinimaxArtifacts(text)
  const toolCalls: ScannedToolCall[] = []
  const segments: string[] = []

  // 匹配 <invoke name="...">...</invoke>，支持跨行
  const invokeRegex = /<invoke\s+name\s*=\s*"([^"]+)"\s*>([\s\S]*?)<\/invoke>/g

  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = invokeRegex.exec(cleaned)) !== null) {
    const toolName = match[1]
    const innerXml = match[2]

    const args: Record<string, unknown> = {}
    const paramRegex = /<parameter\s+name\s*=\s*"([^"]+)"\s*(?:string\s*=\s*"([^"]+)")?\s*>([\s\S]*?)<\/parameter>/g
    let paramMatch: RegExpExecArray | null
    while ((paramMatch = paramRegex.exec(innerXml)) !== null) {
      const key = paramMatch[1]
      const stringAttr = paramMatch[2]
      const rawValue = paramMatch[3].trim()

      // string="false" 表示强制按 JSON 解析，否则字符串保留原样
      const forceJson = stringAttr === 'false'
      const value = forceJson ? tryJsonParse(rawValue) : tryJsonParseIfLooksLikeJson(rawValue)
      args[key] = value
    }

    // 兼容模型直接用子标签传参（无 <parameter name="..."> 包裹）
    const childRegex = /<([a-zA-Z_][a-zA-Z0-9_]*)>([\s\S]*?)<\/\1>/g
    let childMatch: RegExpExecArray | null
    while ((childMatch = childRegex.exec(innerXml)) !== null) {
      const key = childMatch[1]
      if (key === 'parameter') continue
      if (args[key] !== undefined) continue
      args[key] = tryJsonParseIfLooksLikeJson(childMatch[2].trim())
    }

    toolCalls.push({ name: toolName, arguments: args })
    segments.push(cleaned.slice(lastIndex, match.index))
    lastIndex = invokeRegex.lastIndex
  }
  segments.push(cleaned.slice(lastIndex))

  const visibleText = segments
    .join('')
    .replace(/\s*\n\s*\n\s*/g, '\n\n')
    .trim()

  return { toolCalls, visibleText }
}

function tryJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function tryJsonParseIfLooksLikeJson(raw: string): unknown {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']')) ||
    trimmed === 'true' ||
    trimmed === 'false' ||
    (/^-?\d+(\.\d+)?$/.test(trimmed) && !trimmed.startsWith('0'))
  ) {
    return tryJsonParse(trimmed)
  }
  return raw
}

export class XmlToolScanner {
  private buffer = ''
  private emitted = new Set<string>()

  /**
   * 喂入一段文本增量，返回本次新识别到的完整工具调用。
   * 已返回过的调用不会重复返回（通过 name+args 哈希去重）。
   */
  feed(delta: string): ScannedToolCall[] {
    this.buffer += delta
    const { toolCalls, visibleText } = parseXmlToolCalls(this.buffer)

    // 如果解析后 buffer 被工具调用占满且没有可见文本，说明可能还没收到完整 invoke，
    // 但 RegExp 只匹配完整闭合标签，所以 toolCalls 中都是完整调用。
    // 保留 visibleText 作为已消费文本，重新构造 buffer 为未解析部分。
    this.buffer = visibleText

    const newCalls: ScannedToolCall[] = []
    for (const call of toolCalls) {
      const key = `${call.name}:${JSON.stringify(call.arguments)}`
      if (this.emitted.has(key)) continue
      this.emitted.add(key)
      newCalls.push(call)
    }
    return newCalls
  }

  /** 刷新并返回最终剩余文本（不含任何工具调用）。 */
  flushText(): string {
    const { visibleText } = parseXmlToolCalls(this.buffer)
    this.buffer = visibleText
    return visibleText
  }

  /** 重置 scanner 状态 */
  reset(): void {
    this.buffer = ''
    this.emitted.clear()
  }
}
