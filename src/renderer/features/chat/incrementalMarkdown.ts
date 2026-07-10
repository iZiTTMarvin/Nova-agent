/**
 * incrementalMarkdown — 流式 Markdown 的两阶段拆分
 *
 * 目标：避免每次 text delta 都对完整字符串做 ReactMarkdown AST 重建（累计 O(L²)）。
 *
 * 策略：
 * - sealedParts：已确认完整的块，内容冻结，只解析一次
 * - activeTail：最后一个未完成块，长度通常远小于全文，每次只重解析这段
 *
 * 封口规则（保守，宁可晚封也不误封导致 fence/列表被截断）：
 * 1. 若存在未闭合的 ``` / ~~~ fence，fence 起点之后全部留在 activeTail
 * 2. 否则以空行（\n\s*\n）为块边界；最后一个块若尚未被后续空行确认，留在 activeTail
 * 3. 全文结束（isFinal=true）时把剩余 tail 一并封口
 */

export interface IncrementalMarkdownSplit {
  /** 已封口的完整块（按出现顺序） */
  sealedParts: string[]
  /** 尚未封口的活动尾部 */
  activeTail: string
  /** sealed 部分在原文中的结束偏移（= sealedParts 拼接长度） */
  sealedEndOffset: number
  /** 未闭合 fence 起点；无则 -1。供下一帧增量扫描复用 */
  openFenceStart: number
}

const FENCE_LINE_RE = /^(```|~~~)([^\n`]*)?$/

/**
 * 增量 fence 扫描：只处理 previousLength..content.length 的新增后缀。
 * 返回未闭合 fence 起点；全部闭合则 -1。
 * scannedBytes 供 perf 断言：累计扫描量应接近总输入而非平方。
 */
export function findOpenFenceStartIncremental(
  content: string,
  prevLength: number,
  prevOpenStart: number
): { openStart: number; scannedBytes: number } {
  if (!content) return { openStart: -1, scannedBytes: 0 }

  // 内容缩短：全量重扫
  if (prevLength > content.length) {
    const openStart = findOpenFenceStart(content)
    return { openStart, scannedBytes: content.length }
  }

  // 无新增：沿用上一帧结果
  if (prevLength === content.length) {
    return { openStart: prevOpenStart, scannedBytes: 0 }
  }

  // ── 已有未闭合 fence：只扫增量后缀，判断是否出现闭合标记 ──
  if (prevOpenStart >= 0 && prevOpenStart < content.length) {
    const openLineEnd = content.indexOf('\n', prevOpenStart)
    const openLine = content.slice(
      prevOpenStart,
      openLineEnd < 0 ? content.length : openLineEnd
    )
    const openMatch = FENCE_LINE_RE.exec(openLine.trimEnd())
    if (!openMatch) {
      // 起点行已不是 fence：全量重扫
      const openStart = findOpenFenceStart(content)
      return { openStart, scannedBytes: content.length }
    }
    const openMarker = openMatch[1]!

    // 从 prevLength 所在行首开始扫（避免跨帧半行漏检），但不早于 open 行之后
    let scanFrom = prevLength
    while (scanFrom > 0 && content[scanFrom - 1] !== '\n') scanFrom -= 1
    const afterOpen = openLineEnd < 0 ? content.length : openLineEnd + 1
    scanFrom = Math.max(scanFrom, afterOpen)

    const suffix = content.slice(scanFrom)
    let offset = scanFrom
    const lines = suffix.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const match = FENCE_LINE_RE.exec(line.trimEnd())
      if (match && match[1] === openMarker) {
        // 闭合：再扫闭合点之后是否有新的未闭合 fence
        const closeEnd = offset + line.length + (i < lines.length - 1 ? 1 : 0)
        const rest = content.slice(closeEnd)
        const rel = findOpenFenceStart(rest)
        const openStart = rel < 0 ? -1 : closeEnd + rel
        return {
          openStart,
          scannedBytes: content.length - scanFrom
        }
      }
      offset += line.length + (i < lines.length - 1 ? 1 : 0)
    }
    // 仍未闭合
    return { openStart: prevOpenStart, scannedBytes: content.length - scanFrom }
  }

  // ── 此前无未闭合 fence：只扫新增后缀找新的 open ──
  let scanFrom = Math.max(0, prevLength)
  while (scanFrom > 0 && content[scanFrom - 1] !== '\n') scanFrom -= 1
  const slice = content.slice(scanFrom)
  const relative = findOpenFenceStart(slice)
  const openStart = relative < 0 ? -1 : scanFrom + relative
  return { openStart, scannedBytes: content.length - scanFrom }
}

/**
 * 扫描文本，返回未闭合 fence 的起始字符偏移；若全部闭合则返回 -1。
 * 注意：全量 API 保留给终态/回退；流式路径应优先用 findOpenFenceStartIncremental。
 */
