import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { EventBus } from '../../../runtime/agent'
import type { AgentTurnRunRefs } from '../../../runtime/agent/turn'
import type { RunCoordinator } from '../../../runtime/run'

export interface PendingAskQuestionEntry {
  sessionId: string
  runId: string
  executionGeneration: number
  resolve: (answers: AskQuestionAnswer[]) => void
  eventBus: EventBus
}

export function createAskQuestionHandler(input: {
  sessionId: string
  getRunRefs: () => Pick<AgentTurnRunRefs, 'runId' | 'executionGeneration'>
  runCoordinator: RunCoordinator
  pending: Map<string, PendingAskQuestionEntry>
  eventBus: EventBus
}): (requestId: string, questions: AskQuestionItem[]) => Promise<AskQuestionAnswer[]> {
  return (requestId, questions) => new Promise((resolve, reject) => {
    const { sessionId, runCoordinator, pending, eventBus } = input
    const { runId, executionGeneration } = input.getRunRefs()
    const snapshot = runCoordinator.getSnapshot(runId)
    if (
      !snapshot || snapshot.runId !== runId || snapshot.sessionId !== sessionId ||
      !snapshot.messageId?.trim() || snapshot.status === 'cancelling' ||
      !runCoordinator.isExecutionCurrent(runId, executionGeneration)
    ) {
      reject(new Error('askQuestion 的 run/session/message 或 execution generation 身份无效'))
      return
    }
    if (!requestId.trim() || pending.has(requestId)) {
      reject(new Error(`askQuestion 请求身份无效或重复: ${requestId}`))
      return
    }
    const messageId = snapshot.messageId
    pending.set(requestId, { sessionId, runId, executionGeneration, resolve, eventBus })
    try {
      const interaction = runCoordinator.inbox.enqueue({
        runId,
        sessionId,
        messageId,
        type: 'askQuestion',
        interactionId: requestId,
        payload: { requestId, questions }
      })
      eventBus.emit({
        type: 'ask_question_request', requestId, questions, sessionId, messageId, runId,
        interactionId: interaction.interactionId,
        version: interaction.version
      })
    } catch (error) {
      pending.delete(requestId)
      reject(error)
    }
  })
}

/** 等待用户回复的 askQuestion 请求（requestId → 挂起状态）。无超时 */
export const pendingAskQuestions = new Map<string, PendingAskQuestionEntry>()

/**
 * 结算指定会话挂起的 askQuestion：空 answers 走 dismissed 路径，并通知 UI 关闭面板。
 *
 * 并发模型下只按会话归属过滤——用户在某会话发新消息时，只应 dismiss 该会话的挂起提问，
 * 不能误清并发中其它会话正在等待的提问（否则会让别的会话的 agent 拿空回答跑偏）。
 */
export function dismissPendingAskQuestionsForSession(sessionId: string): void {
  for (const [requestId, entry] of pendingAskQuestions) {
    if (entry.sessionId !== sessionId) continue
    pendingAskQuestions.delete(requestId)
    entry.resolve([])
    entry.eventBus.emit({ type: 'ask_question_resolved', requestId })
  }
}

/** 按 runId 结算挂起的 askQuestion（取消执行时使用） */
export function dismissPendingAskQuestionsForRun(runId: string, executionGeneration?: number): void {
  for (const [requestId, entry] of pendingAskQuestions) {
    if (entry.runId !== runId || (executionGeneration !== undefined && entry.executionGeneration !== executionGeneration)) continue
    pendingAskQuestions.delete(requestId)
    entry.resolve([])
    entry.eventBus.emit({ type: 'ask_question_resolved', requestId })
  }
}
