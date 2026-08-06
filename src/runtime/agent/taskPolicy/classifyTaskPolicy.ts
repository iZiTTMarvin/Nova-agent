/**
 * 任务策略分类：三路信号独立累计，heavy 与 economy 互斥且 heavy 优先。
 * 纯函数，无副作用；交互面不产生任何注入文案，surface 仅用于把硬约束限制在 headless。
 */
import {
  buildEconomyHardConstraints,
  buildHeavyGuidance
} from './economyPrompt'
import type {
  ResolvedTaskPolicy,
  TaskPolicyMatchSource,
  TaskPolicySignals,
  TaskPolicyTier
} from './types'

const ECONOMY_CATEGORIES = new Set([
  'data-processing',
  'csv-processing',
  'data_processing',
  'csv_processing'
])

const HEAVY_CATEGORIES = new Set([
  'refactor',
  'architecture',
  'multi-file',
  'multi_file',
  'cross-module',
  'cross_module'
])

const ECONOMY_TAGS = new Set(['summary', 'log-analysis', 'log_analysis', 'csv'])

const HEAVY_TAGS = new Set(['refactor', 'architecture', 'migration', 'multi-file'])

/** 指令文本 economy 关键词（大小写不敏感） */
const ECONOMY_INSTRUCTION_PATTERNS: RegExp[] = [
  /\bwrite\s+a\s+csv\b/i,
  /\bgenerate\s+a\s+csv\b/i,
  /\bcount\s+how\s+many\b/i,
  /\bsummarize\b/i,
  /写\s*一?个?\s*csv/i,
  /生成\s*一?个?\s*csv/i,
  /统计\s*多少/i,
  /汇总|摘要|总结/
]

const HEAVY_INSTRUCTION_PATTERNS: RegExp[] = [
  /\brefactor\b/i,
  /\barchitecture\b/i,
  /\bmulti[-_\s]?file\b/i,
  /\bcross[-_\s]?module\b/i,
  /重构/,
  /架构/,
  /跨模块/,
  /多文件/
]

export function resolveTaskPolicy(signals: TaskPolicySignals): ResolvedTaskPolicy {
  const matchedBy: TaskPolicyMatchSource[] = []
  let economyHit = false
  let heavyHit = false

  if (signals.heavyTaskMode === true) {
    heavyHit = true
    matchedBy.push('config')
  }
  if (signals.economyTaskMode === true) {
    economyHit = true
    if (!matchedBy.includes('config')) matchedBy.push('config')
  }

  const category = normalizeToken(signals.category)
  if (category) {
    if (HEAVY_CATEGORIES.has(category)) {
      heavyHit = true
      pushUnique(matchedBy, 'metadata')
    }
    if (ECONOMY_CATEGORIES.has(category)) {
      economyHit = true
      pushUnique(matchedBy, 'metadata')
    }
  }

  for (const tag of signals.tags ?? []) {
    const t = normalizeToken(tag)
    if (!t) continue
    if (HEAVY_TAGS.has(t)) {
      heavyHit = true
      pushUnique(matchedBy, 'metadata')
    }
    if (ECONOMY_TAGS.has(t)) {
      economyHit = true
      pushUnique(matchedBy, 'metadata')
    }
  }

  const instruction = signals.instruction ?? ''
  if (HEAVY_INSTRUCTION_PATTERNS.some(p => p.test(instruction))) {
    heavyHit = true
    pushUnique(matchedBy, 'instruction')
  }
  if (ECONOMY_INSTRUCTION_PATTERNS.some(p => p.test(instruction))) {
    economyHit = true
    pushUnique(matchedBy, 'instruction')
  }

  // heavy 与 economy 互斥，heavy 优先
  const tier: TaskPolicyTier = heavyHit ? 'heavy' : economyHit ? 'economy' : 'default'

  return {
    tier,
    matchedBy: tier === 'default' ? [] : matchedBy,
    systemLayerText: buildSystemLayerText(tier, signals.surface),
    toolEconomy: tier === 'economy'
  }
}

function buildSystemLayerText(tier: TaskPolicyTier, surface: TaskPolicySignals['surface']): string {
  if (surface !== 'headless') return ''
  if (tier === 'economy') return buildEconomyHardConstraints()
  if (tier === 'heavy') return buildHeavyGuidance()
  return ''
}

function normalizeToken(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/\s+/g, '-')
}

function pushUnique(list: TaskPolicyMatchSource[], item: TaskPolicyMatchSource): void {
  if (!list.includes(item)) list.push(item)
}
