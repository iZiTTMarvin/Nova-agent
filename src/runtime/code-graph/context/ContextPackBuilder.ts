import type {
  CodeContextIntent,
  CodeContextRequestedIntent,
  CodeEvidenceConfidence,
  CodeFileEdgeKind,
  CodeIndexCoverage,
  CodeIndexStatus,
  CodeRelationResolver,
  CodeSymbolEdgeKind,
  CodeSymbolKind
} from '../types'
import type {
  CodeGraphQueryEvidence,
  CodeGraphReader,
  CodeGraphUnresolvedCandidate
} from '../graph/queries/CodeGraphReader'
import {
  CODE_CONTEXT_LIMITS,
  RankingPolicy,
  type RankedCodeAnchor,
  type RankedCodeRelation,
  type RecommendedReadRange
} from './RankingPolicy'

export interface CodeContextBuildRequest {
  readonly query: string
  readonly intent?: CodeContextRequestedIntent
  readonly scope?: string
  readonly status: CodeIndexStatus
  readonly abortSignal?: AbortSignal
}

export interface CodeContextAnchor {
  readonly kind: CodeSymbolKind
  readonly name: string
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly score: number
}

export interface CodeContextRelation {
  readonly type: CodeSymbolEdgeKind | CodeFileEdgeKind
  readonly from: string
  readonly to: string
  readonly confidence: CodeEvidenceConfidence
  readonly resolver: CodeRelationResolver
  readonly sourceFile: string
  readonly sourceLine: number
  readonly depth: 1 | 2
}

export interface CodeContextRecommendedRead {
  readonly path: string
  readonly startLine: number
  readonly endLine: number
  readonly reason: string
}

export interface CodeContextPack {
  readonly status: CodeIndexStatus
  readonly revision: number
  readonly summary: string
  readonly intent: CodeContextRequestedIntent
  readonly anchors: readonly CodeContextAnchor[]
  readonly relations: readonly CodeContextRelation[]
  readonly recommendedReads: readonly CodeContextRecommendedRead[]
  readonly coverage: CodeIndexCoverage
  readonly warnings: readonly string[]
}

export interface ContextPackBuilderOptions {
  readonly reader: CodeGraphReader
  readonly rankingPolicy?: RankingPolicy
}

/** 把只读查询证据收敛为有预算、字节稳定的 Agent 导航包。 */
export class ContextPackBuilder {
  private readonly rankingPolicy: RankingPolicy

  constructor(private readonly options: ContextPackBuilderOptions) {
    this.rankingPolicy = options.rankingPolicy ?? new RankingPolicy()
  }

  async build(request: CodeContextBuildRequest): Promise<string> {
    throwIfAborted(request.abortSignal)
    const intent = request.intent ?? 'locate'
    const query = this.rankingPolicy.normalizeQuery(request.query)
    const scope = this.rankingPolicy.normalizeScope(request.scope)
    const evidence = await this.options.reader.readEvidence({
      query,
      scope,
      relationDepth: intent === 'impact' ? 2 : intent === 'understand' ? 1 : 0
    })
    throwIfAborted(request.abortSignal)

    const rankedAnchors = this.rankingPolicy.rankAnchors(evidence.anchors, query)
      .slice(0, CODE_CONTEXT_LIMITS.anchors)
    const rankedRelations = intent === 'locate' || intent === 'flow'
      ? []
      : this.rankingPolicy.rankRelations(evidence.relations, rankedAnchors, intent)
        .slice(0, CODE_CONTEXT_LIMITS.relations)
    const relevantUnresolved = filterUnresolved(evidence, rankedAnchors)
    const warnings = buildWarnings(
      request.status,
      intent,
      evidence,
      relevantUnresolved,
      rankedRelations
    )
    const pack = createPack(
      request.status,
      intent,
      evidence,
      rankedAnchors,
      rankedRelations,
      warnings,
      this.rankingPolicy
    )
    return serializeWithinBudget(pack)
  }
}

