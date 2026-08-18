/**
 * 检索组合层：并行取结构化与文档结果 → 默认检索前做 source 懒校验 →
 * 确定性 rerank → 条数截断 → 剥离内部排序分。零 LLM 调用。
 * 单路检索失败 fail-soft 降级为另一路；两路全部失败时上抛（调用方给出可理解错误）。
 * vector provider 为可选扩展位：缺省 null 时不参与任何路径，不产生错误。
 */
import { DEFAULT_SEARCH_LIMIT } from '../FtsQueryBuilder'
import type { MemoryVerifier } from '../lifecycle/MemoryVerifier'
import { rankMemoryResults } from './memoryRanking'
import type {
  MemoryRetriever,
  MemorySearchInput,
  MemorySearchResult,
  MemoryVectorProvider,
  ScoredMemoryResult
} from './MemoryRetriever'
import { stripLexicalScore } from './MemoryRetriever'

export interface MemoryRetrievalServiceDeps {
  structuredRetriever: MemoryRetriever
  documentRetriever: MemoryRetriever
  /** source-bound 记录懒校验；缺省 null 时跳过校验 */
  verifier?: MemoryVerifier | null
  /** vector 扩展位；在通过评测消融验证前不提供实现 */
  vectorProvider?: MemoryVectorProvider | null
  /** 时间源（ms）；测试注入固定时钟 */
  now?: () => number
}

export class MemoryRetrievalService {
  private readonly nowFn: () => number

  constructor(private readonly deps: MemoryRetrievalServiceDeps) {
    this.nowFn = deps.now ?? Date.now
  }

  async search(input: MemorySearchInput): Promise<MemorySearchResult[]> {
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT
    const scopedInput: MemorySearchInput = { ...input, limit }

    const [structured, document] = await Promise.all([
      trySearch(this.deps.structuredRetriever, scopedInput),
      trySearch(this.deps.documentRetriever, scopedInput)
    ])

    // 两路同时失败说明记忆存储整体不可用，不能吞成「未找到相关记忆」
    if (structured.error !== null && document.error !== null) {
      throw toError(structured.error)
    }

    let merged: ScoredMemoryResult[] = [...structured.results, ...document.results]
    // source 懒校验只在默认检索触发：history 是追溯查询，不做失效淘汰、直接带标注返回
    if (!input.history && this.deps.verifier) {
      const verifier = this.deps.verifier
      merged = merged.filter(
        (result) =>
          result.group === 'document' ||
          result.source === null ||
          verifier.verify({ id: result.id, source: result.source }, input.workspaceRoot) !== 'stale'
      )
    }

    const ranked = rankMemoryResults(merged, input.query, this.nowFn())
    return ranked.slice(0, limit).map(stripLexicalScore)
  }
}

interface RetrieverOutcome {
  results: ScoredMemoryResult[]
  error: unknown | null
}

/** 单路失败不拖垮另一路 */
async function trySearch(retriever: MemoryRetriever, input: MemorySearchInput): Promise<RetrieverOutcome> {
  try {
    return { results: await retriever.search(input), error: null }
  } catch (err) {
    return { results: [], error: err }
  }
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err))
}
