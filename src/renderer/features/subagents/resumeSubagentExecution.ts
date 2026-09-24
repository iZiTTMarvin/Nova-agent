/**
 * 继续按钮的窄助手：构造 resume 消息与稳定 userMessageId。
 * UI 走普通父消息入口，不另造执行通道。
 */

const RESUME_PREFIX = 'msg_resume_'

/** 指导父模型调用 task_followup 的明确文本。 */
export function buildSubagentResumeMessage(opts: {
  childSessionId: string
  childRunId: string
}): string {
  return (
    `请继续子任务。` +
    `\n\nchild_session_id: ${opts.childSessionId}` +
    `\nresume_run_id: ${opts.childRunId}` +
    `\n\n注意：不要重新派遣新子代理，只需使用 task_followup 工具继续该会话的既有执行。`
  )
}

/** 稳定幂等键：'msg_resume_' + childRunId。 */
export function deriveSubagentResumeUserMessageId(childRunId: string): string {
  return RESUME_PREFIX + childRunId
}

/** 触发 resume：通过父消息入口发送恢复请求。 */
export async function requestSubagentResume(opts: {
  parentSessionId: string
  childSessionId: string
  childRunId: string
}): Promise<{ ok: boolean; rejection?: string }> {
  const content = buildSubagentResumeMessage({
    childSessionId: opts.childSessionId,
    childRunId: opts.childRunId
  })
  const userMessageId = deriveSubagentResumeUserMessageId(opts.childRunId)
  try {
    const result = await window.api.invoke('send-message', {
      sessionId: opts.parentSessionId,
      content,
      userMessageId
    })
    if (result.accepted === false) {
      const r = result.rejection
      return { ok: false, rejection: `父会话拒绝接收（${r.reason}: ${r.skillName}）` }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, rejection: err instanceof Error ? err.message : String(err) }
  }
}
