/**
 * Parsed followup arguments, normalized from executor input or persisted JSON.
 * Shared by runtime/tools/task_followup and main/SubagentProjectionService.
 */
export function parseFollowupArguments(
  raw: unknown
): { childSessionId: string; task: string; resumeRunId?: string } | null {
  let value = raw
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (typeof value !== 'object' || value === null) return null
  const { child_session_id, task, resume_run_id } = value as Record<string, unknown>
  if (typeof child_session_id !== 'string' || !child_session_id.trim()) return null
  if (typeof task !== 'string' || !task.trim()) return null
  const resumeRunId =
    typeof resume_run_id === 'string' && resume_run_id.trim() !== ''
      ? resume_run_id.trim()
      : undefined
  return { childSessionId: child_session_id.trim(), task: task.trim(), ...(resumeRunId ? { resumeRunId } : {}) }
}