export function findOpenFenceStart(content: string): number {
  let openStart = -1
  let openMarker: string | null = null
  let offset = 0
  const lines = content.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = FENCE_LINE_RE.exec(line.trimEnd())
    if (match) {
      const marker = match[1]
      if (openMarker === null) {
        openMarker = marker
        openStart = offset
      } else if (marker === openMarker) {
        openMarker = null
        openStart = -1
      }
    }
    offset += line.length + (i < lines.length - 1 ? 1 : 0)
  }
  return openStart
}

/**
 * 在 [from, to) 区间内找「空行块边界」的结束位置列表（边界落在第二个 \n 之后）。
 * 返回的每个 offset 表示「该位置之前的内容可视为已完整的一块」。
 */
function findBlankLineBoundaries(content: string, from: number, to: number): number[] {
  const ends: number[] = []
  let i = from
  while (i < to) {
    if (content[i] !== '\n') {
      i += 1
      continue
    }
    // 吃掉连续空白行：\n + 可选空白 + \n
    let j = i + 1
    while (j < to && (content[j] === ' ' || content[j] === '\t' || content[j] === '\r')) j += 1
    if (j < to && content[j] === '\n') {
      const boundaryEnd = j + 1
      if (boundaryEnd > from) ends.push(boundaryEnd)
      i = boundaryEnd
      continue
    }
    i += 1
  }
  return ends
}

/**
 * 把流式 Markdown 拆成 sealed + activeTail。
 *
 * @param content 当前完整（或打字机已放出）文本
 * @param isFinal 轮次结束时为 true，强制封口全部剩余
 * @param prevSealedEnd 上一帧已封口偏移；只允许前进，避免回退导致重复解析
 */
export function splitIncrementalMarkdown(
  content: string,
  isFinal = false,
  prevSealedEnd = 0,
  prevContentLength = 0,
  prevOpenFenceStart = -1
): IncrementalMarkdownSplit & { scannedBytes: number } {
  if (!content) {
    return { sealedParts: [], activeTail: '', sealedEndOffset: 0, openFenceStart: -1, scannedBytes: 0 }
  }

  if (isFinal) {
    return {
      sealedParts: content.length > 0 ? [content] : [],
      activeTail: '',
      sealedEndOffset: content.length,
      openFenceStart: -1,
      scannedBytes: 0
    }
  }

  const { openStart: openFence, scannedBytes } = findOpenFenceStartIncremental(
    content,
    prevContentLength || prevSealedEnd,
    prevOpenFenceStart
  )
  const searchableEnd = openFence >= 0 ? openFence : content.length

  // 只在尚未封口的区间内寻找新边界
  const scanFrom = Math.max(0, Math.min(prevSealedEnd, searchableEnd))
  const boundaries = findBlankLineBoundaries(content, scanFrom, searchableEnd)
  const boundaryScan = Math.max(0, searchableEnd - scanFrom)

  let sealedEnd = prevSealedEnd
  for (const b of boundaries) {
    if (b > sealedEnd && b <= searchableEnd) {
      sealedEnd = b
    }
  }

  // 保护：sealedEnd 不得超过 openFence
  if (openFence >= 0 && sealedEnd > openFence) {
    sealedEnd = Math.min(sealedEnd, openFence)
  }
  // 不允许回退
  if (sealedEnd < prevSealedEnd) {
    sealedEnd = prevSealedEnd
  }
  // 若整段都在未闭合 fence 内且此前无 sealed，保持全量 active
  if (sealedEnd > content.length) sealedEnd = content.length

  const sealedText = content.slice(0, sealedEnd)
  const activeTail = content.slice(sealedEnd)

  // 把 sealedText 按空行切成多段，便于各自 memo；若无空行则整段一块
  const sealedParts = sealedText.length === 0
    ? []
    : splitSealedIntoParts(sealedText)

  return {
    sealedParts,
    activeTail,
    sealedEndOffset: sealedEnd,
    openFenceStart: openFence,
    scannedBytes: scannedBytes + boundaryScan
  }
}

/** 将已封口前缀按空行切成稳定块（每块内容不再变化） */
function splitSealedIntoParts(sealedText: string): string[] {
  const parts: string[] = []
  const boundaries = findBlankLineBoundaries(sealedText, 0, sealedText.length)
  let start = 0
  for (const end of boundaries) {
    if (end <= start) continue
    const part = sealedText.slice(start, end)
    if (part.length > 0) parts.push(part)
    start = end
  }
  if (start < sealedText.length) {
    const rest = sealedText.slice(start)
    if (rest.length > 0) parts.push(rest)
  }
  return parts.length > 0 ? parts : [sealedText]
}

/**
 * 估算「本帧若重解析全文」与「只解析 tail」的相对成本比。
 * 供测试与 perf harness 断言：tail 成本不随全文线性上升。
 */
export function estimateParseCostChars(split: IncrementalMarkdownSplit): {
  sealedChars: number
  activeChars: number
  /** 本帧需要重解析的字符数（仅 activeTail） */
  reparseChars: number
} {
  const sealedChars = split.sealedParts.reduce((n, p) => n + p.length, 0)
  const activeChars = split.activeTail.length
  return {
    sealedChars,
    activeChars,
    reparseChars: activeChars
  }
}
