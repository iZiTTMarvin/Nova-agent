/**
 * 工作区单一事实源类型定义
 *
 * 与 PRD §5.1 对齐。WorkspaceState 是应用级的"当前状态"：
 * 当前会话 ID、当前项目路径、当前运行模式。由主进程 WorkspaceService 持有，
 * 通过 workspace:changed 广播给 renderer。
 */
import type { Mode } from '../session/types'
import type { Session } from '../session/types'

/** 工作区状态广播载荷 */
export interface WorkspaceState {
  /** 当前会话 ID，无会话时为 null */
  currentSessionId: string | null
  /** 当前项目（工作区）绝对路径，无时为 null */
  currentProjectPath: string | null
  /** 当前运行模式 */
  currentMode: Mode
  /** 当前可用的会话列表（供侧边栏展示，避免 renderer 二次拉取） */
  availableSessions: Session[]
}

/** 选择项目操作的参数（预留扩展） */
export interface SelectProjectParams {
  /** 强制指定路径；为空时由主进程弹文件夹选择对话框 */
  path?: string
}

/** 创建会话操作的参数 */
export interface CreateSessionParams {
  workspaceRoot: string
  mode?: Mode
}

/** 设置模式操作的参数 */
export interface SetModeParams {
  mode: Mode
  /** 若提供则同时持久化到指定会话；否则用当前会话 */
  sessionId?: string
}

/** 回滚消息操作的参数 */
export interface RollbackMessageParams {
  sessionId: string
  messageId: string
}
