/**
 * 大纲骨架构建：取证 → 按 token 预算装箱 → 模型编译（至多一次 schema 修复）→ 校验出处 → 发布。
 * 预算先定、内容后装，首次请求在构造上就不会超预算；失败一律返回结构化 code，由调度方映射成人话。
 */
import { createHash, randomUUID } from 'node:crypto'
import type { ModelClient } from '../../model/ModelClient'
import type { ChatMessage } from '../../model/types'
import {
  LEARNING_COMPILE_OUTPUT_RESERVE_TOKENS,
  LEARNING_MAX_COMPILE_OUTPUT_BYTES,
  LEARNING_SCHEMA_REPAIR_MAX_EXTRA_CALLS,
  LEARNING_SKELETON_INPUT_TOKEN_CAP,
  LEARNING_SKELETON_MIN_INPUT_TOKENS
} from '../../../shared/learning/buildLimits'
import type { LearningBuildStage } from '../../../shared/learning/surface'
import { estimateTextTokens } from '../../../shared/model/tokenEstimate'
import { takeEvidencePrefix, WorkspaceEvidencePort } from '../knowledge/evidence/WorkspaceEvidencePort'
import type { EvidenceFragment, EvidencePackage, ProjectLayoutEntry } from '../knowledge/evidence/evidenceTypes'
import {
  buildCompileRepairUserMessage,
  parseCompileOutputText,
  type CompileOutput
} from './compileOutputSchema'
import { validateCompileCandidate } from '../knowledge/validation/validateCompileCandidate'
import { serializeNodeBody, type PublishedNodeBody } from '../knowledge/nodeBody'
import type { ProjectKnowledge } from '../knowledge/ProjectKnowledgeRepository'
import type { ProjectKnowledgeReader } from '../knowledge/ProjectKnowledgeReader'

export type SkeletonBuildFailureCode =
  | 'no_model'
  | 'context_too_small'
  | 'invalid_output'
  | 'source_changed'
  | 'provider_error'
  | 'storage_unavailable'

export type SkeletonBuildResult =
  | { ok: true; knowledgeRevision: string; modelCallCount: number }
  | { ok: false; code: SkeletonBuildFailureCode; reason: string; modelCallCount: number }

/** 预算不变量被打破（估算误差等）；按「上下文太小」处理，不带着超长请求硬发。 */
class BudgetExceededError extends Error {}

/** 模型端失败（HTTP 5xx、鉴权、限流）；与「输出不合规」是两类失败，必须分开上报。 */
class ProviderRequestError extends Error {}

function evidencePrompt(fragments: readonly EvidenceFragment[], layout: readonly ProjectLayoutEntry[]): string {
  return JSON.stringify({
    schemaVersion: 1,
    task: 'skeleton_knowledge_compile',
    evidenceFragments: fragments.map(f => ({
      sourceId: f.sourceId,
      path: f.relativePath,
      startLine: f.startLine,
      endLine: f.endLine,
      ...(f.symbolLabel ? { symbol: f.symbolLabel } : {}),
      snippet: f.snippetText
    })),
    projectLayout: layout,
    outputContract: {
      schemaVersion: 1,
      nodes: [
        {
          nodeId: 'string',
          title: 'string',
          summary: 'string',
          learningGoal: 'string',
          navDimension: 'project_purpose | startup_runtime | module_roles | key_user_flows | data_and_state | design_tradeoffs',
          parentNodeId: 'string | null',
          claims: [],
          prerequisiteNodeIds: [],
          relatedNodeIds: [],
          flowNextNodeIds: []
        }
      ]
    },
    rules: [
      '只有 evidenceFragments 可以作为 source_fact 的出处；projectLayout 只说明项目规模，不能当作事实出处',
      'source_fact 只能引用 evidenceFragments 中的 sourceId',
      '设计原因无文档时用 inference'
    ]
  })
}

/** 预算 = min(上限, 模型窗口 − 输出预留)；模型不报告窗口时按上限。 */
export function resolveSkeletonInputBudget(model: ModelClient): number {
  const contextWindow = model.measureRequest?.([{ role: 'user', content: '' }], [])?.contextWindow
  const available = typeof contextWindow === 'number' && contextWindow > 0
    ? contextWindow - LEARNING_COMPILE_OUTPUT_RESERVE_TOKENS
    : Number.POSITIVE_INFINITY
  return Math.min(LEARNING_SKELETON_INPUT_TOKEN_CAP, available)
}