function createPack(
  status: CodeIndexStatus,
  intent: CodeContextRequestedIntent,
  evidence: CodeGraphQueryEvidence,
  anchors: readonly RankedCodeAnchor[],
  relations: readonly RankedCodeRelation[],
  warnings: readonly string[],
  policy: RankingPolicy
): CodeContextPack {
  return Object.freeze({
    status,
    revision: evidence.snapshot.revision,
    summary: buildSummary(status, intent, anchors, relations, evidence.snapshot.coverage),
    intent,
    anchors: Object.freeze(anchors.map(toContextAnchor)),
    relations: Object.freeze(relations.map(toContextRelation)),
    recommendedReads: Object.freeze(buildRecommendedReads(anchors, relations, policy)),
    coverage: evidence.snapshot.coverage,
    warnings: Object.freeze(warnings)
  })
}

function toContextAnchor(anchor: RankedCodeAnchor): CodeContextAnchor {
  return Object.freeze({
    kind: anchor.kind,
    name: anchor.name,
    path: anchor.path,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    score: anchor.score
  })
}

function toContextRelation(relation: RankedCodeRelation): CodeContextRelation {
  return Object.freeze({
    type: relation.type,
    from: relation.from,
    to: relation.to,
    confidence: relation.confidence,
    resolver: relation.resolver,
    sourceFile: relation.sourceFile,
    sourceLine: relation.sourceLine,
    depth: relation.depth
  })
}

function buildRecommendedReads(
  anchors: readonly RankedCodeAnchor[],
  relations: readonly RankedCodeRelation[],
  policy: RankingPolicy
): CodeContextRecommendedRead[] {
  const reads: CodeContextRecommendedRead[] = []
  const seen = new Set<string>()
  for (const anchor of anchors) {
    addRead(reads, seen, policy.recommendedRange(anchor), `${anchor.kind} 定义`)
  }
  for (const relation of relations) {
    addRead(reads, seen, policy.relationReadRange(relation), `${relation.type} 关系证据`)
  }
  return reads.slice(0, CODE_CONTEXT_LIMITS.recommendedReads)
}

function addRead(
  reads: CodeContextRecommendedRead[],
  seen: Set<string>,
  range: RecommendedReadRange,
  reason: string
): void {
  const key = `${range.path}:${range.startLine}:${range.endLine}`
  if (seen.has(key)) return
  seen.add(key)
  reads.push(Object.freeze({ ...range, reason }))
}

function filterUnresolved(
  evidence: CodeGraphQueryEvidence,
  anchors: readonly RankedCodeAnchor[]
): CodeGraphUnresolvedCandidate[] {
  const fileIds = new Set(anchors.map((anchor) => anchor.fileId))
  const symbolIds = new Set(anchors.map((anchor) => anchor.stableId))
  return evidence.unresolved.filter((item) =>
    fileIds.has(item.fileId) ||
    (item.sourceSymbolStableId !== null && symbolIds.has(item.sourceSymbolStableId))
  )
}

function buildWarnings(
  status: CodeIndexStatus,
  intent: CodeContextRequestedIntent,
  evidence: CodeGraphQueryEvidence,
  unresolved: readonly CodeGraphUnresolvedCandidate[],
  relations: readonly RankedCodeRelation[]
): string[] {
  const warnings: string[] = []
  if (intent === 'flow') {
    warnings.push('flow 当前不可用；请改用 impact，跨层通道可继续用 grep 定位')
  }
  if (status === 'building' && evidence.snapshot.activeGeneration === null) {
    warnings.push('索引仍在首次构建；请继续使用 grep/read，稍后重试')
  } else if (status === 'updating') {
    warnings.push('查询使用最近一次已提交 revision，结果可能落后于最新文件修改')
  } else if (status === 'degraded') {
    warnings.push('索引处于降级状态；结果只代表当前可用证据')
  } else if (status === 'unavailable') {
    warnings.push('索引当前不可用；请改用 grep/read')
  }

  const coverage = evidence.snapshot.coverage
  if (coverage.parseFailures > 0 || coverage.unsupportedFiles > 0 || coverage.oversizedFiles > 0) {
    warnings.push(
      `覆盖不完整：解析失败 ${coverage.parseFailures}，不支持 ${coverage.unsupportedFiles}，超大 ${coverage.oversizedFiles}`
    )
  }
  if (unresolved.length > 0) {
    const reasons = countReasons(unresolved)
    warnings.push(`相关未解析关系 ${unresolved.length} 条（${reasons}）；不能据此判断无影响`)
  } else if (intent === 'impact' && relations.length === 0) {
    warnings.push('没有发现已解析影响候选；当前结果不能证明没有上游影响')
  }
  return warnings
}

