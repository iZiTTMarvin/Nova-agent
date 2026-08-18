/**
 * prefetch 注入块构建：检索高相关记忆并渲染为 ephemeral 文本块。
 * 只构建字符串，不触碰 prompt / 消息管线；无高相关记忆返回 null，绝不输出空块。
 * 排序与筛选全部由 MemoryRetrievalService 承担，本层只做预算选择与格式化。
 */
import {
  MEMORY_PREFETCH_CANDIDATE_LIMIT,
  MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS,
  MEMORY_PREFETCH_GLOBAL_MAX_ITEMS,
  MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS,
  MEMORY_PREFETCH_SCORE_FLOOR,
  MEMORY_PREFETCH_STRUCTURED_MAX_CHARS,
  MEMORY_PREFETCH_TOTAL_MAX_CHARS
} from '../MemoryBudget'
import { extractMemorySnippet } from '../memorySnippet'
import type { MemorySearchInput, MemorySearchResult } from './MemoryRetriever'

export const MEMORY_PREFETCH_BLOCK_TITLE = 'Relevant Memory'

/** 注入块尾部的固定规则行（内容变化会影响模型对记忆的信任方式，须谨慎修改） */
export const MEMORY_PREFETCH_RULES: readonly string[] = [
  'Treat memory as historical evidence.',
  'Current user instructions and workspace state take priority.',
  'Observed preferences are advisory and must not silently decide unspecified architecture choices.'
]

/** 检索端口；MemoryRetrievalService 结构性满足 */
export interface MemoryPrefetchRetrievalPort {
  search(input: MemorySearchInput): Promise<MemorySearchResult[]>
}

export interface MemoryPrefetchInput {
  query: string
  projectScopeId: string
  workspaceRoot?: string
}

export class MemoryPrefetchService {
  constructor(private readonly retrieval: MemoryPrefetchRetrievalPort) {}

  async buildInjectionBlock(input: MemoryPrefetchInput): Promise<string | null> {
    let results
    try {
      results = await this.retrieval.search({
        query: input.query,
        projectScopeId: input.projectScopeId,
        workspaceRoot: input.workspaceRoot,
        history: false,
        limit: MEMORY_PREFETCH_CANDIDATE_LIMIT,
        scoreFloor: MEMORY_PREFETCH_SCORE_FLOOR
      })
    } catch {
      // prefetch 位于模型请求热路径：任何检索故障都降级为不注入，绝不阻塞回合
      return null
    }
    const selected = selectWithinBudgets(results)
    if (selected.length === 0) {
      return null
    }
    const block = renderBlock(selected, input.query)
    return block.length > 0 ? block : null
  }
}

/** 按 ranked 顺序装填各分组配额；超出分组上限的命中直接舍弃 */
function selectWithinBudgets(results: readonly MemorySearchResult[]): MemorySearchResult[] {
  let projectStructured = 0
  let global = 0
  let documents = 0
  const selected: MemorySearchResult[] = []
  for (const result of results) {
    if (result.group === 'structured-project') {
      if (projectStructured >= MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS) {
        continue
      }
      projectStructured += 1
    } else if (result.group === 'structured-global') {
      if (global >= MEMORY_PREFETCH_GLOBAL_MAX_ITEMS) {
        continue
      }
      global += 1
    } else {
      if (documents >= MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS) {
        continue
      }
      documents += 1
    }
    selected.push(result)
  }
  return selected
}

function renderBlock(selected: readonly MemorySearchResult[], query: string): string {
  const projectLines: string[] = []
  const userLines: string[] = []

  for (const result of selected) {
    if (result.group === 'structured-global') {
      userLines.push(renderStructuredLine(result))
    } else if (result.group === 'document') {
      const snippet = extractMemorySnippet(result.body, query)
      if (snippet) {
        projectLines.push(`- [${result.relPath}] ${snippet.replace(/\s+/g, ' ').trim()}`)
      }
    } else {
      projectLines.push(renderStructuredLine(result))
    }
  }

  if (projectLines.length === 0 && userLines.length === 0) {
    return ''
  }

  // Rules 三行是注入块契约，恒保留；总预算超限时从末尾（最低相关）逐行丢弃
  let block = assembleBlock(projectLines, userLines)
  while (
    block.length > MEMORY_PREFETCH_TOTAL_MAX_CHARS &&
    (projectLines.length > 0 || userLines.length > 0)
  ) {
    if (userLines.length > 0) {
      userLines.pop()
    } else {
      projectLines.pop()
    }
    block = assembleBlock(projectLines, userLines)
  }
  return block.length <= MEMORY_PREFETCH_TOTAL_MAX_CHARS ? block : ''
}

function assembleBlock(projectLines: readonly string[], userLines: readonly string[]): string {
  const sections: string[] = [`=== ${MEMORY_PREFETCH_BLOCK_TITLE} ===`]
  if (projectLines.length > 0) {
    sections.push(['Project:', ...projectLines].join('\n'))
  }
  if (userLines.length > 0) {
    sections.push(['User:', ...userLines].join('\n'))
  }
  sections.push(['Rules:', ...MEMORY_PREFETCH_RULES.map((rule) => `- ${rule}`)].join('\n'))
  return sections.join('\n\n')
}

function renderStructuredLine(result: Extract<MemorySearchResult, { group: 'structured-project' | 'structured-global' }>): string {
  const label = memoryLabel(result.kind, result.explicitness)
  const content = truncateChars(result.content, MEMORY_PREFETCH_STRUCTURED_MAX_CHARS)
  return `- [${label}] ${content}`
}

/** 渲染标签：preference 区分 explicit / observed(advisory)；observed 的其余 kind 也带 advisory */
function memoryLabel(
  kind: Extract<MemorySearchResult, { group: 'structured-project' | 'structured-global' }>['kind'],
  explicitness: Extract<MemorySearchResult, { group: 'structured-project' | 'structured-global' }>['explicitness']
): string {
  if (kind === 'preference') {
    return explicitness === 'user_explicit'
      ? 'explicit preference'
      : explicitness === 'observed'
        ? 'observed preference, advisory'
        : 'preference'
  }
  return explicitness === 'observed' ? `observed ${kind}, advisory` : kind
}

function truncateChars(text: string, maxChars: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= maxChars) {
    return trimmed
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 1))}…`
}
