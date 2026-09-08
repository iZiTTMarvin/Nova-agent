/**
 * compose 阶段完成所需的运行时事实：从 SessionStore 与子代理投影读取，
 * 不另写会话扫描，也不把模型自述当作完成条件。
 */
import type { SessionStore } from '../../../runtime/sessions/SessionStore'
import { getSessionActiveMessages } from '../../../runtime/sessions/tree'
import type { SessionData } from '../../../runtime/sessions/types'
import { parseInspectionReport, type ComposeStageFacts } from '../../../shared/composeLifecycle'
import { BUILTIN_SUBAGENT_IDS } from '../../../shared/subagents/presetIdentity'
import type { SubagentActivityProjection } from '../../../shared/subagents'
import type { MessageBlock } from '../../../shared/session'

export interface ComposeStageFactsProviderDeps {
  sessionStore: Pick<SessionStore, 'getComposeStages' | 'load'>
  projection: {
    listByParentSessionId(parentSessionId: string): SubagentActivityProjection[]
  }
}

const BASH_EXIT_RE = /\[命令退出码:\s*(\d+)/
const SHELL_SESSION_EXIT_RE = /\[会话已终止，退出码:\s*(\d+)/

function runTime(run: SubagentActivityProjection): number {
  return run.startedAt ?? run.completedAt ?? 0
}

function isCompletedProfileRun(
  run: SubagentActivityProjection,
  profileId: string,
  enteredAt: number
): boolean {
  return (
    run.profile.profileId === profileId &&
    run.status === 'completed' &&
    runTime(run) >= enteredAt
  )
}

function persistedExitCode(block: Extract<MessageBlock, { type: 'tool' }>): number | null {
  if (block.status !== 'success') return null
  const result = block.result ?? ''
  if (block.toolName === 'bash') {
    const match = result.match(BASH_EXIT_RE)
    if (match) return Number(match[1])
    // bash 只给非 0 退出码写标记；success 且无标记即 exit 0
    return block.status === 'success' ? 0 : null
  }
  if (block.toolName === 'shell_session') {
    const match = result.match(SHELL_SESSION_EXIT_RE)
    return match ? Number(match[1]) : null
  }
  return null
}

function isToolBlock(block: MessageBlock): block is Extract<MessageBlock, { type: 'tool' }> {
  return block.type === 'tool'
}

function inspectorReportIssue(
  child: SessionData | null,
  run: SubagentActivityProjection,
  parentSessionId: string,
  enteredAt: number
): NonNullable<ComposeStageFacts['inspection']>['issue'] | null {
  if (child?.kind !== 'subagent' ||
      child.subagent.lineage.parentSessionId !== parentSessionId ||
      child.subagent.profile.profileId !== BUILTIN_SUBAGENT_IDS.inspector) return 'missing_report'
  let hasEvidence = false
  let issue: NonNullable<ComposeStageFacts['inspection']>['issue'] | null = 'missing_report'
  for (const message of getSessionActiveMessages(child)) {
    if (message.role !== 'assistant' || (message.turnStartedAt ?? message.timestamp) < enteredAt) continue
    for (const block of message.blocks ?? []) {
      if (!isToolBlock(block)) continue
      if (persistedExitCode(block) === 0) hasEvidence = true
      if (block.toolName !== 'inspection_report') continue
      issue = 'missing_report'
      if (block.status !== 'success') continue
      let value: unknown
      try { value = JSON.parse(block.result ?? '') } catch { continue }
      const report = parseInspectionReport(value)
      if (!report || report.parentSessionId !== parentSessionId ||
          report.stageEnteredAt !== enteredAt || report.childRunId !== run.childRunId ||
          report.messageId !== message.id) continue
      // 同一运行补交时以最后一次正式结论为准，不能让先前的 pass 掩盖后来的 fail。
      issue = report.verdict === 'fail' ? 'failed' : hasEvidence ? null : 'missing_evidence'
    }
  }
  return issue
}

export function createComposeStageFactsProvider(
  deps: ComposeStageFactsProviderDeps
): (sessionId: string) => ComposeStageFacts {
  return (sessionId: string): ComposeStageFacts => {
    const stages = deps.sessionStore.getComposeStages(sessionId)
    const current = stages?.find(entry => entry.status === 'in_progress')
    const enteredAt = current?.enteredAt ?? 0
    const runs = deps.projection.listByParentSessionId(sessionId)

    const criticCompleted = runs.some(run =>
      isCompletedProfileRun(run, BUILTIN_SUBAGENT_IDS.critic, enteredAt)
    )

    const inspector = runs
      .filter(run => run.profile.profileId === BUILTIN_SUBAGENT_IDS.inspector && runTime(run) >= enteredAt)
      .sort((a, b) => runTime(b) - runTime(a) || (b.completedAt ?? 0) - (a.completedAt ?? 0))[0]
    if (!inspector) return { criticCompleted, inspectorPassed: false }
    const issue = inspector.status !== 'completed'
      ? 'not_completed'
      : inspectorReportIssue(deps.sessionStore.load(inspector.childSessionId), inspector, sessionId, enteredAt)
    return {
      criticCompleted,
      inspectorPassed: issue === null,
      ...(issue ? { inspection: { issue, childSessionId: inspector.childSessionId } } : {})
    }
  }
}
