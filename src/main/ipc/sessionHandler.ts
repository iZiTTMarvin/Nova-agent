/**
 * 会话管理与回退操作 IPC handler
 *
 * 职责：
 * 1. 创建/加载/列表/删除会话（通过 SessionStore）
 * 2. 按文件拒绝（reject-file）：从 checkpoint 恢复单个文件
 * 3. 接受文件改动（accept-file）：标记文件已审查
 */
import { app, clipboard, dialog } from 'electron'
import { recoverSessionTurnDrafts } from '../../runtime/sessions'
import { settleSubagentToolCall } from '../../runtime/subagents/toolSettlement'
import { getRunCoordinator } from '../services/RunCoordinatorHost'
import { handle } from './secureIpc'
import {
  LOAD_SESSIONS,
  SESSION_EXPORT_MARKDOWN,
  LOAD_SESSION,
  LOAD_SESSION_MESSAGES,
  CREATE_SESSION,
  ACCEPT_FILE,
  REJECT_FILE,
  ACCEPT_ALL_FILES,
  REJECT_ALL_FILES
} from '../../shared/ipc/channels'
import { initSessionStoreHost } from '../services/SessionStoreHost'
import { buildMessageDiffState } from '../../runtime/checkpoints/diffState'
import { buildSessionDiffState } from '../../runtime/checkpoints/sessionDiffState'
import type { MessageDiffsState } from '../../shared/diff/types'
import type { SessionDetail, Message, BranchMeta } from '../../shared/session'
import type { Mode } from '../../shared/session'
import {
  extractTextFromSerializableContent,
  type SessionData,
  type SessionMessage
} from '../../runtime/sessions/types'
import { getSessionActiveMessages, attachBranchMeta, ensureMessageParentChain, resolveCurrentLeafId } from '../../runtime/sessions/tree'
import { exportSessionToMarkdown } from '../../runtime/sessions/sessionMarkdown'
import { writeFileSync } from 'fs'
import { GET_MESSAGE_DIFFS, GET_SESSION_DIFFS } from '../../shared/ipc/channels'
import { toSharedMessage } from './sessionMessageMapper'
import { getWorkspaceService } from '../services/WorkspaceService'
import { hydrateSessionWhitelistFromSession } from '../../runtime/permissions/PermissionManager'
import { INITIAL_SESSION_DISPLAY_PAGE_SIZE } from '../../shared/session/messagePagination'
import { getSubagentProjectionService } from '../services/SubagentProjectionServiceHost'

/** 将持久化 SessionMessage 转换为共享 Message 格式，保留工具调用结果与分支元信息 */
function toMessage(msg: SessionMessage & { branch?: BranchMeta }): Message & { _toolCallResults?: Record<string, string> } {
  const shared = toSharedMessage(msg)
  return msg.branch ? { ...shared, branch: msg.branch } : shared
}

