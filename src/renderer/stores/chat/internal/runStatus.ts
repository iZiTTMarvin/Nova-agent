import type { RunStatus } from '../../../../shared/run/types'

/** run 是否处于终态（切会话派生 isGenerating 时使用，与 useRunStore 口径一致） */
export function isTerminalRunStatusLocal(status: RunStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  )
}
