import type { PendingAskQuestionEntry } from '../runtime'

/** 等待用户回复的 askQuestion 请求（requestId → 挂起状态）。与 verification permission 不同，无超时 */
export const pendingAskQuestions = new Map<string, PendingAskQuestionEntry>()

/** 结算全部挂起的 askQuestion：空 answers 走 dismissed 路径，并通知 UI 关闭面板 */
export function dismissAllPendingAskQuestions(): void {
  for (const [requestId, entry] of pendingAskQuestions) {
    pendingAskQuestions.delete(requestId)
    entry.resolve([])
    entry.eventBus.emit({ type: 'ask_question_resolved', requestId })
  }
}

/** 按 runId 结算挂起的 askQuestion（取消执行时使用） */
export function dismissPendingAskQuestionsForRun(runId: string): void {
  for (const [requestId, entry] of pendingAskQuestions) {
    if (entry.runId !== runId) continue
    pendingAskQuestions.delete(requestId)
    entry.resolve([])
    entry.eventBus.emit({ type: 'ask_question_resolved', requestId })
  }
}
