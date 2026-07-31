/**
 * brief 阶段：把用户的一句话诉求提炼成可并行执行的研究问题。
 *
 * 这是 deep-research 唯一可能与用户交互的阶段——研究范围一旦跑偏，
 * 后面的并行搜索全部浪费，所以 Auto 关闭时给它 askQuestion 澄清范围。
 * 为此隔离模式取 shared（readonly 隔离拿不到提问工具），但工具清单显式收窄到只读集合：
 * 提炼问题不需要写入或执行命令的能力。
 */
import { READONLY_TOOLS, type AgentResult, type HostFns } from '../../host'
import { asRecord, asString, asStringList } from '../agentOutput'
import type { ResearchBrief, ResearchSubQuestion } from './types'

/** 子问题数量上限：并行度由 host 的信号量兜底，这里限制的是研究范围本身不要发散 */
const MAX_SUB_QUESTIONS = 6

export const BRIEF_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    question: { type: 'string' },
    subQuestions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          question: { type: 'string' },
          rationale: { type: 'string' }
        },
        required: ['question']
      }
    },
    successCriteria: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } }
  },
  required: ['question', 'subQuestions', 'successCriteria']
}

function normalizeSubQuestion(value: unknown, index: number): ResearchSubQuestion | null {
  const record = asRecord(value)
  if (!record) {
    // 模型有时直接给字符串数组而不是对象数组，这种形状仍然可用
    const plain = asString(value)
    return plain ? { id: `sub-${index + 1}`, question: plain } : null
  }
  const question = asString(record.question) ?? asString(record.title)
  if (!question) return null
  const rationale = asString(record.rationale) ?? asString(record.reason)
  return {
    id: asString(record.id) ?? `sub-${index + 1}`,
    question,
    ...(rationale ? { rationale } : {})
  }
}

/** 子问题 id 参与 research 阶段的结果配对，必须在本阶段就保证唯一 */
function dedupeIds(subQuestions: ResearchSubQuestion[]): ResearchSubQuestion[] {
  const seen = new Set<string>()
  return subQuestions.map((subQuestion, index) => {
    if (!seen.has(subQuestion.id)) {
      seen.add(subQuestion.id)
      return subQuestion
    }
    let candidate = `${subQuestion.id}-${index + 1}`
    while (seen.has(candidate)) candidate = `${candidate}-x`
    seen.add(candidate)
    return { ...subQuestion, id: candidate }
  })
}

export function normalizeBrief(value: AgentResult, request: string): ResearchBrief | null {
  const record = asRecord(value)
  if (!record) return null
  const rawSubQuestions = record.subQuestions ?? record.questions ?? record.subquestions
  if (!Array.isArray(rawSubQuestions)) return null
  const subQuestions = dedupeIds(
    rawSubQuestions
      .map((item, index) => normalizeSubQuestion(item, index))
      .filter((item): item is ResearchSubQuestion => item !== null)
      .slice(0, MAX_SUB_QUESTIONS)
  )
  if (subQuestions.length === 0) return null

  const successCriteria = asStringList(record.successCriteria ?? record.criteria)
  return {
    question: asString(record.question) ?? request.trim(),
    subQuestions,
    successCriteria:
      successCriteria.length > 0 ? successCriteria : ['每个子问题都有带来源的答案或明确的证据缺口'],
    outOfScope: asStringList(record.outOfScope ?? record.nonGoals)
  }
}

function buildPrompt(request: string): string {
  return [
    '你负责 deep-research workflow 的 brief 阶段。',
    '把用户诉求提炼成一个明确的主研究问题，并拆成互不重叠、可各自独立检索的子问题。',
    `子问题不超过 ${MAX_SUB_QUESTIONS} 个；每个子问题必须能被独立检索回答，不要拆成需要串行依赖的步骤。`,
    '如果研究对象涉及当前工作区，先读相关代码或文档确认事实，再拟定问题。',
    '不要修改任何文件。范围确实存在歧义且你有提问工具时，先向用户澄清一次。',
    '必须返回 JSON：question、subQuestions（含 id、question、rationale）、successCriteria、outOfScope。',
    '',
    `用户请求：\n${request}`
  ].join('\n')
}

export async function runBrief(
  host: HostFns,
  request: string,
  autoMode: boolean
): Promise<ResearchBrief | null> {
  host.progress('brief', 'started')
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(request), {
      phase: 'brief',
      isolation: 'shared',
      tools: [...READONLY_TOOLS],
      interactive: !autoMode,
      schema: BRIEF_SCHEMA,
      label: 'deep-research-brief'
    })
  } catch {
    output = null
  }

  const brief = normalizeBrief(output, request)
  if (!brief) {
    host.progress('brief', 'failed', { message: 'brief 未产出可执行的研究问题拆解' })
    return null
  }
  host.progress('brief', 'completed', {
    message: `已拆出 ${brief.subQuestions.length} 个子问题`
  })
  return brief
}