function countReasons(unresolved: readonly CodeGraphUnresolvedCandidate[]): string {
  const counts = new Map<string, number>()
  for (const item of unresolved) counts.set(item.reason, (counts.get(item.reason) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([reason, count]) => `${reason}:${count}`)
    .join(', ')
}

function buildSummary(
  status: CodeIndexStatus,
  intent: CodeContextRequestedIntent,
  anchors: readonly Pick<CodeContextAnchor, 'name' | 'path' | 'startLine'>[],
  relations: readonly Pick<CodeContextRelation, 'depth'>[],
  coverage: CodeIndexCoverage
): string {
  if (intent === 'flow') {
    return `${status} · flow · 当前版本不提供多跳代码流；建议改用 impact 或 grep`
  }
  const first = anchors[0]
  if (!first) {
    const suffix = intent === 'impact'
      ? '；不能据此判断无影响'
      : ''
    return `${status} · ${intent} · 未找到已索引锚点（${coverage.indexedFiles}/${coverage.eligibleFiles} 文件）${suffix}`
  }
  let relationPart: string
  if (intent === 'locate') {
    relationPart = `；另有 ${Math.max(0, anchors.length - 1)} 处相关锚点`
  } else if (intent === 'understand') {
    relationPart = `；返回 ${relations.length} 条直接关系`
  } else {
    const directCount = relations.filter((relation) => relation.depth === 1).length
    const secondHopCount = relations.length - directCount
    relationPart = `；返回 ${directCount} 条直接关系、${secondHopCount} 条二跳候选`
  }
  return limitText(
    `${status} · ${intent} · ${first.name} 定义于 ${first.path}:${first.startLine}${relationPart}`,
    360
  )
}

function serializeWithinBudget(pack: CodeContextPack): string {
  const mutable = {
    status: pack.status,
    revision: pack.revision,
    summary: limitText(pack.summary, 360),
    intent: pack.intent,
    anchors: [...pack.anchors],
    relations: [...pack.relations],
    recommendedReads: [...pack.recommendedReads],
    coverage: pack.coverage,
    warnings: pack.warnings.map((warning) => limitText(warning, 240))
  }
  const stringify = (): string => {
    mutable.summary = limitText(buildSummary(
      mutable.status,
      mutable.intent,
      mutable.anchors,
      mutable.relations,
      mutable.coverage
    ), 360)
    return JSON.stringify(mutable)
  }
  let text = stringify()
  if (Buffer.byteLength(text, 'utf8') <= CODE_CONTEXT_LIMITS.targetBytes) return text

  mutable.warnings.push('结果已按 6 KiB 目标预算确定性截断')
  while (
    Buffer.byteLength(stringify(), 'utf8') > CODE_CONTEXT_LIMITS.targetBytes &&
    mutable.recommendedReads.length > 0
  ) mutable.recommendedReads.pop()
  while (
    Buffer.byteLength(stringify(), 'utf8') > CODE_CONTEXT_LIMITS.targetBytes &&
    mutable.relations.length > 0
  ) mutable.relations.pop()
  while (
    Buffer.byteLength(stringify(), 'utf8') > CODE_CONTEXT_LIMITS.targetBytes &&
    mutable.anchors.length > 1
  ) mutable.anchors.pop()
  text = stringify()
  if (Buffer.byteLength(text, 'utf8') <= CODE_CONTEXT_LIMITS.hardBytes) return text

  const fallback = {
    status: pack.status,
    revision: pack.revision,
    summary: limitText(`${pack.status} · ${pack.intent} · 证据超过输出预算，未内联锚点与关系`, 160),
    intent: pack.intent,
    anchors: [],
    relations: [],
    recommendedReads: [],
    coverage: pack.coverage,
    warnings: ['结果超过内部预算；请缩小 query 或 scope 后重试']
  }
  text = JSON.stringify(fallback)
  if (Buffer.byteLength(text, 'utf8') > CODE_CONTEXT_LIMITS.hardBytes) {
    throw new Error('代码上下文核心状态超过硬预算')
  }
  return text
}

function limitText(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters - 3)}...`
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const error = new Error('代码上下文查询已取消')
  error.name = 'AbortError'
  throw error
}
