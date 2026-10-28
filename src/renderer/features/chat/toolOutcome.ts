/**
 * 工具块终态的展示语义。
 *
 * 渲染层的工具块只有 running / success / error，取消中的工具也会被记成 error 并带取消文本。
 * 这里把 error 拆成“可确认的失败”和“无法与取消区分的未完成”，不新增运行状态，只做展示投影。
 */
import { USER_CANCELLED_TOOL_RESULT } from '../../../shared/session/toolCancellation'

export type ToolOutcome = 'running' | 'success' | 'failed' | 'incomplete'

interface OutcomeSource {
  status: 'running' | 'success' | 'error'
  result?: string
}

/**
 * 运行时各工具的取消文本没有结构化标记（如“读取已取消”“搜索已取消：请求已取消”），
 * 只能按文本识别；识别不到的 error 才按失败展示。
 */
function looksCancelled(result: string | undefined): boolean {
  if (!result) return false
  return result.startsWith(USER_CANCELLED_TOOL_RESULT) || result.includes('已取消')
}

export function resolveToolOutcome(source: OutcomeSource): ToolOutcome {
  if (source.status === 'running') return 'running'
  if (source.status === 'success') return 'success'
  return looksCancelled(source.result) ? 'incomplete' : 'failed'
}

const OUTCOME_VERB: Record<string, string> = {
  read: '读取',
  web_fetch: '读取',
  grep: '搜索',
  find: '搜索',
  web_search: '搜索',
  ls: '列出',
  bash: '执行',
  write: '写入',
  edit: '编辑'
}

export const AWAITING_PERMISSION_LABEL = '等待授权'

/** 行尾状态文案；成功态返回 null 表示该工具默认不显示。 */
export function getToolOutcomeLabel(toolName: string, outcome: ToolOutcome): string | null {
  const verb = OUTCOME_VERB[toolName] ?? '执行'
  switch (outcome) {
    case 'running':
      return `正在${verb}`
    case 'success':
      return toolName === 'web_search' || toolName === 'web_fetch' ? `已${verb}` : null
    case 'failed':
      return `${verb}失败`
    case 'incomplete':
      return '未完成'
  }
}

export interface ToolOutcomeCounts {
  running: number
  failed: number
  incomplete: number
}

export function countToolOutcomes(blocks: ReadonlyArray<OutcomeSource>): ToolOutcomeCounts {
  const counts: ToolOutcomeCounts = { running: 0, failed: 0, incomplete: 0 }
  for (const block of blocks) {
    const outcome = resolveToolOutcome(block)
    if (outcome === 'running') counts.running += 1
    else if (outcome === 'failed') counts.failed += 1
    else if (outcome === 'incomplete') counts.incomplete += 1
  }
  return counts
}

/** 组头状态文案，只包含真实存在的状态。 */
export function formatToolOutcomeCounts(counts: ToolOutcomeCounts): string[] {
  const parts: string[] = []
  if (counts.running > 0) parts.push(`${counts.running} 项进行中`)
  if (counts.failed > 0) parts.push(`${counts.failed} 项失败`)
  if (counts.incomplete > 0) parts.push(`${counts.incomplete} 项未完成`)
  return parts
}
