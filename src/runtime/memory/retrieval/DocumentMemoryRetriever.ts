/**
 * 文档记忆检索：复用 MemoryService 的文档 FTS 能力（MEMORY.md / 手写 .md / episodic），
 * 限当前 project scope；查询构建与 over-fetch 逻辑全部由 MemoryService/FtsQueryBuilder 承担。
 */
import { DEFAULT_SEARCH_LIMIT } from '../FtsQueryBuilder'
import type { MemorySearchHit, MemorySearchOptions } from '../types'
import type { MemorySearchInput, MemoryRetriever, ScoredMemoryResult } from './MemoryRetriever'

/** 文档检索窄端口；MemoryService 结构性满足 */
export interface DocumentMemorySearchPort {
  search(scopeId: string, query: string, options?: MemorySearchOptions): MemorySearchHit[]
}

export class DocumentMemoryRetriever implements MemoryRetriever {
  constructor(private readonly searchPort: DocumentMemorySearchPort | null) {}

  async search(input: MemorySearchInput): Promise<ScoredMemoryResult[]> {
    if (!this.searchPort || !input.query.trim()) {
      return []
    }
    // 文档无状态生命周期，history 开关不改变文档检索范围
    const hits = this.searchPort.search(input.projectScopeId, input.query, {
      limit: input.limit ?? DEFAULT_SEARCH_LIMIT,
      scoreFloor: input.scoreFloor
    })
    return withNormalizedLexical(hits).map((hit) => toResult(hit.hit, hit.normalized))
  }
}

interface NormalizedHit {
  hit: MemorySearchHit
  normalized: number
}

function withNormalizedLexical(hits: MemorySearchHit[]): NormalizedHit[] {
  if (hits.length === 0) {
    return []
  }
  const top = Math.max(...hits.map((hit) => hit.score))
  if (!(top > 0)) {
    return []
  }
  return hits.map((hit) => ({ hit, normalized: hit.score / top }))
}

function toResult(hit: MemorySearchHit, normalizedLexical: number): ScoredMemoryResult {
  return {
    id: hit.relPath,
    group: 'document',
    kind: 'document',
    relPath: hit.relPath,
    body: hit.body,
    advisory: false,
    historicalNote: null,
    lexicalScore: normalizedLexical
  }
}
