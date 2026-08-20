import * as path from 'node:path'
import type { CodeContextIntent, CodeEvidenceConfidence } from '../types'
import {
  CODE_CONTEXT_QUERY_MAX_CHARS,
  type CodeGraphAnchorCandidate,
  type CodeGraphNormalizedQuery,
  type CodeGraphRelationCandidate
} from '../graph/queries/CodeGraphReader'

export const CODE_CONTEXT_LIMITS = Object.freeze({
  anchors: 8,
  relations: 24,
  recommendedReads: 10,
  targetBytes: 6 * 1024,
  hardBytes: 12 * 1024
})

const ANCHOR_SCORES = Object.freeze({
  exactName: 1,
  exactQualifiedName: 0.97,
  exactPath: 0.94,
  identifierTokenBase: 0.8,
  identifierTokenRange: 0.09,
  ftsBase: 0.62,
  ftsRange: 0.08
})

const CONFIDENCE_SCORES: Readonly<Record<CodeEvidenceConfidence, number>> =
  Object.freeze({ confirmed: 0.9, probable: 0.74, heuristic: 0.48 })

const UNDERSTAND_RELATION_BONUS = Object.freeze({
  calls: 0.08,
  references: 0.07,
  extends: 0.08,
  implements: 0.08,
  overrides: 0.08,
  imports: 0.05,
  re_exports: 0.05,
  test_of: 0.04
})

const IMPACT_RELATION_BONUS = Object.freeze({
  calls: 0.12,
  references: 0.11,
  extends: 0.1,
  implements: 0.1,
  overrides: 0.1,
  imports: 0.1,
  re_exports: 0.08,
  test_of: 0.09
})

const INCOMING_IMPACT_BONUS = 0.06
const SECOND_HOP_PENALTY = 0.12
const READ_CONTEXT_BEFORE_LINES = 8
const READ_CONTEXT_AFTER_LINES = 20
const READ_MAX_LINES = 240

export interface RankedCodeAnchor extends CodeGraphAnchorCandidate {
  readonly score: number
}

export interface RankedCodeRelation extends CodeGraphRelationCandidate {
  readonly direction: 'incoming' | 'outgoing'
  readonly depth: 1 | 2
  readonly score: number
}

export interface RecommendedReadRange {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
}

/** 所有检索权重与稳定 tie-break 的唯一 Owner。 */
export class RankingPolicy {
  normalizeQuery(query: string): CodeGraphNormalizedQuery {
    if (query.length > CODE_CONTEXT_QUERY_MAX_CHARS) {
      throw new Error(`代码查询不得超过 ${CODE_CONTEXT_QUERY_MAX_CHARS} 个字符`)
    }
    const original = query.trim()
    if (!original) throw new Error('代码查询不能为空')
    const tokens = identifierQueryTokens(original)
    return Object.freeze({
      original,
      folded: original.replace(/\\/g, '/').toLowerCase(),
      tokens: Object.freeze(tokens)
    })
  }

  normalizeScope(scope?: string): string | null {
    if (scope === undefined || scope.trim() === '') return null
    const slashPath = scope.trim().replace(/\\/g, '/')
    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, '').replace(/\/$/, '')
    if (
      !normalized || normalized === '.' || normalized === '..' ||
      normalized.startsWith('../') || normalized.startsWith('/') ||
      /^[A-Za-z]:/.test(normalized)
    ) {
      throw new Error('代码查询 scope 必须位于工作区内')
    }
    return normalized
  }

  rankAnchors(
    candidates: readonly CodeGraphAnchorCandidate[],
    query: CodeGraphNormalizedQuery
  ): RankedCodeAnchor[] {
    return candidates.map((candidate) => Object.freeze({
      ...candidate,
      score: anchorScore(candidate, query)
    })).sort(compareAnchors)
  }

  rankRelations(
    candidates: readonly CodeGraphRelationCandidate[],
    anchors: readonly RankedCodeAnchor[],
    intent: Exclude<CodeContextIntent, 'locate'>
  ): RankedCodeRelation[] {
    const symbolIds = new Set(anchors.map((anchor) => anchor.stableId))
    const fileIds = new Set(anchors.map((anchor) => anchor.fileId))
    const ranked: RankedCodeRelation[] = []
    const directIds = new Set<string>()
    const neighborSymbolIds = new Set<string>()
    const neighborFileIds = new Set<number>()
    for (const candidate of candidates) {
      if (candidate.confidence === 'heuristic') continue
      const direction = relationDirection(candidate, symbolIds, fileIds)
      if (direction === null) continue
      directIds.add(candidate.stableId)
      addNeighbor(candidate, direction, neighborSymbolIds, neighborFileIds)
      ranked.push(Object.freeze({
        ...candidate,
        direction,
        depth: 1,
        score: relationScore(candidate, direction, intent, 1)
      }))
    }
    if (intent === 'impact') {
      for (const candidate of candidates) {
        if (directIds.has(candidate.stableId) || candidate.confidence === 'heuristic') continue
        const direction = relationDirection(candidate, neighborSymbolIds, neighborFileIds)
        if (direction === null) continue
        ranked.push(Object.freeze({
          ...candidate,
          direction,
          depth: 2,
          score: relationScore(candidate, direction, intent, 2)
        }))
      }
    }
    return ranked.sort(compareRelations)
  }

  recommendedRange(anchor: RankedCodeAnchor): RecommendedReadRange {
    const startLine = Math.max(1, anchor.startLine - READ_CONTEXT_BEFORE_LINES)
    const desiredEnd = Math.max(anchor.endLine, anchor.startLine + READ_CONTEXT_AFTER_LINES)
    const endLine = Math.min(
      anchor.fileLineCount,
      startLine + READ_MAX_LINES - 1,
      desiredEnd
    )
    return Object.freeze({ path: anchor.path, startLine, endLine })
  }

  relationReadRange(relation: RankedCodeRelation): RecommendedReadRange {
    return Object.freeze({
      path: relation.sourceFile,
      startLine: Math.max(1, relation.sourceLine - READ_CONTEXT_BEFORE_LINES),
      endLine: Math.min(
        relation.sourceFileLineCount,
        relation.sourceLine + READ_CONTEXT_AFTER_LINES
      )
    })
  }
}