export function measureSkeletonRequest(model: ModelClient, messages: ChatMessage[]): number {
  return model.measureRequest?.(messages, [])?.budgetUnits ?? estimateTextTokens(JSON.stringify(messages))
}

/**
 * 按优先级逐个装入片段，放不下就停；最后对完整请求复测，仍超出则从末尾丢弃。
 * 返回装入的片段数与对应 prompt。
 */
export function packEvidence(
  model: ModelClient,
  evidence: EvidencePackage,
  budget: number
): { package: EvidencePackage; prompt: string; estimatedTokens: number } {
  const measure = (count: number) => {
    const prompt = evidencePrompt(evidence.fragments.slice(0, count), evidence.projectLayout)
    return { prompt, tokens: measureSkeletonRequest(model, [{ role: 'user', content: prompt }]) }
  }
  let count = 0
  let current = measure(0)
  while (count < evidence.fragments.length) {
    const next = measure(count + 1)
    if (next.tokens > budget) break
    count++
    current = next
  }
  while (count > 0 && current.tokens > budget) {
    count--
    current = measure(count)
  }
  return { package: takeEvidencePrefix(evidence, count), prompt: current.prompt, estimatedTokens: current.tokens }
}

async function collectModelText(
  model: ModelClient,
  messages: ChatMessage[],
  budget: number,
  signal?: AbortSignal
): Promise<string> {
  signal?.throwIfAborted()
  if (measureSkeletonRequest(model, messages) > budget) throw new BudgetExceededError('请求超出输入预算')
  let text = ''
  let failure: string | null = null
  for await (const event of model.chat(messages, [], { abortSignal: signal })) {
    signal?.throwIfAborted()
    if (event.type === 'text_delta') text += event.delta
    // 客户端把传输失败作为事件下发而不抛异常；不接住就会退化成空输出被当成 schema 无效
    if (event.type === 'error') failure = event.error || '模型请求失败'
    if (Buffer.byteLength(text, 'utf8') > LEARNING_MAX_COMPILE_OUTPUT_BYTES) throw new Error('大纲输出超出上限')
  }
  if (failure !== null) throw new ProviderRequestError(failure)
  return text
}

export class SkeletonKnowledgeBuild {
  private readonly evidencePort = new WorkspaceEvidencePort()

