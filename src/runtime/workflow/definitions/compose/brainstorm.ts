import type { AgentResult, HostFns } from '../../host'
import type { BrainstormAlternative, BrainstormResult } from './types'

export const BRAINSTORM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    assumptions: { type: 'array', items: { type: 'string' } },
    alternatives: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          approach: { type: 'string' },
          tradeoffs: { type: 'array', items: { type: 'string' } },
          risks: { type: 'array', items: { type: 'string' } }
        },
        required: ['title', 'approach']
      }
    },
    recommendation: { type: 'string' },
    openQuestions: { type: 'array', items: { type: 'string' } }
  },
  required: ['summary', 'alternatives', 'recommendation']
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map((item) => item.trim())
}

function normalizeAlternative(value: unknown, index: number): BrainstormAlternative | null {
  const record = asRecord(value)
  if (!record) return null
  const title = asString(record.title) ?? asString(record.name)
  const approach = asString(record.approach) ?? asString(record.summary)
  if (!title || !approach) return null
  return {
    id: asString(record.id) ?? `alternative-${index + 1}`,
    title,
    approach,
    tradeoffs: asStringList(record.tradeoffs ?? record.tradeOffs),
    risks: asStringList(record.risks)
  }
}

export function normalizeBrainstorm(value: unknown): BrainstormResult | null {
  const record = asRecord(value)
  if (!record) return null
  const rawAlternatives = record.alternatives ?? record.approaches
  if (!Array.isArray(rawAlternatives)) return null
  const alternatives = rawAlternatives
    .map((item, index) => normalizeAlternative(item, index))
    .filter((item): item is BrainstormAlternative => item !== null)
  if (alternatives.length === 0) return null

  const recommendation =
    asString(record.recommendation) ??
    asString(record.recommendedApproach) ??
    alternatives[0]!.title
  return {
    summary: asString(record.summary) ?? `已形成 ${alternatives.length} 个方案备选。`,
    assumptions: asStringList(record.assumptions),
    alternatives,
    recommendation,
    openQuestions: asStringList(record.openQuestions ?? record.questions)
  }
}

function buildPrompt(request: string): string {
  return [
    '你负责 compose workflow 的 brainstorm 阶段。',
    '请先检查与需求相关的真实代码、测试、配置和项目规则，再提出可比较的实现方案。',
    '必须返回一个 JSON 对象：summary、assumptions、alternatives、recommendation、openQuestions。',
    'alternatives 至少包含两个可行方案（若需求确实只有一种，请明确说明原因），每个方案包含 title、approach、tradeoffs、risks。',
    '不要修改文件，不要执行不可逆操作；未知事实要写入 assumptions 或 openQuestions。',
    '',
    `用户请求：\n${request}`
  ].join('\n')
}

export async function runBrainstorm(
  host: HostFns,
  request: string,
  autoMode: boolean
): Promise<BrainstormResult | null> {
  host.progress('brainstorm', 'started')
  let output: AgentResult = null
  try {
    output = await host.agent(buildPrompt(request), {
      taskId: 'brainstorm',
      phase: 'brainstorm',
      isolation: 'shared',
      interactive: !autoMode,
      schema: BRAINSTORM_SCHEMA,
      label: 'compose-brainstorm'
    })
  } catch {
    output = null
  }

  const result = normalizeBrainstorm(output)
  if (!result) {
    host.progress('brainstorm', 'failed', {
      message: '未产出有效方案备选（模型输出解析失败或子代理异常，原因见活动日志）'
    })
    return null
  }
  host.progress('brainstorm', 'completed', {
    message: `已形成 ${result.alternatives.length} 个方案备选`
  })
  return result
}