/** 将持久化 SessionData 转换为共享 SessionDetail 格式 */
function toSessionDetail(
  data: SessionData,
  options?: { displayPage?: boolean; hasMore?: boolean; subagentTask?: string; isDraft?: boolean }
): SessionDetail {
  const displayPage = options?.displayPage === true
  const activeMessages = displayPage ? data.messages : getSessionActiveMessages(data)
  const totalCount = displayPage
    ? (data.messageCount ?? activeMessages.length)
    : activeMessages.length
  const allMessages = displayPage
    ? data.messages
    : ensureMessageParentChain(data.messages)
  const withBranch = displayPage
    ? activeMessages
    : attachBranchMeta(activeMessages, allMessages)
  const currentLeafId = displayPage
    ? (data.currentLeafId ?? null)
    : resolveCurrentLeafId(allMessages, data.currentLeafId)
  const hasMoreMessagesAbove = displayPage
    ? (options?.hasMore ?? totalCount > activeMessages.length)
    : undefined

  const base = {
    id: data.id,
    workspaceRoot: data.workspaceRoot,
    mode: data.mode,
    permissionMode: data.permissionMode,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    messageCount: totalCount,
    hasMoreMessagesAbove,
    currentLeafId,
    // compose 阶段表随会话详情透出，renderer 水合阶段条；旧会话为 undefined
    composeStages: data.composeStages,
    composeReviewLoops: data.composeReviewLoops,
    // 计划确认门状态随详情水合，renderer 据此决定审阅卡是否已放行；旧会话为 undefined
    composePlanApproval: data.composePlanApproval,
    // 会话级待办随详情水合，renderer 恢复 TodoPanel 与 compose 阶段条进度；旧会话为 undefined
    todos: data.todos,
    messages: withBranch.map(msg => ({
      ...toMessage(msg),
      sessionId: data.id
    })),
    subagentProjections: getSubagentProjectionService().listByParentSessionId(data.id)
  }
  if (data.kind === 'subagent') {
    const taskMessage = data.messages.find((message) => message.role === 'user')
    const subagentTask = options?.subagentTask !== undefined
      ? options.subagentTask
      : (taskMessage
        ? extractTextFromSerializableContent(taskMessage.content)
        : '')
    return {
      ...base,
      kind: 'subagent',
      subagent: {
        lineage: {
          parentSessionId: data.subagent.lineage.parentSessionId,
          depth: data.subagent.lineage.depth
        },
        profile: {
          profileId: data.subagent.profile.profileId,
          name: data.subagent.profile.name,
          permissionCeiling: data.subagent.profile.permissionCeiling
        }
      },
      subagentTask
    }
  }
  return { ...base, kind: 'primary', ...(options?.isDraft ? { isDraft: true as const } : {}) }
}


