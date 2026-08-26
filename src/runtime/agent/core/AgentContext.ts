/** Agent 循环与生命周期服务共享的可变运行态，不承载控制流。 */
import type { ChatMessage, ToolDefinition } from '../../model/types'
import type { ToolRegistry } from '../../tools/ToolRegistry'
import type { ToolDialect } from '../../model/dialect'
import type { Mode, PermissionMode } from '../../../shared/session/types'
import type { PermissionCapabilityCeiling } from '../../../shared/permissions/types'
import type { SessionStore } from '../../sessions/SessionStore'
import type { ArtifactStore } from '../../artifacts/ArtifactStore'
import type { ReadState } from '../../tools/editTool'
import type { ToolAvailability } from '../../tools/availability'
import type { ToolPresentationMode } from '../../code-mode'
import { applyToolPresentation } from '../../code-mode'
import { getModeVisibleTools } from '../../../shared/session/toolVisibility'

export interface AgentContext {
  /** 对话上下文（含 system 在 [0]） */
  messages: ChatMessage[]
  /** 冻结的 system prompt 文本（与 messages[system] 同源） */
  systemPrompt: string
  /** 工具注册表（可空） */
  toolRegistry: ToolRegistry | null
  /** 可选的运行时有效工具定义来源；未设置时使用 toolRegistry 全量定义 */
  effectiveToolDefinitions: (() => ToolDefinition[]) | null
  /**
   * 工具分组可用性（会话级）。
   * 与 mode 过滤正交；在 getEffectiveToolDefinitions 中于 mode 之后组合。
   */
  toolAvailability: ToolAvailability | null
  /**
   * 工具呈现模式（进程级实验配置，会话内稳定）：direct 直调 / code-readonly 沙箱 SDK。
   * 在 Mode → Availability 之后做最后一层投影，只改变调用形式不改变能力边界。
   */
  toolPresentation: ToolPresentationMode
  /** 当前工具方言 */
  dialect: ToolDialect
  /** 运行模式 */
  mode: Mode
  /** 本轮捕获的会话权限模式。 */
  permissionMode: PermissionMode
  /** 能力上限（如只读子代理）；null 表示无上限。 */
  permissionCeiling: PermissionCapabilityCeiling | null
  /** 执行环境 */
  workingDir: string | null
  shellPath: string | undefined
  binDirs: string[]
  /**
   * 当前 runId（写者租约 / 子代理权限按 run 归属时使用）。
   * 由 AgentTurnService 在 startRun 后注入；装配期可能为空字符串。
   */
  runId: string | null
  /** writer lease 的 root ownership group；delegated run 与父级共享。 */
  resourceOwnerRunId: string | null
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

/**
 * 创建一个带默认值的 AgentContext。
 * readState 是必填：它依赖 editTool 的具体实现，由调用方（AgentLoop 构造函数）
 * 传入 createReadState() 的结果。
 */
export function createAgentContext(initial: {
  readState: AgentContext['readState']
} & Partial<AgentContext>): AgentContext {
  return {
    messages: [],
    systemPrompt: '',
    toolRegistry: null,
    effectiveToolDefinitions: null,
    toolAvailability: null,
    toolPresentation: 'direct',
    dialect: 'xml',
    mode: 'default',
    permissionMode: 'request_approval',
    permissionCeiling: null,
    workingDir: null,
    shellPath: undefined,
    binDirs: [],
    runId: null,
    resourceOwnerRunId: null,
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

/**
 * 模型可见工具投影唯一出口：registry/provider → mode → group → presentation。
 * 装配层拼 toolSummary 时必须调用本函数，禁止平行过滤。
 */
export function projectEffectiveToolDefinitions(
  mode: Mode,
  definitions: readonly ToolDefinition[],
  availability: ToolAvailability | null | undefined,
  presentation: ToolPresentationMode = 'direct'
): ToolDefinition[] {
  const modeVisible = getModeVisibleTools(mode, definitions)
  const availabilityVisible = availability
    ? availability.filterDefinitions(modeVisible)
    : modeVisible
  return applyToolPresentation(presentation, availabilityVisible)
}

export function getEffectiveToolDefinitions(context: AgentContext): ToolDefinition[] {
  const definitions =
    context.effectiveToolDefinitions?.() ?? context.toolRegistry?.getToolDefinitions() ?? []
  return projectEffectiveToolDefinitions(
    context.mode,
    definitions,
    context.toolAvailability,
    context.toolPresentation
  )
}