  async run(params: {
    workspaceRoot: string
    modelClient: ModelClient | null
    knowledge: ProjectKnowledge
    reader: ProjectKnowledgeReader
    focusRelativePaths?: readonly string[]
    expectedCurrentRevision?: string | null
    signal?: AbortSignal
    onProgress?: (stage: LearningBuildStage) => void
  }): Promise<SkeletonBuildResult> {
    const model = params.modelClient
    if (!model) {
      return { ok: false, code: 'no_model', reason: '无可用模型', modelCallCount: 0 }
    }
    const budget = resolveSkeletonInputBudget(model)
    if (budget < LEARNING_SKELETON_MIN_INPUT_TOKENS) {
      return { ok: false, code: 'context_too_small', reason: `输入预算 ${budget} 低于下限`, modelCallCount: 0 }
    }

    params.onProgress?.('collecting')
    const candidates = await this.evidencePort.collectSkeletonEvidence({
      workspaceRoot: params.workspaceRoot,
      focusRelativePaths: params.focusRelativePaths,
      signal: params.signal
    })
    const packed = packEvidence(model, candidates, budget)
    if (packed.estimatedTokens > budget) {
      return { ok: false, code: 'context_too_small', reason: '固定部分已超出输入预算', modelCallCount: 0 }
    }
    const evidence = packed.package

    const current =
      params.expectedCurrentRevision !== undefined
        ? params.expectedCurrentRevision
        : await params.reader.getCurrentKnowledgeRevision(params.workspaceRoot)

    params.onProgress?.('analyzing')
    let modelCallCount = 0
    const messages: ChatMessage[] = [{ role: 'user', content: packed.prompt }]
    let output: CompileOutput | null = null
    let lastError = 'schema 无效'

    for (let attempt = 0; attempt <= LEARNING_SCHEMA_REPAIR_MAX_EXTRA_CALLS; attempt++) {
      let text: string
      try {
        modelCallCount++
        text = await collectModelText(model, messages, budget, params.signal)
      } catch (error) {
        if (params.signal?.aborted) throw error
        if (error instanceof BudgetExceededError) {
          return { ok: false, code: 'context_too_small', reason: error.message, modelCallCount: modelCallCount - 1 }
        }
        if (error instanceof ProviderRequestError) {
          return { ok: false, code: 'provider_error', reason: error.message, modelCallCount }
        }
        const reason = error instanceof Error ? error.message : String(error)
        return { ok: false, code: reason === '大纲输出超出上限' ? 'invalid_output' : 'provider_error', reason, modelCallCount }
      }
      try {
        output = parseCompileOutputText(text)
        break
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        if (attempt >= LEARNING_SCHEMA_REPAIR_MAX_EXTRA_CALLS) break
        const repair: ChatMessage[] = [
          ...messages,
          { role: 'assistant', content: text },
          { role: 'user', content: buildCompileRepairUserMessage(lastError) }
        ]
        // 修复请求带着上次输出，超预算就放弃修复，不硬发
        if (measureSkeletonRequest(model, repair) > budget) break
        messages.splice(0, messages.length, ...repair)
      }
    }

    if (!output) {
      return { ok: false, code: 'invalid_output', reason: lastError, modelCallCount }
    }

    params.onProgress?.('validating')
    const validation = await validateCompileCandidate({
      workspaceRoot: params.workspaceRoot,
      evidence,
      output
    })
    if (!validation.ok) {
      return {
        ok: false,
        code: validation.failure.code === 'stale_source' ? 'source_changed' : 'invalid_output',
        reason: validation.message,
        modelCallCount
      }
    }

    const knowledgeRevision = randomUUID()
    const nodePayloads = output.nodes.map(node => {
      const materialStatus: PublishedNodeBody['materialStatus'] =
        node.claims.some(c => c.kind === 'source_fact') ? 'verified' : 'partial'
      const body: PublishedNodeBody = {
        summary: node.summary,
        learningGoal: node.learningGoal,
        claims: node.claims,
        materialStatus,
        navDimension: node.navDimension,
        parentNodeId: node.parentNodeId
      }
      const nodeRevision = createHash('sha256')
        .update(JSON.stringify(body))
        .digest('hex')
        .slice(0, 32)
      return {
        nodeId: node.nodeId,
        nodeRevision,
        title: node.title,
        bodyJson: serializeNodeBody(body),
        sourceReceiptIds: validation.nodeSources.get(node.nodeId) ?? []
      }
    })

    const sourceReceipts = evidence.fragments
      .filter(f => nodePayloads.some(n => n.sourceReceiptIds.includes(f.sourceId)))
      .map(f => ({
        receiptId: f.sourceId,
        filePath: f.relativePath,
        startLine: f.startLine,
        endLine: f.endLine,
        contentHash: f.contentHash,
        snippetHash: f.snippetHash,
        symbolLabel: f.symbolLabel,
        strategyVersion: evidence.strategyVersion,
        collectedAt: f.collectedAt
      }))

    params.signal?.throwIfAborted()
    try {
      await params.knowledge.publishVersion({
        workspaceRoot: params.workspaceRoot,
        knowledgeRevision,
        parentRevision: current,
        inputFingerprint: evidence.fingerprint,
        expectedCurrentRevision: current,
        nodes: nodePayloads.map(n => ({
          nodeId: n.nodeId,
          nodeRevision: n.nodeRevision,
          title: n.title,
          bodyJson: n.bodyJson
        })),
        members: nodePayloads.map(n => ({ nodeId: n.nodeId, nodeRevision: n.nodeRevision })),
        edges: validation.edges,
        sourceReceipts,
        nodeSources: nodePayloads.flatMap(n =>
          n.sourceReceiptIds.map(receiptId => ({
            nodeId: n.nodeId,
            nodeRevision: n.nodeRevision,
            receiptId
          }))
        )
      })
    } catch (e) {
      return {
        ok: false,
        code: 'storage_unavailable',
        reason: e instanceof Error ? e.message : String(e),
        modelCallCount
      }
    }

    return { ok: true, knowledgeRevision, modelCallCount }
  }

  /** 只取证不装箱，供测试与离线测量使用。 */
  collectEvidenceOnly(params: {
    workspaceRoot: string
    focusRelativePaths?: readonly string[]
  }): Promise<EvidencePackage> {
    return this.evidencePort.collectSkeletonEvidence(params)
  }
}
