/**
 * AgentContext — 标准化状态容器（PRD §6.1）
 *
 * 在循环与各扩展间流转的纯状态。本阶段（Phase 1）只做"状态收纳"：
 * AgentLoop 内部原有字段被代理到 AgentContext 实例，对外行为逐字节等价。
 *
 * 设计约束（PRD §2.1 目标 4 / §6.1 注释）：
 * - fork() / snapshot() / rollback() 为 future，本期不实现。
 * - 本接口目前仅承载"数据"，不做任何控制流。
 *
 * 字段命名与 AgentLoop 既有字段一一对应，迁移时通过访问器桥接（PRD §8 Phase 1）。
 */
import type { ChatMessage, ToolDefinition } from '../../model/types'
import type { ToolRegistry } from '../../tools/ToolRegistry'
import type { ToolDialect } from '../../model/dialect'
import type { Mode } from '../../../shared/session/types'
import type { SessionStore } from '../../sessions/SessionStore'
import type { ArtifactStore } from '../../artifacts/ArtifactStore'
import type { ReadState } from '../../tools/editTool'
import { getModeVisibleTools } from '../../../shared/session/toolVisibility'

/** 标准化状态容器：在循环与各扩展间流转的纯状态 */
export interface AgentContext {
  /** 对话上下文（含 system 在 [0]） */
  messages: ChatMessage[]
  /** 冻结的 system prompt 文本（与 messages[system] 同源） */
  systemPrompt: string
  /** 工具注册表（可空） */
  toolRegistry: ToolRegistry | null
  /** 可选的运行时有效工具定义来源；未设置时使用 toolRegistry 全量定义 */
  effectiveToolDefinitions: (() => ToolDefinition[]) | null
  /** 当前工具方言 */
  dialect: ToolDialect
  /** 运行模式 */
  mode: Mode
  /** 执行环境 */
  workingDir: string | null
  shellPath: string | undefined
  binDirs: string[]
  /**
   * 当前 runId（写者租约 / 子代理权限按 run 归属时使用）。
   * 由 AgentTurnService 在 startRun 后注入；装配期可能为空字符串。
   */
  runId: string | null
  /** 工作区根，与 workingDir 同义；专门给写者租约按工作区分桶用。 */
  workspaceRoot: string | null
  /** 会话信息 */
  sessionStore: SessionStore | null
  sessionId: string | null
  artifactStore: ArtifactStore | null
  /** 先读后改状态 */
  readState: ReadState
  /** 压缩相关运行态 */
  compactionLevel: number
  userTurnsSinceCompaction: number
  lastEstimatedTokens: number
  /** 技能正文 token 预算 */
  skillsTokenBudget: number
}
// 注：fork()/snapshot()/rollback() 为 future，本期不实现。

/**
 * 创建一个带默认值的 AgentContext。
 * AgentLoop 构造时调用，把既有字段初值收敛进 ctx。
 *
 * readState 是必填：它依赖 editTool 的具体实现，由调用方（AgentLoop 构造函数）
 * 传入 createReadState() 的结果，避免 core/ 反向依赖 tools/。
 */
export function createAgentContext(initial: {
  readState: AgentContext['readState']
} & Partial<AgentContext>): AgentContext {
  return {
    messages: [],
    systemPrompt: '',
    toolRegistry: null,
    effectiveToolDefinitions: null,
    dialect: 'xml',
    mode: 'default',
    workingDir: null,
    shellPath: undefined,
    binDirs: [],
    runId: null,
    workspaceRoot: null,
    sessionStore: null,
    sessionId: null,
    artifactStore: null,
    compactionLevel: 0,
    userTurnsSinceCompaction: 0,
    lastEstimatedTokens: 0,
    skillsTokenBudget: 0,
    ...initial
  }
}

export function getEffectiveToolDefinitions(context: AgentContext): ToolDefinition[] {
  const definitions =
    context.effectiveToolDefinitions?.() ?? context.toolRegistry?.getToolDefinitions() ?? []
  return getModeVisibleTools(context.mode, definitions)
}
