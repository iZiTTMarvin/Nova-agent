/**
 * XML Inband Scanner —— 从 assistant 正文中实时扫描 XML 风格工具调用。
 *
 * 支持格式（统一 prompt 要求）：
 *   <invoke name="工具名">
 *     <parameter name="参数名">参数值</parameter>
 *   </invoke>
 *
 * 也支持被 MiniMax 特殊 token 污染的文本，例如：
 *   ]<minimax>[<invoke name="bash">...</invoke>]</minimax>[
 *   <minimax:tool_call><invoke name="bash">...</invoke></minimax:tool_call>
 * 扫描器会把这些占位符去掉后再解析。
 *
 * --- 增量状态机 ---
 *
 * 事件类型（对齐 oh-my-pi InbandScanEvent）：
 *   text         — 纯文本（已剥离 XML 标签）
 *   toolStart    — 检测到 <invoke name="...">，携带 id + 工具名
 *   toolArgDelta — 参数值增量片段，携带 id + key + delta（原文增量）
 *   toolEnd      — 检测到 </invoke>，携带 id + 工具名 + 完整 arguments
 *
 * 状态转换：
 *   IDLE ──<invoke name="X">──▶ IN_INVOKE（emit toolStart）
 *   IN_INVOKE ──<parameter name="K">──▶ IN_PARAM（记录 currentKey）
 *   IN_PARAM ──内容增量──▶ 持续 emit toolArgDelta
 *   IN_PARAM ──</parameter>──▶ IN_INVOKE
 *   IN_INVOKE ──</invoke>──▶ IDLE（emit toolEnd）
 *
 * 边界处理：
 *   - buffer 只保留「尚未确定语义的尾部」（如半个标签 <inv），已确定内容立即吐出。
 *   - 标签识别收紧：仅匹配已知标签名（invoke/parameter），正文中的 <div>、<T> 等
 *     不会被误判为标签。
 *   - XML entity 转义（&lt; &amp; &quot; &gt;）在参数值中自动还原。
 *   - MiniMax 占位符在 feed 入口处清理。
 *
 * 已知限制（第一步范围，后续可优化）：
 *   - entity 跨 chunk 切分：当 entity（如 &lt;）被 SSE token 边界切开时，流式
 *     toolArgDelta 的每段增量单独 decode 不匹配，会短暂累积成字面 &lt;（前端逐字
 *     渲染时可能闪烁）。最终值由 finalDecodeArgs 在 toolEnd 时统一修正，保证
 *     toolEnd.arguments 正确。因此调用方应始终以 toolEnd.arguments 作为工具执行
 *     的权威值，不要用流式 delta 拼接结果作为执行依据。
 *   - IN_INVOKE 状态：invoke 与 parameter 之间的非空白内容会被忽略（规范工具调用
 *     不会出现此情况）。模型异常输出时由 AgentLoop 的全量解析兜底补位。
 *
 * 使用方式（流式）：
 *   const scanner = new XmlToolScanner()
 *   for (const textDelta of stream) {
 *     for (const event of scanner.feed(textDelta)) {
 *       switch (event.type) {
 *         case 'text': ...        // 纯正文
 *         case 'toolStart': ...   // 开始工具调用
 *         case 'toolArgDelta': ...// 参数增量
 *         case 'toolEnd': ...     // 工具调用结束
 *       }
 *     }
 *   }
 *   for (const event of scanner.flush()) { ... }  // 冲刷残留
 */

/** 增量扫描器产出的事件 */
export type XmlScanEvent =
  | { type: 'text'; text: string }
  | { type: 'toolStart'; id: string; name: string }
  | { type: 'toolArgDelta'; id: string; key: string; delta: string }
  | { type: 'toolEnd'; id: string; name: string; arguments: Record<string, unknown> }

/** 全量解析结果（保留供兜底） */
export interface ScannedToolCall {
  /** 工具名 */
  name: string
  /** 解析后的参数对象 */
  arguments: Record<string, unknown>
}

// ==================== 常量与工具函数 ====================

