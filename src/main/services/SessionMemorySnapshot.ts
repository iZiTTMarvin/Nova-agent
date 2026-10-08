import type { MemorySnapshotRecord, SessionData } from '../../runtime/sessions/types'
import type { SessionStore } from '../../runtime/sessions/SessionStore'
import type { RenderedMemorySnapshot } from '../../runtime/memory/snapshot/renderMemorySnapshot'
import type { MemoryForgetCopy } from '../../runtime/memory/forget/MemoryForgetter'
import type { ForgottenMemory } from '../../runtime/memory/types'
import { redactMemorySnapshotText } from '../../runtime/memory/snapshot/redactMemorySnapshot'
import { escapeMemorySnapshotText } from '../../runtime/memory/snapshot/selectCoreEntries'
import { isMemoryExcludedSessionState } from '../../runtime/memory/MemorySessionExclusion'
import { SystemPromptBuilder } from '../../runtime/agent/promptBuilder/SystemPromptBuilder'

export function prepareSessionMemorySnapshot(session: SessionData, memoryEnabled: boolean,
  capturedAt: number, capture: (workspaceRoot: string, capturedAt: number) => RenderedMemorySnapshot): MemorySnapshotRecord {
  if (session.memorySnapshot) return session.memorySnapshot
  const empty = (reason: MemorySnapshotRecord['reason']): MemorySnapshotRecord => ({
    formatVersion: 1, capturedAt, text: null, reason, globalCoreCount: 0, projectCoreCount: 0, omittedCoreCount: 0
  })
  if (session.messages.length) return empty('legacy-session')
  if (isMemoryExcludedSessionState(session)) return empty(session.memoryOptOut && session.kind === 'primary' ? 'opt-out' : 'excluded')
  if (!memoryEnabled) return empty('disabled')
  if (!session.workspaceRoot) return empty('empty')
  try {
    const snapshot = capture(session.workspaceRoot, capturedAt)
    return { formatVersion: 1, capturedAt, text: snapshot.text, reason: snapshot.text ? 'captured' : 'empty',
      globalCoreCount: snapshot.globalCoreCount, projectCoreCount: snapshot.projectCoreCount, omittedCoreCount: snapshot.omittedCoreCount }
  } catch {
    console.warn('[MemorySnapshot] capture failed; continuing without saved memory')
    return empty('empty')
  }
}

/**
 * 会话侧遗忘副本：把遗忘闭包翻译为 SessionStore 的快照改写器。
 * 快照行按 escapeMemorySnapshotText 转义后精确匹配；冻结 prompt 只替换记忆层，
 * 层无法精确定位但正文行仍在时整层作废，下个 turn 从磁盘快照重建。
 */
export function createSessionSnapshotForgetCopy(getStore: () => SessionStore): MemoryForgetCopy {
  return {
    label: '会话记忆快照',
    redact(forgotten: ForgottenMemory): void {
      const targetLines = forgotten.contents.map(content => `- ${escapeMemorySnapshotText(content)}`)
      const hasForgottenLine = (prompt: string | undefined): boolean =>
        typeof prompt === 'string' && targetLines.some(line => prompt.includes(line))
      getStore().redactMemorySnapshots({
        // 只匹配带 '- ' 前缀的快照行：标题等普通字段可能恰好等于被遗忘正文，不算残留
        matchesRaw: raw => targetLines.some(line => raw.includes(JSON.stringify(line).slice(1, -1))),
        matchesPrompt: prompt => hasForgottenLine(prompt),
        redact(current) {
          const snapshot = current.memorySnapshot
          if (snapshot.text === null) {
            return hasForgottenLine(current.frozenSystemPrompt)
              ? { memorySnapshot: snapshot, frozenSystemPrompt: undefined }
              : null
          }
          const redacted = redactMemorySnapshotText(snapshot.text, forgotten)
          let prompt = current.frozenSystemPrompt
          if (prompt !== undefined) {
            const replaced = SystemPromptBuilder.replaceMemorySnapshotLayer(prompt, snapshot.text, redacted?.text ?? null)
            if (replaced !== null) prompt = replaced
            else if (hasForgottenLine(prompt)) prompt = undefined
          }
          if (redacted === null && prompt === current.frozenSystemPrompt) return null
          return {
            memorySnapshot: redacted === null ? snapshot : {
              ...snapshot,
              text: redacted.text,
              reason: redacted.text === null ? 'empty' : snapshot.reason,
              globalCoreCount: Math.max(0, snapshot.globalCoreCount - redacted.removedGlobal),
              projectCoreCount: Math.max(0, snapshot.projectCoreCount - redacted.removedProject)
            },
            frozenSystemPrompt: prompt
          }
        }
      })
    }
  }
}
