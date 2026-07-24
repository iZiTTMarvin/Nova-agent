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
  /**
   * 当前会话「激活路径消息集合」的版本号，每次发生「不换会话但消息序列变化」的操作
   * （切分支 / 分叉完成补同步 / desync 纠正等）时由主进程 +1。
   *
   * 存在原因：renderer 的 syncFromWorkspace 仅在 currentSessionId 变化时才重拉消息，
   * 回退/切分支不换会话会被该守卫拦截，导致「主进程切了、界面没切」。renderer 据此
   * revision 变化来触发同会话内的消息重拉，绕过 sessionChanged 守卫。
   */
  messagesRevision: number
  /**
   * Tier 1 切分支后的视图上下文：工作区停在 LCA，仅展示对话历史。
   * 非切分支操作为 null。
   */
  tier1BranchContext: Tier1BranchContext | null
}

/** Tier 1 分支视图：磁盘未重放目标分支的文件改动 */
export interface Tier1BranchContext {
  /** 当前激活路径上翻页器序号（1-based） */
  branchIndex: number
  branchTotal: number
  /**
   * Tier 1/2 切分支后的 diff 灰显列表：forward 重放未完成时，对应 assistant 消息的 diff 仅作历史展示。
   * partialReplay=true 表示部分消息已成功重放，仅灰显未完成项。
   */
  staleDiffMessageIds: string[]
  /** true=部分 forward 重放成功；false=全部未能重放（Tier 1 回退） */
  partialReplay?: boolean
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

/** 当前会话 active plan 的完整审阅文档。 */
export interface ActivePlanDocument {
  /** 相对于工作区根目录的 `.nova/plans/*.md` 路径 */
  path: string
  title: string
  updatedAt: number
  content: string
}

/** 只读取指定会话当前登记的 active plan，不接受任意文件路径。 */
export interface ReadActivePlanParams {
  sessionId?: string
  /** 防止历史 save_plan 卡片误读后来切成另一文件路径的新计划 */
  expectedPath?: string
  /** 防止历史 save_plan 卡片误读后来替换的另一份计划 */
  expectedTitle?: string
}