export function registerSessionHandler(): void {
  const appDataPath = app.getPath('userData')
  const sessionStore = initSessionStoreHost(appDataPath)

  // 加载会话列表
  handle(LOAD_SESSIONS, async () => {
    const summaries = sessionStore.list()
    return summaries
  })

  // 会话导出 Markdown：主进程一次性读全量（renderer 是分页加载的），
  // 只导出激活路径（messages 是树，直接顺序导会把废弃分支也倒出来）
  handle(SESSION_EXPORT_MARKDOWN, async (_event, params: { sessionId: string; target: 'clipboard' | 'file' }) => {
    if (typeof params?.sessionId !== 'string' || (params.target !== 'clipboard' && params.target !== 'file')) {
      throw new Error('session:export-markdown 参数不合法')
    }
    try {
      const session = sessionStore.load(params.sessionId)
      if (!session) return { status: 'failed' as const, error: '会话不存在' }
      const active = getSessionActiveMessages(session)
      const markdown = exportSessionToMarkdown(active, session.title)
      if (params.target === 'clipboard') {
        await clipboard.writeText(markdown)
        return { status: 'copied' as const }
      }
      const picked = await dialog.showSaveDialog({
        title: '导出会话为 Markdown',
        defaultPath: `${(session.title || session.id).replace(/[\/:*?"<>|]/g, '_')}.md`,
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (picked.canceled || !picked.filePath) return { status: 'cancelled' as const }
      writeFileSync(picked.filePath, markdown, 'utf8')
      return { status: 'saved' as const, filePath: picked.filePath }
    } catch (err) {
      return { status: 'failed' as const, error: err instanceof Error ? err.message : String(err) }
    }
  })


  // 加载单个会话的展示页（尾部消息）；上下文拆分延后全量计算后推送
  handle(LOAD_SESSION, async (_event, params: { sessionId: string }) => {
    // 与启动归档、sendAgentMessage 注入同一结算闭包：打开会话触发的归档同样要精确结算
    const settle = (input: Parameters<typeof settleSubagentToolCall>[1]) =>
      settleSubagentToolCall({ sessionStore, runCoordinator: getRunCoordinator() }, input)
    recoverSessionTurnDrafts(params.sessionId, sessionStore, getRunCoordinator(), settle)
    const display = sessionStore.loadForDisplay(params.sessionId, {
      tailLimit: INITIAL_SESSION_DISPLAY_PAGE_SIZE
    })
    if (!display) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }
    hydrateSessionWhitelistFromSession(display.session)
    getWorkspaceService().scheduleContextBreakdown(params.sessionId)
    return toSessionDetail(display.session, {
      isDraft: sessionStore.isDraft(params.sessionId),
      displayPage: true,
      hasMore: display.hasMore,
      subagentTask: display.subagentTask
    })
  })

  // 按游标加载更早的消息页（只读，不触发会话切换副作用）
  handle(
    LOAD_SESSION_MESSAGES,
    async (
      _event,
      params: { sessionId: string; beforeId?: string; limit: number }
    ): Promise<{ messages: Message[]; hasMore: boolean }> => {
      const page = sessionStore.loadMessagesPage(params.sessionId, {
        beforeId: params.beforeId,
        limit: params.limit
      })
      if (!page) {
        throw new Error(`会话 ${params.sessionId} 不存在`)
      }
      return {
        messages: page.messages.map(msg => ({
          ...toMessage(msg),
          sessionId: params.sessionId
        })),
        hasMore: page.hasMore
      }
    }
  )

  // 创建新会话
  handle(CREATE_SESSION, async (_event, params: { workspaceRoot: string; mode?: Mode }) => {
    const state = getWorkspaceService().createSession({
      workspaceRoot: params.workspaceRoot,
      mode: params.mode ?? 'default'
    })
    const data = state.currentSessionId ? sessionStore.load(state.currentSessionId) : null
    if (!data) {
      throw new Error('新会话创建后无法读取')
    }
    return toSessionDetail(data, { isDraft: sessionStore.isDraft(data.id) })
  })

  // 接受文件改动：标记为已审查（委托 WorkspaceService → DiffReviewService）
  handle(ACCEPT_FILE, async (
    _event,
    params: { sessionId: string; messageId: string; filePath: string }
  ): Promise<void> => {
    getWorkspaceService().acceptFile(params.sessionId, params.messageId, params.filePath)
  })

  // 批量接受文件改动（PRD §5.3）：委托给 WorkspaceService
  handle(ACCEPT_ALL_FILES, async (
    _event,
    params: { sessionId: string; messageId: string; filePaths: string[] }
  ): Promise<void> => {
    const ws = getWorkspaceService()
    ws.acceptAllFiles(params.sessionId, params.messageId, params.filePaths)
  })

  // 批量拒绝文件改动（PRD §5.3）：委托给 WorkspaceService
  // 预检零副作用；任一目标失败整批不执行，失败原因收集到 failed 返回
  handle(REJECT_ALL_FILES, async (
    _event,
    params: {
      sessionId: string
      messageId: string
      files: Array<{ filePath: string; expectedDigest: string | null }>
    }
  ): Promise<{ restored: string[]; failed: Array<{ filePath: string; error: string }> }> => {
    const ws = getWorkspaceService()
    return ws.rejectAllFiles(params.sessionId, params.messageId, params.files)
  })

  // 获取某条消息的所有文件 diff（含审查状态）
  handle(GET_MESSAGE_DIFFS, async (
    _event,
    params: { sessionId: string; messageId: string }
  ): Promise<MessageDiffsState> => {
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    return buildMessageDiffState(
      sessionStore.getSessionsDir(),
      session.workspaceRoot,
      params.sessionId,
      params.messageId
    )
  })

  handle(GET_SESSION_DIFFS, async (
    _event,
    params: { sessionId: string }
  ) => {
    const session = sessionStore.load(params.sessionId)
    if (!session) {
      throw new Error(`会话 ${params.sessionId} 不存在`)
    }

    return buildSessionDiffState(
      sessionStore.getSessionsDir(),
      session.workspaceRoot,
      params.sessionId
    )
  })

  // 按文件拒绝：委托 WorkspaceService（忙碌守卫）→ DiffReviewService（plan/execute 恢复）
  handle(REJECT_FILE, async (
    _event,
    params: { sessionId: string; messageId: string; filePath: string; expectedDigest: string | null }
  ) => {
    getWorkspaceService().rejectFile(
      params.sessionId,
      params.messageId,
      params.filePath,
      params.expectedDigest
    )
  })
}
