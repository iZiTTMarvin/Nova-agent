import { randomUUID } from 'crypto'
import type { IpcCommands } from '../../../shared/ipc/types'
import type { SessionMessageAppend } from '../../../runtime/sessions/types'
import { generateSessionTitleFromText } from '../../../runtime/sessions/types'
import { getSessionStore } from '../../services/SessionStoreHost'
import { getWorkspaceService } from '../../services/WorkspaceService'

interface ExecutePlanCommandParams {
  sessionId: string
  content: string
  userMessageId?: string
}

function appendMessage(sessionId: string, message: SessionMessageAppend): void {
  const result = getSessionStore().appendMessageFast(sessionId, message)
  if (!result.ok) throw new Error(`命令消息写入失败: ${result.error}`)
}

/** 切换规划模式并通过 SessionStore 发布可恢复的命令回执。 */
export function executePlanCommand(
  params: ExecutePlanCommandParams
): IpcCommands['send-message']['result'] {
  const sessionStore = getSessionStore()
  const workspace = getWorkspaceService()
  const wasPlanning = sessionStore.loadMetadata(params.sessionId)?.mode === 'plan'
  const wasDraft = sessionStore.isDraft(params.sessionId)

  workspace.setMode({
    sessionId: params.sessionId,
    mode: 'plan',
    source: 'user'
  })

  const userMessageId = params.userMessageId ?? `msg_${randomUUID()}_user`
  const timestamp = Date.now()
  appendMessage(params.sessionId, {
    id: userMessageId,
    role: 'user',
    content: params.content,
    timestamp
  })
  appendMessage(params.sessionId, {
    id: `${userMessageId}_assistant`,
    role: 'assistant',
    content: wasPlanning
      ? '已处于规划模式。'
      : '已切换到规划模式。接下来将只读分析工作区并保存计划。',
    timestamp: Date.now()
  })
  if (wasDraft) {
    sessionStore.updateTitle(
      params.sessionId,
      generateSessionTitleFromText(params.content),
      'generated'
    )
    workspace.refreshAvailableSessions()
  }
  workspace.bumpMessagesRevision()

  return { accepted: true, completion: { commandName: 'plan' } }
}
