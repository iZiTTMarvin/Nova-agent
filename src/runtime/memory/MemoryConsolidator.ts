/**
 * MemoryConsolidator — working buffer → episodic Markdown 块（零 LLM 纯逻辑）
 *
 * 按 fingerprint 去重合并，输出带日期与 sessionId 的摘要块，供 append-only 落盘。
 * 它只负责用户可读历史；结构化长期记忆由候选管线（extraction → policy → repository）落库。
 */
import type { MemoryObservation } from './ObservationCapture'

/** episodic 摘要相对路径（仅允许 append，禁止写 MEMORY.md） */
export const EPISODIC_SUMMARY_REL_PATH = 'episodic/summary.md'

export interface ConsolidateOptions {
  /** 注入时钟（单测用） */
  now?: () => number
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
