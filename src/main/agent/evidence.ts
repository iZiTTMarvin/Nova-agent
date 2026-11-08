import type { EvidenceReference } from '../../shared/evidence'
import type { SessionStore } from '../../runtime/sessions/SessionStore'
import type { RunCoordinator } from '../../runtime/run'

/** 查询持久消息与执行中草稿，不维护第二份证据目录。 */
export function listSessionEvidence(
  sessionStore: SessionStore,
  coordinator: RunCoordinator,
  sessionId: string
): EvidenceReference[] {
  const session = sessionStore.load(sessionId)
  if (!session) return []
  const draft = coordinator.getSnapshotForSession(sessionId)?.turnDraft
  const blocks = [...session.messages.flatMap(message => message.blocks ?? []), ...(draft?.blocks ?? [])]
  return blocks.flatMap(block => block.type === 'tool' ? block.evidence ?? [] : [])
}