function anchorScore(
  candidate: CodeGraphAnchorCandidate,
  query: CodeGraphNormalizedQuery
): number {
  if (candidate.exactName) return ANCHOR_SCORES.exactName
  if (candidate.exactQualifiedName) return ANCHOR_SCORES.exactQualifiedName
  if (candidate.exactPath) return ANCHOR_SCORES.exactPath
  const candidateTokens = new Set(candidate.identifierTokens.split(/\s+/).filter(Boolean))
  const matchedTokens = query.tokens.filter((token) => candidateTokens.has(token)).length
  if (matchedTokens > 0) {
    const ratio = matchedTokens / Math.max(1, query.tokens.length)
    return roundScore(
      ANCHOR_SCORES.identifierTokenBase + ANCHOR_SCORES.identifierTokenRange * ratio
    )
  }
  if (candidate.ftsRank === null) return 0
  const ftsQuality = 0.5 + Math.atan(-candidate.ftsRank) / Math.PI
  return roundScore(ANCHOR_SCORES.ftsBase + ANCHOR_SCORES.ftsRange * ftsQuality)
}

function relationDirection(
  candidate: CodeGraphRelationCandidate,
  symbolIds: ReadonlySet<string>,
  fileIds: ReadonlySet<number>
): 'incoming' | 'outgoing' | null {
  const sourceSelected = candidate.graphKind === 'symbol'
    ? candidate.sourceSymbolStableId !== null && symbolIds.has(candidate.sourceSymbolStableId)
    : fileIds.has(candidate.sourceFileId)
  const targetSelected = candidate.graphKind === 'symbol'
    ? candidate.targetSymbolStableId !== null && symbolIds.has(candidate.targetSymbolStableId)
    : fileIds.has(candidate.targetFileId)
  if (targetSelected && !sourceSelected) return 'incoming'
  if (sourceSelected) return 'outgoing'
  return targetSelected ? 'incoming' : null
}

function relationScore(
  candidate: CodeGraphRelationCandidate,
  direction: 'incoming' | 'outgoing',
  intent: Exclude<CodeContextIntent, 'locate'>,
  depth: 1 | 2
): number {
  const bonus = intent === 'impact'
    ? IMPACT_RELATION_BONUS[candidate.type]
    : UNDERSTAND_RELATION_BONUS[candidate.type]
  const incoming = intent === 'impact' && direction === 'incoming'
    ? INCOMING_IMPACT_BONUS
    : 0
  const depthPenalty = depth === 2 ? SECOND_HOP_PENALTY : 0
  return roundScore(Math.min(
    1,
    CONFIDENCE_SCORES[candidate.confidence] + bonus + incoming - depthPenalty
  ))
}

function addNeighbor(
  candidate: CodeGraphRelationCandidate,
  direction: 'incoming' | 'outgoing',
  symbolIds: Set<string>,
  fileIds: Set<number>
): void {
  const symbolId = direction === 'incoming'
    ? candidate.sourceSymbolStableId
    : candidate.targetSymbolStableId
  const fileId = direction === 'incoming'
    ? candidate.sourceFileId
    : candidate.targetFileId
  if (symbolId) symbolIds.add(symbolId)
  fileIds.add(fileId)
}

function compareAnchors(left: RankedCodeAnchor, right: RankedCodeAnchor): number {
  return right.score - left.score ||
    left.path.localeCompare(right.path, 'en') ||
    left.startLine - right.startLine ||
    left.stableId.localeCompare(right.stableId, 'en')
}

function compareRelations(left: RankedCodeRelation, right: RankedCodeRelation): number {
  return left.depth - right.depth ||
    right.score - left.score ||
    confidenceRank(right.confidence) - confidenceRank(left.confidence) ||
    left.sourceFile.localeCompare(right.sourceFile, 'en') ||
    left.sourceLine - right.sourceLine ||
    left.stableId.localeCompare(right.stableId, 'en')
}

function confidenceRank(confidence: CodeEvidenceConfidence): number {
  switch (confidence) {
    case 'confirmed': return 3
    case 'probable': return 2
    case 'heuristic': return 1
  }
}

function identifierQueryTokens(query: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  for (const segment of query.match(/[A-Za-z0-9]+/g) ?? []) {
    const split = segment
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    for (const token of [...split, segment.toLowerCase()]) {
      if (!seen.has(token)) {
        seen.add(token)
        tokens.push(token)
      }
    }
  }
  return tokens
}

function roundScore(score: number): number {
  return Math.round(score * 10_000) / 10_000
}
