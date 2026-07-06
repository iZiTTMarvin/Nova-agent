/**
 * MemoryConsolidator — working buffer / LLM 提炼 → episodic Markdown 块（纯逻辑）
 *
 * 按 fingerprint 去重合并，输出带日期与 sessionId 的摘要块，供 append-only 落盘。
 */
import type { ExtractedMemory } from './MemoryExtractor'
import type { MemoryObservation } from './ObservationCapture'

/** episodic 摘要相对路径（仅允许 append，禁止写 MEMORY.md） */
export const EPISODIC_SUMMARY_REL_PATH = 'episodic/summary.md'

export interface ConsolidateOptions {
  /** 注入时钟（单测用） */
  now?: () => number
}

/** LLM 提炼落盘结果 */
export interface ConsolidateExtractedResult {
  episodicMarkdown: string
  /** autoMerge 开启且命中高分规则时的 MEMORY.md 追加块 */
  memoryAppendMarkdown: string
}

export interface ConsolidateExtractedOptions extends ConsolidateOptions {
  /** 是否允许高分结论追加 MEMORY.md */
  autoMergeEnabled?: boolean
}

interface MergedObservation {
  title: string
  facts: string[]
  filesTouched: string[]
  fingerprint: string
  sessionId: string
  capturedAt: number
}

/**
 * 将一批 observation 合并为 episodic Markdown 块（不含外层文件头）。
 * 空输入返回空字符串。
 */
export function consolidateObservations(
  observations: readonly MemoryObservation[],
  options: ConsolidateOptions = {}
): string {
  if (observations.length === 0) {
    return ''
  }

  const merged = mergeByFingerprint(observations)
  const sessionId = observations[0].sessionId
  const dateStr = formatDate(options.now?.() ?? Date.now())

  const lines: string[] = [`## ${dateStr} — session ${sessionId}`, '']

  for (const item of merged) {
    lines.push(`- **${item.title}**`)
    for (const fact of item.facts) {
      lines.push(`  - ${fact}`)
    }
    if (item.filesTouched.length > 0) {
      lines.push(`  - Files: ${item.filesTouched.join(', ')}`)
    }
    lines.push('')
  }

  lines.push('---', '')
  return lines.join('\n')
}

function mergeByFingerprint(observations: readonly MemoryObservation[]): MergedObservation[] {
  const order: string[] = []
  const map = new Map<string, MergedObservation>()

  for (const obs of observations) {
    const existing = map.get(obs.fingerprint)
    if (!existing) {
      order.push(obs.fingerprint)
      map.set(obs.fingerprint, {
        title: obs.title,
        facts: [...obs.facts],
        filesTouched: [...obs.filesTouched],
        fingerprint: obs.fingerprint,
        sessionId: obs.sessionId,
        capturedAt: obs.capturedAt
      })
      continue
    }

    existing.facts = dedupeStrings([...existing.facts, ...obs.facts])
    existing.filesTouched = dedupeStrings([...existing.filesTouched, ...obs.filesTouched])
    if (obs.capturedAt > existing.capturedAt) {
      existing.capturedAt = obs.capturedAt
      existing.title = obs.title
    }
  }

  return order.map((fp) => map.get(fp)!)
}

function dedupeStrings(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const key = item.trim()
    if (!key || seen.has(key)) {
      continue
    }
    seen.add(key)
    out.push(key)
  }
  return out
}

function formatDate(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * LLM 提炼失败时的降级：包装现有零 LLM consolidateObservations。
 */
export function consolidateFallback(
  observations: readonly MemoryObservation[],
  options: ConsolidateOptions = {}
): string {
  return consolidateObservations(observations, options)
}

/**
 * 将 LLM 提炼的结构化字段格式化为 episodic Markdown；可选 autoMerge 块。
 */
export function consolidateExtracted(
  extracted: readonly ExtractedMemory[],
  sessionId: string,
  options: ConsolidateExtractedOptions = {}
): ConsolidateExtractedResult {
  if (extracted.length === 0) {
    return { episodicMarkdown: '', memoryAppendMarkdown: '' }
  }

  const dateStr = formatDate(options.now?.() ?? Date.now())
  const episodicLines: string[] = [`## ${dateStr} — session ${sessionId}`, '']
  const mergeLines: string[] = []

  for (const item of extracted) {
    episodicLines.push(`- **需求**：${item.userNeed}`)
    episodicLines.push(`  **方案**：${item.approach}`)
    episodicLines.push(`  **结果**：${item.outcome}`)
    if (item.whatFailed.trim()) {
      episodicLines.push(`  ⚠️ 踩坑：${item.whatFailed}`)
    }
    if (item.whatWorked.trim()) {
      episodicLines.push(`  ✅ 有效：${item.whatWorked}`)
    }
    if (item.tags.length > 0) {
      episodicLines.push(`  标签：${item.tags.join(', ')}`)
    }
    episodicLines.push('')

    if (options.autoMergeEnabled && shouldAutoMergeExtracted(item)) {
      mergeLines.push(`- ${item.userNeed}（${item.outcome}）`)
      if (item.whatFailed.trim()) {
        mergeLines.push(`  踩坑：${item.whatFailed}`)
      }
      if (item.whatWorked.trim()) {
        mergeLines.push(`  有效：${item.whatWorked}`)
      }
    }
  }

  episodicLines.push('---', '')

  const memoryAppendMarkdown =
    mergeLines.length > 0
      ? [`\n## ${dateStr} 提炼摘要`, '', ...mergeLines, ''].join('\n')
      : ''

  return {
    episodicMarkdown: episodicLines.join('\n'),
    memoryAppendMarkdown
  }
}

/** 高分规则：有踩坑记录，或结果含成功/完成 */
export function shouldAutoMergeExtracted(item: ExtractedMemory): boolean {
  if (item.whatFailed.trim()) {
    return true
  }
  return /成功|完成/.test(item.outcome)
}