/** MiniMax 等模型会在 XML 调用外层插入的占位符 token（含 <minimax:tool_call> 命名空间变体） */
const MINIMAX_ARTIFACTS = /\]?<\/?minimax(?::[a-zA-Z_]+)?>\[?/g

/** 清理文本中的 MiniMax 占位符，避免它们破坏 XML 解析。 */
export function stripMinimaxArtifacts(text: string): string {
  return text.replace(MINIMAX_ARTIFACTS, '')
}

/** 已知标签前缀（用于判断尾部是否为未闭合标签） */
const KNOWN_TAG_PREFIXES = ['<invoke', '</invoke', '<parameter', '</parameter']

/** 扫描器内部状态 */
type ScanState = 'IDLE' | 'IN_INVOKE' | 'IN_PARAM'

// ==================== 增量扫描器 ====================

export class XmlToolScanner {
  private buffer = ''
  private state: ScanState = 'IDLE'
  private currentToolId = ''
  private currentToolName = ''
  private currentParamKey = ''
  private currentArgs: Record<string, unknown> = {}
  private toolIdCounter = 0

  /**
   * 喂入一段文本增量，返回本次新识别到的事件序列。
   * 调用方按顺序处理事件：text → 累积正文，toolStart/toolArgDelta/toolEnd → 构建工具调用。
   */
  feed(delta: string): XmlScanEvent[] {
    // 入口清理 MiniMax 占位符
    this.buffer += stripMinimaxArtifacts(delta)
    const events: XmlScanEvent[] = []

    // 循环处理 buffer，直到无法继续推进
    let progress = true
    while (progress && this.buffer.length > 0) {
      progress = false

      switch (this.state) {
        case 'IDLE':
          progress = this.processIdle(events)
          break
        case 'IN_INVOKE':
          progress = this.processInInvoke(events)
          break
        case 'IN_PARAM':
          progress = this.processInParam(events)
          break
      }
    }

    return events
  }

  /**
   * 冲刷残留内容，返回最后的事件。
   * 流结束后调用一次，确保 buffer 不残留。
   * - 已识别的未闭合调用（IN_PARAM / IN_INVOKE）会尝试 finalize。
   * - 完全无法识别的残留（IDLE 中的半截标签）当正文吐出，由兜底全量解析补位。
   */
  flush(): XmlScanEvent[] {
    const events: XmlScanEvent[] = []

    if (this.state === 'IN_PARAM') {
      // 参数值还在累积中：吐出最后一段 delta，然后 finalize
      if (this.buffer.length > 0) {
        const decoded = this.decodeXmlEntities(this.buffer)
        this.currentArgs[this.currentParamKey] =
          ((this.currentArgs[this.currentParamKey] as string) || '') + decoded
        events.push({
          type: 'toolArgDelta',
          id: this.currentToolId,
          key: this.currentParamKey,
          delta: decoded
        })
      }
      // 确保空参数也有值
      if (this.currentArgs[this.currentParamKey] === undefined) {
        this.currentArgs[this.currentParamKey] = ''
      }
      this.state = 'IDLE'
      events.push({
        type: 'toolEnd',
        id: this.currentToolId,
        name: this.currentToolName,
        arguments: this.finalDecodeArgs(this.currentArgs)
      })
    } else if (this.state === 'IN_INVOKE') {
      // invoke 内但参数区已结束或从未进入参数：finalize 已有 args
      this.state = 'IDLE'
      if (Object.keys(this.currentArgs).length > 0) {
        events.push({
          type: 'toolEnd',
          id: this.currentToolId,
          name: this.currentToolName,
          arguments: this.finalDecodeArgs(this.currentArgs)
        })
      }
      // 残留的标签碎片当正文吐出（兜底全量解析会再尝试）
      if (this.buffer.length > 0) {
        events.push({ type: 'text', text: this.buffer })
      }
    } else {
      // IDLE：残留当正文
      if (this.buffer.length > 0) {
        events.push({ type: 'text', text: this.buffer })
      }
    }

    this.buffer = ''
    return events
  }

  /** 重置 scanner 状态，用于新一轮对话 */
  reset(): void {
    this.buffer = ''
    this.state = 'IDLE'
    this.currentToolId = ''
    this.currentToolName = ''
    this.currentParamKey = ''
    this.currentArgs = {}
    this.toolIdCounter = 0
  }

  // ==================== 状态处理器 ====================

  /**
   * IDLE 状态：寻找 <invoke name="..."> 标签。
   * 标签之前的文本作为 'text' 事件吐出。
   * 找到标签后切换到 IN_INVOKE，emit toolStart。
   */
  private processIdle(events: XmlScanEvent[]): boolean {
    const safeEnd = this.findSafeBoundary()
    if (safeEnd === 0) return false

    const safe = this.buffer.slice(0, safeEnd)

    // 匹配 <invoke name="工具名">（容忍属性间多余空白）
    const invokeMatch = safe.match(/<invoke\s+name\s*=\s*"([^"]*)"\s*>/)
    if (invokeMatch && invokeMatch.index !== undefined) {
      // 标签之前的文本
      if (invokeMatch.index > 0) {
        events.push({ type: 'text', text: safe.slice(0, invokeMatch.index) })
      }

      const toolName = invokeMatch[1]
      const id = `xml_${this.toolIdCounter++}`
      this.currentToolId = id
      this.currentToolName = toolName
      this.currentArgs = {}
      this.state = 'IN_INVOKE'
      events.push({ type: 'toolStart', id, name: toolName })

      // 标签之后的内容留在 buffer 继续处理
      this.buffer = safe.slice(invokeMatch.index + invokeMatch[0].length) + this.buffer.slice(safeEnd)
      return true
    }

    // 安全区内没有 <invoke>：全部当正文吐出
    if (safe.length > 0) {
      events.push({ type: 'text', text: safe })
    }
    this.buffer = this.buffer.slice(safeEnd)
    return safe.length > 0
  }

  /**
   * IN_INVOKE 状态：寻找 <parameter name="..."> 或 </invoke>。
   * 谁先出现就处理谁。标签间的空白被忽略。
   */
  private processInInvoke(events: XmlScanEvent[]): boolean {
    const safeEnd = this.findSafeBoundary()
    if (safeEnd === 0) return false

    const safe = this.buffer.slice(0, safeEnd)

    // 同时查找 parameter 开始标签和 invoke 结束标签
    const paramMatch = safe.match(/<parameter\s+name\s*=\s*"([^"]*)"\s*>/)
    const endMatch = safe.match(/<\/invoke>/)

    const paramIdx = paramMatch?.index ?? Infinity
    const endIdx = endMatch?.index ?? Infinity

    if (paramIdx < endIdx && paramIdx !== Infinity) {
      // <parameter> 先出现
      const key = paramMatch![1]
      this.currentParamKey = key
      this.state = 'IN_PARAM'
      // 标签前的空白忽略，标签后的内容留在 buffer
      this.buffer = safe.slice(paramIdx + paramMatch![0].length) + this.buffer.slice(safeEnd)
      return true
    }

    if (endIdx < paramIdx && endIdx !== Infinity) {
      // </invoke> 先出现：工具调用结束
      this.state = 'IDLE'
      events.push({
        type: 'toolEnd',
        id: this.currentToolId,
        name: this.currentToolName,
        arguments: this.finalDecodeArgs(this.currentArgs)
      })
      this.buffer = safe.slice(endIdx + endMatch![0].length) + this.buffer.slice(safeEnd)
      return true
    }

    // 安全区内两个标签都没有：丢弃空白，保留尾部
    this.buffer = this.buffer.slice(safeEnd)
    return false
  }

  /**
   * IN_PARAM 状态：累积参数值，寻找 </parameter>。
   * 在 </parameter> 之前的所有内容都是参数值，作为 toolArgDelta 增量吐出。
   * 找到 </parameter> 后切回 IN_INVOKE。
   */
  private processInParam(events: XmlScanEvent[]): boolean {
    const safeEnd = this.findSafeBoundary()
    if (safeEnd === 0) return false

    const safe = this.buffer.slice(0, safeEnd)

    // 查找 </parameter>
    const endParamMatch = safe.match(/<\/parameter>/)

    if (endParamMatch && endParamMatch.index !== undefined) {
      // 找到结束标签：标签前的内容是参数值
      const rawContent = safe.slice(0, endParamMatch.index)
      if (rawContent.length > 0) {
        const decoded = this.decodeXmlEntities(rawContent)
        this.currentArgs[this.currentParamKey] =
          ((this.currentArgs[this.currentParamKey] as string) || '') + decoded
        events.push({
          type: 'toolArgDelta',
          id: this.currentToolId,
          key: this.currentParamKey,
          delta: decoded
        })
      } else {
        // 空参数值
        if (this.currentArgs[this.currentParamKey] === undefined) {
          this.currentArgs[this.currentParamKey] = ''
        }
      }

      this.state = 'IN_INVOKE'
      this.buffer = safe.slice(endParamMatch.index + endParamMatch[0].length) + this.buffer.slice(safeEnd)
      return true
    }

    // 安全区内没有 </parameter>：全部内容是参数值增量
    if (safe.length > 0) {
      const decoded = this.decodeXmlEntities(safe)
      this.currentArgs[this.currentParamKey] =
        ((this.currentArgs[this.currentParamKey] as string) || '') + decoded
      events.push({
        type: 'toolArgDelta',
        id: this.currentToolId,
        key: this.currentParamKey,
        delta: decoded
      })
    }

    this.buffer = this.buffer.slice(safeEnd)
    return safe.length > 0
  }

  // ==================== 辅助方法 ====================

  /**
   * 找到 buffer 中可安全处理的边界位置。
   * 边界之前的內容不包含未闭合的已知标签，可以放心处理。
   * 边界之后的内容是「不确定尾部」（可能是半个标签），保留等待更多输入。
   *
   * 规则：找到最后一个 <，如果它后面没有 >，且从 < 开始的子串是已知标签
   * 前缀，则该 < 之前为安全边界。否则整个 buffer 都是安全的。
   */
  private findSafeBoundary(): number {
    const lastLt = this.buffer.lastIndexOf('<')
    if (lastLt === -1) return this.buffer.length

    // 检查这个 < 之后是否有 >（即标签是否已闭合）
    const gtAfter = this.buffer.indexOf('>', lastLt)
    if (gtAfter !== -1) return this.buffer.length

    // 潜在未闭合标签
    const potentialTag = this.buffer.slice(lastLt)
    if (this.isPartialKnownTag(potentialTag)) {
      return lastLt
    }

    // 不是已知标签前缀，整个 buffer 安全
    return this.buffer.length
  }

  /**
   * 判断一段以 < 开头的文本是否可能是已知标签的前缀。
   * 双向匹配：text 以已知前缀开头，或已知前缀以 text 开头。
   */
  private isPartialKnownTag(text: string): boolean {
    if (!text.startsWith('<')) return false
    return KNOWN_TAG_PREFIXES.some(p => text.startsWith(p) || p.startsWith(text))
  }

  /** 还原 XML entity 转义字符 */
  private decodeXmlEntities(text: string): string {
    return text
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&apos;/g, "'")
  }

  /**
   * 对 args 中所有字符串值做最终 entity 解码。
   * 流式期间 processInParam 已做逐段解码，但逐字符 feed 时 entity 可能被切分，
   * 此方法确保 toolEnd 时所有参数值都经过完整解码。
   */
  private finalDecodeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const decoded: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        decoded[key] = this.decodeXmlEntities(value)
      } else {
        decoded[key] = value
      }
    }
    return decoded
  }
}

// ==================== 全量解析（保留供兜底） ====================

/**
 * 从一段完整文本中解析所有 XML invoke 调用。
 * 返回 { toolCalls, visibleText }，其中 visibleText 是去掉工具调用后的剩余文本。
 *
 * 此函数行为不变，用于流式扫描器漏识别时的兜底补位。
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
