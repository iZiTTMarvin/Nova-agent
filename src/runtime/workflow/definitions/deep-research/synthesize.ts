/**
 * synthesize 阶段：把并行检索得到的多条 finding 综合成一个可交付结论。
 *
 * 只读隔离：综合是推理动作，不该有任何写入或命令执行能力。
 * 输入刻意只给结构化 finding 而不是原始检索正文——原文留在各 research 子 agent
 * 的上下文里随其结束一起丢弃，主编排只承担摘要的 token 成本。
 */
import type { AgentResult, HostFns } from '../../host'
import { asRecord, asString, asStringList } from '../agentOutput'
import type { ResearchBrief, ResearchFindings, ResearchSynthesis } from './types'

export const SYNTHESIS_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    conclusion: { type: 'string' },
    keyPoints: { type: 'array', items: { type: 'string' } },
    conflicts: { type: 'array', items: { type: 'string' } },
    unresolved: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
    citations: { type: 'array', items: { type: 'string' } }
  },
  required: ['conclusion', 'keyPoints', 'citations']
}

/**
 * 归一化综合结论。
 *
 * unresolved 缺省时由 findings 的证据缺口补齐：模型倾向于给出干净结论而漏报缺口，
 * 而"哪些没查清"是调研交付物里最不能丢的部分。
 */
export function normalizeSynthesis(
  value: AgentResult,
  findings: ResearchFindings
): ResearchSynthesis | null {
  const record = asRecord(value)
  if (!record) return null
  const conclusion = asString(record.conclusion) ?? asString(record.summary)
  if (!conclusion) return null

  const modelUnresolved = asStringList(record.unresolved ?? record.openQuestions)
  const derivedUnresolved = findings.findings
    .filter((finding) => finding.status !== 'answered')
    .map((finding) =>
      finding.status === 'failed'
        ? `${finding.question}（检索失败：${finding.failure ?? '未知原因'}）`
        : `${finding.question}（${finding.gaps.join('；') || '证据不足'}）`
    )

  const citations = asStringList(record.citations ?? record.sources)
  const derivedCitations = findings.findings.flatMap((finding) =>
    finding.evidence.map((evidence) => evidence.source)
  )

  return {
    conclusion,
    keyPoints: asStringList(record.keyPoints ?? record.findings),
    conflicts: asStringList(record.conflicts ?? record.contradictions),
    unresolved: modelUnresolved.length > 0 ? modelUnresolved : derivedUnresolved,
    recommendations: asStringList(record.recommendations ?? record.nextSteps),
    citations: citations.length > 0 ? citations : [...new Set(derivedCitations)]
  }
}

function buildPrompt(brief: ResearchBrief, findings: ResearchFindings): string {
  return [
    '你负责 deep-research workflow 的 synthesize 阶段。',
    '把各子问题的检索结果综合成一个直接回答主研究问题的结论。',
    '只能使用下面 findings 里出现过的证据；不得引入新的来源，不得补充未经检索的判断。',
    '来源之间相互矛盾时必须写入 conflicts，不要择一采信；证据不足的部分写入 unresolved。',
    '必须返回 JSON：conclusion、keyPoints、conflicts、unresolved、recommendations、citations。',
    '',
    `主研究问题：${brief.question}`,
    `完成判据：${brief.successCriteria.join('；')}`,
    `检索结果：\n${JSON.stringify(findings.findings)}`
  ].join('\n')
}

export async function runSynthesize(
  host: HostFns,
  brief: ResearchBrief,
  findings: ResearchFindings
): Promise<ResearchSynthesis | null> {
  host.progress('synthesize', 'started')
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(brief, findings), {
      phase: 'synthesize',
      isolation: 'readonly',
      interactive: false,
      schema: SYNTHESIS_SCHEMA,
      label: 'deep-research-synthesize'
    })
  } catch {
    output = null
  }

  const synthesis = normalizeSynthesis(output, findings)
  if (!synthesis) {
    host.progress('synthesize', 'failed', { message: 'synthesize 未产出结论' })
    return null
  }
  host.progress('synthesize', 'completed', {
    message: `结论已形成，引用 ${synthesis.citations.length} 个来源，遗留 ${synthesis.unresolved.length} 项未解决`
  })
  return synthesis
}
