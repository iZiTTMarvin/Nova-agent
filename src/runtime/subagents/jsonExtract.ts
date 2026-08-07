/**
 * 从模型文本中提取 JSON 候选（支持 ```json 围栏、散文夹杂、多对象）。
 *
 * 真实模型输出很少是"纯净 JSON"：常带思考散文、多个围栏块或前后解释。
 * 只取单一候选过于脆弱（首个围栏可能是噪声示例），因此这里产出全部可解析候选，
 * 由调用方结合 schema required 字段挑选，解析失败率随候选数显著下降。
 */

/** 候选数量上限：防止病态文本产生大量切片导致解析开销失控 */
const MAX_CANDIDATES = 16

/**
 * 扫描 text 中所有平衡大括号子串（跳过字符串字面量与转义），返回原文切片。
 * 从每个尚未消费的 '{' 开始配对；遇到不闭合的 '{' 时整体终止——
 * 其后不可能再出现完整顶层对象。
 */
function scanBalancedObjects(text: string): string[] {
  const results: string[] = []
  let searchFrom = 0
  while (results.length < MAX_CANDIDATES) {
    const start = text.indexOf('{', searchFrom)
    if (start < 0) break
    let depth = 0
    let inString = false
    let escaped = false
    let end = -1
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    if (end < 0) break
    results.push(text.slice(start, end + 1))
    searchFrom = end + 1
  }
  return results
}

/**
 * 产出全部可 JSON.parse 成功的候选，按「整段文本 → 各围栏块 → 各平衡大括号切片」
 * 的顺序返回并去重。调用方应按自身 schema 约束筛选，而不是盲目取第一个。
 */
export function extractJsonCandidates(text: string): unknown[] {
  const candidates: unknown[] = []
  const seen = new Set<string>()
  const push = (raw: string | undefined): void => {
    const trimmed = raw?.trim() ?? ''
    if (!trimmed || seen.has(trimmed) || candidates.length >= MAX_CANDIDATES) return
    try {
      candidates.push(JSON.parse(trimmed))
      seen.add(trimmed)
    } catch {
      // 非法 JSON 候选直接跳过
    }
  }

  push(text)
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi
  let fence: RegExpExecArray | null
  while ((fence = fencePattern.exec(text)) !== null) {
    push(fence[1])
  }
  for (const slice of scanBalancedObjects(text)) {
    push(slice)
  }
  return candidates
}

/** 取第一个可解析候选；无则 null。 */
export function extractJson(text: string): unknown | null {
  return extractJsonCandidates(text)[0] ?? null
}
