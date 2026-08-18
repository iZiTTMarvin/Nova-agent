/**
 * 结构化记忆检索：包装 repository.searchFts，做 scope 归并与 lexical 归一。
 * 只读不改状态；source-bound 懒校验由组合层在结果参与默认检索前触发。
 */
import { GLOBAL_SCOPE_ID } from '../MemoryPaths'
import { computeOverFetchLimit, DEFAULT_SEARCH_LIMIT } from '../FtsQueryBuilder'
import type { MemoryRepository, MemoryRecordFtsHit } from '../repository/MemoryRepository'
import type {
  MemoryHistoricalNote,
  MemorySearchInput,
  MemoryRetriever,
  ScoredMemoryResult
} from './MemoryRetriever'

export class StructuredMemoryRetriever implements MemoryRetriever {
  constructor(private readonly repository: MemoryRepository) {}

  async search(input: MemorySearchInput): Promise<ScoredMemoryResult[]> {
    const fetchLimit = computeOverFetchLimit(input.limit ?? DEFAULT_SEARCH_LIMIT)
    const status = input.history ? 'any' : 'active'

    // 精确 scope 各查一次：scopeKinds 过滤会把其他项目的记录带进结果，禁止
    const projectHits = this.repository.searchFts(input.query, {
      scope: { scopeKind: 'project', scopeId: input.projectScopeId },
      status,
      limit: fetchLimit
    })
    const globalHits = this.repository.searchFts(input.query, {
      scope: { scopeKind: 'global', scopeId: GLOBAL_SCOPE_ID },
      status,
      limit: fetchLimit
    })

    // pending 是未确认候选而非历史事实，任何检索模式都不外显
    const hits = [...projectHits, ...globalHits].filter((hit) => hit.record.status !== 'pending')
    return withNormalizedLexical(hits, input.scoreFloor).map((hit) => toResult(hit.record, hit.normalized))
  }
}

interface NormalizedHit {
  record: MemoryRecordFtsHit['record']
  normalized: number
}

/** 池内归一（top = 1）并按相对 floor 裁剪；top 恒留 */
function withNormalizedLexical(hits: MemoryRecordFtsHit[], scoreFloor?: number): NormalizedHit[] {
  if (hits.length === 0) {
    return []
  }
  const top = Math.max(...hits.map((hit) => hit.score))
  if (!(top > 0)) {
    return []
  }
  const floor = scoreFloor ?? 0
  return hits
    .filter((hit) => hit.score >= top * floor)
    .map((hit) => ({ record: hit.record, normalized: hit.score / top }))
}

function toResult(
  record: MemoryRecordFtsHit['record'],
  normalizedLexical: number
): ScoredMemoryResult {
  return {
    id: record.id,
    group: record.scopeKind === 'project' ? 'structured-project' : 'structured-global',
    kind: record.kind,
    content: record.content,
    status: record.status,
    explicitness: record.explicitness,
    confidence: record.confidence,
    memoryKey: record.memoryKey,
    lastSeenAt: record.lastSeenAt,
    advisory: record.explicitness === 'observed',
    historicalNote: historicalNoteOf(record.status),
    source:
      record.sourcePath !== null && record.sourceFingerprint !== null
        ? { path: record.sourcePath, fingerprint: record.sourceFingerprint }
        : null,
    lexicalScore: normalizedLexical
  }
}

export function historicalNoteOf(status: MemoryRecordFtsHit['record']['status']): MemoryHistoricalNote | null {
  if (status === 'superseded' || status === 'retracted' || status === 'needs_verification') {
    return status === 'needs_verification' ? 'needs-verification' : status
  }
  return null
}
