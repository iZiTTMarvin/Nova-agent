/**
 * IPC 命令和事件的类型定义
 * 保证 renderer → main 命令和 main → renderer 事件的端到端类型安全
 */
import type { Mode, PermissionDecision, Message, Session, SessionDetail } from '../session'
import type { ModelConfig } from '../config'
import type { DiffEntry, DiffReviewStatus } from '../diff'
import type { NormalizedUsage } from '../../runtime/model/types'
import type { TodoItem, TodoViewInfo } from '../todo/types'

// ── renderer → main 命令的参数和返回值 ──────────────────────

export interface IpcCommands {
  ping: {
    params: void
    result: string
  }
  'select-project': {
    params: void
    result: string | null
  }
  'send-message': {
    params: {
      sessionId: string
      content: string
      images?: Array<{
        fileName: string
        /** base64 data: URI（renderer 端 FileReader.readAsDataURL 编码） */
        data: string
        mimeType: string
      }>
    }
    result: void
  }
  'cancel-execution': {
    params: void
    result: void
  }
  'save-model-config': {
    params: ModelConfig
    result: void
  }
  'load-model-config': {
    params: void
    result: ModelConfig | null
  }
  'set-mode': {
    params: { mode: Mode; sessionId?: string }
    result: void
  }
  'accept-file': {
    params: { sessionId: string; messageId: string; filePath: string }
    result: void
  }
  'get-message-diffs': {
    params: { sessionId: string; messageId: string }
    result: {
      diffs: DiffEntry[]
      reviews: Record<string, DiffReviewStatus>
    }
  }
  'reject-file': {
    params: { sessionId: string; messageId: string; filePath: string }
    result: void
  }
  'rollback-message': {
    params: { sessionId: string; messageId: string }
    result: void
  }
  'respond-permission': {
    params: { requestId: string; decision: PermissionDecision }
    result: void
  }
  'respond-verification-permission': {
    params: { requestId: string; granted: boolean }
    result: void
  }
  'load-sessions': {
    params: void
    result: Session[]
  }
  'load-session': {
    params: { sessionId: string }
    result: SessionDetail
  }
  'create-session': {
    params: { workspaceRoot: string; mode?: Mode }
    result: SessionDetail
  }
  'delete-session': {
    params: { sessionId: string }
    result: void
  }
  'window-minimize': {
    params: void
    result: void
  }
  'window-maximize': {
    params: void
    result: void
  }
  'window-close': {
    params: void
    result: void
  }
  'window-is-maximized': {
    params: void
    result: boolean
  }
}

/** 所有命令 channel 名称 */
export type IpcCommandChannel = keyof IpcCommands

// ── main → renderer 事件的数据类型 ──────────────────────

export interface IpcEvents {
  'agent:message-start': {
    messageId: string
  }
  'agent:text-delta': {
    messageId: string
    delta: string
  }
  'agent:tool-call-start': {
    messageId: string
    toolCallId: string
    toolName: string
  }
  'agent:tool-call-delta': {
    messageId: string
    toolCallId: string
    argumentsDelta: string
  }
  'agent:tool-call': {
    messageId: string
    toolCallId: string
    toolName: string
    args: Record<string, unknown>
  }
  'agent:tool-result': {
    messageId: string
    toolCallId: string
    toolName: string
    result: string
  }
  'agent:permission-request': {
    messageId: string
    requestId: string
    toolName: string
    args: Record<string, unknown>
    riskLevel: 'low' | 'medium' | 'high'
    reason: string
  }
  'agent:diff-update': {
    messageId: string
    /** live: 工具执行后实时占位信号（无 hunks）；final: 最终数据（含 hunks） */
    phase: 'live' | 'final'
    /**
     * 文件级元数据。
     * phase === 'live' 时 hunks 字段保证为空数组；
     * phase === 'final' 时携带完整 hunks。
     */
    diffs: Array<{ filePath: string; status: DiffEntry['status']; hunks?: DiffEntry['hunks'] }>
    reviews: Record<string, DiffReviewStatus>
  }
  'agent:verification-result': {
    messageId: string
    result: string
  }
  'agent:verification-permission-request': {
    messageId: string
    requestId: string
    command: string
  }
  'agent:verification-permission-cleared': {
    messageId: string
    requestId: string
  }
  'agent:todos-updated': {
    sessionId: string
    todos: TodoItem[]
    view: TodoViewInfo
  }
  'agent:error': {
    messageId: string
    error: string
  }
  'agent:message-end': {
    messageId: string
  }
  'agent:thinking-delta': {
    messageId: string
    delta: string
  }
  'agent:usage': {
    messageId: string
    usage: NormalizedUsage
  }
  'window:maximize-change': {
    isMaximized: boolean
  }
}

/** 所有事件 channel 名称 */
export type IpcEventChannel = keyof IpcEvents

/** 事件监听回调类型 */
export type IpcEventCallback<T extends IpcEventChannel> = (data: IpcEvents[T]) => void
