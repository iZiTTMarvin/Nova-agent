import { handle } from './secureIpc'
import { EVIDENCE_READ_ARTIFACT, EVIDENCE_OPEN_BROWSER } from '../../shared/ipc/channels'
import type { EvidenceReadResult } from '../../shared/evidence'
import { ArtifactStore } from '../../runtime/artifacts/ArtifactStore'
import { getSessionStore } from '../services/SessionStoreHost'
import { getRunCoordinator } from '../services/RunCoordinatorHost'
import { getBrowserSessionHost } from '../browser'
import { browserNotApplied } from '../../shared/browser'
import { listSessionEvidence } from '../agent/evidence'

function parseRequest(raw: unknown): { sessionId: string; id: string } {
  if (!raw || typeof raw !== 'object' || !('sessionId' in raw) || typeof raw.sessionId !== 'string' ||
      !/^[A-Za-z0-9_-]+$/.test(raw.sessionId) || !('id' in raw) || typeof raw.id !== 'string') {
    throw new Error('证据请求无效')
  }
  return { sessionId: raw.sessionId, id: raw.id }
}

export function registerEvidenceHandler(): void {
  handle(EVIDENCE_READ_ARTIFACT, async (_event, raw: unknown): Promise<EvidenceReadResult> => {
    try {
      const { sessionId, id } = parseRequest(raw)
      const sessions = getSessionStore()
      const reference = listSessionEvidence(sessions, getRunCoordinator(), sessionId)
        .find(ref => ref.kind === 'artifact' && ref.artifactId === id)
      if (!reference) throw new Error('当前会话没有这份工具产物')
      const text = await new ArtifactStore(sessions.getSessionsDir()).readEvidence(sessionId, id)
      if (!sessions.loadMetadata(sessionId)) throw new Error('会话已删除')
      return { status: 'available', text }
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof Error ? error.message : '证据不可用' }
    }
  })
  handle(EVIDENCE_OPEN_BROWSER, async (_event, raw: unknown) => {
    try {
      const { sessionId, id } = parseRequest(raw)
      const reference = listSessionEvidence(getSessionStore(), getRunCoordinator(), sessionId)
        .find(ref => ref.kind === 'image' && ref.url === id)
      if (reference?.kind !== 'image' || !reference.browser) throw new Error('没有可核对的实时页面，请重新验证')
      const host = getBrowserSessionHost()
      if (!host) throw new Error('浏览器不可用，请重新启动并验证')
      return host.openEvidence(sessionId, reference.browser)
    } catch (error) {
      return browserNotApplied('target_missing', error instanceof Error ? error.message : '实时页面不可用')
    }
  })
}
