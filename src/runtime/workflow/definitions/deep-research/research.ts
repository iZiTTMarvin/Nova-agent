/**
 * research 阶段：对 brief 拆出的子问题做并行只读检索。
 *
 * 与 compose 的 implement 相比这里刻意更简单：只读负载没有写冲突，
 * 因此不需要 worktree 隔离、不需要 integrate、也不需要拓扑分批——
 * 全部子问题一次性并发发起，真实并发度由 host 的两层信号量（全局 + per-run）决定，
 * definition 不自己管并发窗口。
 *
 * 失败隔离：单个子问题失败只落成一条 status='failed' 的 finding，
 * 不影响其余子问题，也不让整个阶段失败——只要还有一条 finding 可用就继续 synthesize。
 */
import type { AgentOptions, AgentResult, HostFns } from '../../host'
import { asEnum, asRecord, asString, asStringList } from '../agentOutput'
import type {
  ResearchBrief,
  ResearchEvidence,
  ResearchFinding,
  ResearchFindings,
  ResearchSubQuestion
} from './types'

/** 单条证据摘录的长度上限，避免把整页原文灌回主编排上下文 */
const MAX_EXCERPT_CHARS = 600

export const FINDING_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['answered', 'inconclusive'] },
    answer: { type: 'string' },
    evidence: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          excerpt: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: ['source']
      }
    },
    gaps: { type: 'array', items: { type: 'string' } }
  },
  required: ['status', 'evidence']
}

function normalizeEvidence(value: unknown): ResearchEvidence | null {
  const record = asRecord(value)
  if (!record) {
    const plain = asString(value)
    return plain ? { source: plain, confidence: 'low' } : null
  }
  const source = asString(record.source) ?? asString(record.url) ?? asString(record.path)
  if (!source) return null
  const excerpt = asString(record.excerpt) ?? asString(record.quote)
  return {
    source,
    ...(excerpt ? { excerpt: excerpt.slice(0, MAX_EXCERPT_CHARS) } : {}),
    confidence: asEnum(record.confidence, ['high', 'medium', 'low'] as const) ?? 'medium'
  }
}

/**
 * 把子 agent 输出收敛成 finding。
 *
 * 没有证据的"答案"一律降级为 inconclusive：deep-research 的价值在于结论可追溯，
 * 允许无来源结论通过会让后面的 review 阶段失去判据。
 */
export function normalizeFinding(
  subQuestion: ResearchSubQuestion,
  value: AgentResult
): ResearchFinding {
  const record = asRecord(value)
  if (!record) {
    return {
      subQuestionId: subQuestion.id,
      question: subQuestion.question,
      status: 'failed',
      evidence: [],
      gaps: [],
      failure: '子 agent 未产出结构化检索结果'
    }
  }

  const evidence = (Array.isArray(record.evidence) ? record.evidence : [])
    .map(normalizeEvidence)
    .filter((item): item is ResearchEvidence => item !== null)
  const answer = asString(record.answer) ?? asString(record.summary)
  const gaps = asStringList(record.gaps ?? record.openQuestions)
  const claimed = asEnum(record.status, ['answered', 'inconclusive'] as const)
  const status = claimed === 'answered' && answer && evidence.length > 0 ? 'answered' : 'inconclusive'

  return {
    subQuestionId: subQuestion.id,
    question: subQuestion.question,
    status,
    ...(answer ? { answer } : {}),
    evidence,
    gaps:
      status === 'inconclusive' && gaps.length === 0
        ? [evidence.length === 0 ? '未找到可引用来源' : '证据不足以形成结论']
        : gaps
  }
}

function buildPrompt(brief: ResearchBrief, subQuestion: ResearchSubQuestion): string {
  return [
    '你负责 deep-research workflow 的 research 阶段，只处理分配给你的一个子问题。',
    '优先使用 web_search 获取外部资料；若问题指向当前工作区，用只读工具查证真实代码。',
    '每条结论都必须给出可追溯来源（URL 或工作区文件路径）。找不到来源就如实返回 inconclusive。',
    '不要回答分配给你之外的问题，不要猜测，不要编造来源。',
    '必须返回 JSON：status（answered 或 inconclusive）、answer、evidence（含 source、excerpt、confidence）、gaps。',
    '',
    `主研究问题：${brief.question}`,
    `你的子问题（${subQuestion.id}）：${subQuestion.question}`,
    ...(subQuestion.rationale ? [`该子问题的意义：${subQuestion.rationale}`] : []),
    ...(brief.outOfScope.length > 0 ? [`范围外，不要展开：${brief.outOfScope.join('；')}`] : [])
  ].join('\n')
}

async function researchOne(
  host: HostFns,
  brief: ResearchBrief,
  subQuestion: ResearchSubQuestion
): Promise<ResearchFinding> {
  host.progress('research', 'task_started', {
    taskId: subQuestion.id,
    taskName: subQuestion.question
  })

  const options: AgentOptions = {
    phase: 'research',
    isolation: 'readonly',
    interactive: false,
    schema: FINDING_SCHEMA,
    label: `deep-research-${subQuestion.id}`
  }

  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(brief, subQuestion), options)
  } catch {
    // host.agent 契约上不抛，这里兜住的是装配错误，不能让一个子问题拖垮整阶段
    output = null
  }

  const finding = normalizeFinding(subQuestion, output)
  host.progress('research', finding.status === 'failed' ? 'task_failed' : 'task_complete', {
    taskId: subQuestion.id,
    taskName: subQuestion.question,
    ...(finding.status === 'failed' && finding.failure ? { message: finding.failure } : {})
  })
  return finding
}

/**
 * 并发执行全部子问题检索。
 * 返回 null 只发生在没有任何 finding 可用时（全部失败），此时继续 synthesize 没有意义。
 */
export async function runResearch(
  host: HostFns,
  brief: ResearchBrief
): Promise<ResearchFindings | null> {
  host.progress('research', 'started', {
    message: `并行检索 ${brief.subQuestions.length} 个子问题`
  })
  host.progress('research', 'batch_started', {
    batchIndex: 1,
    batchSize: brief.subQuestions.length
  })

  const findings = await Promise.all(
    brief.subQuestions.map((subQuestion) => researchOne(host, brief, subQuestion))
  )

  const result: ResearchFindings = {
    findings,
    answeredIds: findings.filter((f) => f.status === 'answered').map((f) => f.subQuestionId),
    inconclusiveIds: findings.filter((f) => f.status === 'inconclusive').map((f) => f.subQuestionId),
    failedIds: findings.filter((f) => f.status === 'failed').map((f) => f.subQuestionId)
  }

  const usable = result.answeredIds.length + result.inconclusiveIds.length
  if (usable === 0) {
    host.progress('research', 'failed', { message: '全部子问题检索失败' })
    return null
  }

  host.progress('research', 'completed', {
    message: `已回答 ${result.answeredIds.length}，证据不足 ${result.inconclusiveIds.length}，失败 ${result.failedIds.length}`
  })
  return result
}
