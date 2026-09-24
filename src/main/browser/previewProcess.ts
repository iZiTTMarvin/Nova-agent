/**
 * 把预览 origin 对上 processRegistry 里仍在跑的进程。
 * 只读匹配；零个或多个命中都不绑定，避免猜错后去管别人的进程。
 */
import type { PreviewProcessQuery } from './previewGrants'
export interface RunningPreviewProcess {
  readonly ref: string
  readonly command: string
}

export function findOwnedPreviewRef(
  processes: readonly RunningPreviewProcess[],
  origin: string
): string | null {
  if (origin.length === 0) return null
  const hits = processes.filter((item) => item.command.includes(origin))
  if (hits.length !== 1) return null
  const match = hits[0]
  return match ? match.ref : null
}

export function createRegistryPreviewQuery(
  listRunning: (sessionId: string) => readonly RunningPreviewProcess[]
): PreviewProcessQuery {
  return {
    findRunning(sessionId, origin) {
      return findOwnedPreviewRef(listRunning(sessionId), origin)
    }
  }
}
