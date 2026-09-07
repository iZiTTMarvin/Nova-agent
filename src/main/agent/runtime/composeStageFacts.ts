/**
 * compose 阶段完成所需的运行时事实：从 SessionStore 与子代理投影读取，
 * 不另写会话扫描，也不把模型自述当作完成条件。
 */
import type { SessionStore } from '../../../runtime/sessions/SessionStore'
import { getSessionActiveMessages } from '../../../runtime/sessions/tree'
import { projectContentFromBlocks } from '../../../runtime/sessions/messageProjection'
import type { SessionData, SessionMessage } from '../../../runtime/sessions/types'
import type { ComposeStageFacts } from '../../../shared/composeLifecycle'
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
const INSPECTOR_PASS_MARK = '结论：通过'

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

function hasExitZeroShell(messages: SessionMessage[]): boolean {
  for (const message of messages) {
    for (const block of message.blocks ?? []) {
      if (!isToolBlock(block)) continue
      if (block.toolName !== 'bash' && block.toolName !== 'shell_session') continue
      if (persistedExitCode(block) === 0) return true
    }
  }
  return false
}

function lastAssistantText(messages: SessionMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'assistant') continue
    return projectContentFromBlocks(message.blocks, message.content)
  }
  return ''
}

function inspectorTranscriptPassed(child: SessionData | null): boolean {
  if (!child) return false
  const messages = getSessionActiveMessages(child)
  if (!hasExitZeroShell(messages)) return false
  return lastAssistantText(messages).includes(INSPECTOR_PASS_MARK)
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

    const inspectorPassed = runs.some(run => {
      if (!isCompletedProfileRun(run, BUILTIN_SUBAGENT_IDS.inspector, enteredAt)) {
        return false
      }
      return inspectorTranscriptPassed(deps.sessionStore.load(run.childSessionId))
    })

    return { criticCompleted, inspectorPassed }
  }
}
