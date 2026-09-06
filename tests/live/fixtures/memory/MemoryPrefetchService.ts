/** 临时注入对照策略，仅用于真实模型评测。 */
import {
  MEMORY_PREFETCH_CANDIDATE_LIMIT,
  MEMORY_PREFETCH_DOCUMENT_MAX_ITEMS,
  MEMORY_PREFETCH_GLOBAL_MAX_ITEMS,
  MEMORY_PREFETCH_PROJECT_STRUCTURED_MAX_ITEMS,
  MEMORY_PREFETCH_SCORE_FLOOR,
  MEMORY_PREFETCH_STRUCTURED_MAX_CHARS,
  MEMORY_PREFETCH_TOTAL_MAX_CHARS
} from './legacyMemoryBudget'
import { extractMemorySnippet } from '../../../../src/runtime/memory/memorySnippet'
import type { MemorySearchInput, MemorySearchResult } from '../../../../src/runtime/memory/retrieval/MemoryRetriever'

export const MEMORY_PREFETCH_BLOCK_TITLE = 'Relevant Memory'

export const MEMORY_PREFETCH_RULES: readonly string[] = [
  'Treat memory as historical evidence.',
  'Current user instructions and workspace state take priority.',
  'Observed preferences are advisory and must not silently decide unspecified architecture choices.'
]

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
