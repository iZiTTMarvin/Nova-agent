/**
 * 宿主能力层契约。
 *
 * host/ 只提供能力，不知道在跑哪个 workflow：本文件不得引用 definitions/ 的任何类型。
 * 所有副作用提交前必须过 assertScopeLive —— TaskScope 关闭（取消/超时/终态）后，
 * 旧 continuation 无权再写工作区、发事件或落盘。
 */
import type { EventBus } from '../../agent/EventBus'
import type { ModelClient } from '../../model/ModelClient'
import type { CheckpointManager } from '../../checkpoints/CheckpointManager'
import type { Mode } from '../../../shared/session/types'
import type { ToolExecutor } from '../../tools/types'
import type { SubAgentPermissionBridge } from '../../tools/subAgentBridge'
import type { AskQuestionAnswer, AskQuestionItem } from '../../../shared/askQuestion/types'
import type { WorkflowProgressDetail, WorkflowProgressStatus } from '../../agent/types'
import type { TaskScope } from '../scheduling/TaskScope'
import type { Semaphore } from '../scheduling/semaphore'
import type { JournalLoad } from '../state/journal'
import type { SideEffectCtx } from '../effects/sideEffectCtx'
import type { WorktreeInfo } from '../../worktree'

/**
 * 子 agent 的隔离模式。
 * - shared：共享主工作区（默认），结果进 journal 缓存
 * - worktree：独立 git worktree，产物是目录，不进 journal
 * - readonly：只读工具集，用于调研类阶段
 */
export type IsolationMode = 'shared' | 'worktree' | 'readonly'

export interface AgentOptions {
  isolation?: IsolationMode
  /** 工具白名单；缺省按隔离模式取默认集 */
  tools?: string[]
  /**
   * 是否允许该子 agent 向用户提问。
   * 仅 shared 隔离且 autoMode 关闭时生效；其余情况一律剔除 askQuestion。
   */
  interactive?: boolean
  /** 强制结构化返回；命中后 agent() 解析为对象，解析失败返回 null */
  schema?: Record<string, unknown>
  /** 单次调用超时，默认 10 分钟 */
  timeoutMs?: number
  /** 仅展示用，不参与 journal hash */
  label?: string
  /** 覆盖默认模型，参与 journal hash */
  model?: string
  /** 当前阶段名，参与 journal hash；缺省取 HostContext.currentPhase */
  phase?: string
  /**
   * 在已有目录内执行（复用某个 worktree 做 verify/debug）。
   * 优先于 isolation；不新建 worktree，也不写 journal。
   */
  directory?: string
  /**
   * isolation='worktree' 时的 worktree 复用键。
   * 同键调用复用同一 worktree；缺省由 prompt 内容哈希派生，保证 resume 稳定。
   * 调用方可用同一键调 host.worktree(key) 取回句柄。
   */
  worktreeKey?: string
}

/** agent() 的返回值：never-throw，失败一律 null */
export type AgentResult = string | Record<string, unknown> | null

export interface BashOptions {
  /** 执行目录，默认工作区根；必须在工作区内 */
  cwd?: string
}

export interface BashResult {
  /** 取消 / 越界 / 权限拒绝一律 -1，不抛异常 */
  exitCode: number
  stdout: string
  stderr: string
}

/** 本 run 拥有的 worktree 句柄 */
export interface WorktreeHandle {
  key: string
  name: string
  branch: string
  directory: string
  /** 创建时的 HEAD sha，判定 pristine 的基线 */
  baseSha: string
  /** 命中复用（同 key 或 resume receipt）时为 true */
  reused: boolean
}

export type IntegrateResult =
  /** 已合并回主工作区，worktree 已删除 */
  | { status: 'merged'; strategy: 'fast-forward' | 'three-way' | 'agent'; sha: string | null }
  /** 无实际改动：worktree 已删除，无需合并 */
  | { status: 'pristine' }
  /** 冲突且 integrate agent 未能解决：冲突现场保留，worktree 保留 */
  | { status: 'conflict'; files: string[] }
  /** 基础设施失败（scope 关闭 / git 出错）：worktree 保留待人工处理 */
  | { status: 'failed'; reason: string }

export interface IntegrateOptions {
  /** 合并提交信息 */
  message?: string
  /** 冲突时给 integrate agent 的额外上下文 */
  context?: string
}

/**
 * workflow definition 可用的全部宿主能力。
 * definition 只依赖本接口，不直接接触 AgentLoop / git / fs。
 */
export interface HostFns {
  agent(prompt: string, opts?: AgentOptions): Promise<AgentResult>
  bash(command: string, opts?: BashOptions): Promise<BashResult>
  /** 文件不存在返回 null；路径越界抛错 */
  read(path: string): Promise<string | null>
  /** scope 关闭后抛错拒绝写入 */
  write(path: string, content: string): Promise<void>
  delete(path: string): Promise<void>
  exists(path: string): Promise<boolean>
  /** 工作区内相对路径 glob，结果为正斜杠相对路径 */
  glob(pattern: string): Promise<string[]>
  /** 按 key 创建或复用 worktree；创建失败抛错 */
  worktree(key: string): Promise<WorktreeHandle>
  /** 合并 worktree 回主工作区：fast-forward → 3-way → integrate agent */
  integrate(directory: string, opts?: IntegrateOptions): Promise<IntegrateResult>
  /** 删除 worktree（integrate 之外的显式清理）；成功返回 true */
  cleanupWorktree(directory: string): Promise<boolean>
  progress(phase: string, status: WorkflowProgressStatus, detail?: WorkflowProgressDetail): void
  log(message: string): void
}

/** 本 run 创建的 worktree，终态时按生命周期契约清理 */
export interface OwnedWorktree {
  info: WorktreeInfo
  baseSha: string
}

/**
 * 全部 host 函数共享的运行上下文。
 * Owner 是 orchestrator：host 只读取，不改写除 currentPhase / occ / ownedWorktrees 之外的字段。
 */
export interface HostContext {
  runId: string
  workspaceRoot: string
  sessionId?: string
  /** 本 run 的 TaskScope；副作用提交前校验 generation */
  scope: TaskScope
  /** spawn 时捕获的 generation；scope close 后失效 */
  scopeGeneration: number
  abortSignal: AbortSignal
  /** 向 renderer 发事件的总线（父 run 的 bus） */
  eventBus: EventBus
  modelClient: ModelClient
  resolveTool: (name: string) => ToolExecutor | undefined
  checkpointManager?: CheckpointManager
  contextWindow?: number
  supportsVision?: boolean
  /** 子 agent 行为模式，编排内默认 compose */
  mode?: Mode
  permissionBridge?: SubAgentPermissionBridge
  /**
   * 提问通道：由装配方（agentHandler）注入。
   * host 自身不提供 askUser 能力——决策交互只能由阶段 agent 的 askQuestion 工具发起，
   * 这是 orchestrator 无暂停态的前提。缺省时该工具降级为 no-op。
   */
  askQuestion?: (
    requestId: string,
    questions: AskQuestionItem[]
  ) => Promise<AskQuestionAnswer[]>
  /** Auto 模式：true 时任何子 agent 都不携带 askQuestion */
  autoMode: boolean
  /** journal 缓存（resume 预载）+ per-run 出现次数计数 */
  journal: JournalLoad
  occ: Map<string, number>
  runSem: Semaphore
  globalSem: Semaphore
  /** 本 run 拥有的 worktree，供终态 reclaim；key 为 directory */
  ownedWorktrees: Map<string, OwnedWorktree>
  /** worktree 复用索引：调用方 key → directory */
  worktreeKeys: Map<string, string>
  /** 当前阶段名（progress 更新，journal hash 使用） */
  currentPhase: { name: string }
  /**
   * 可选：父 Agent run 的 execution generation fencing。
   * 与 TaskScope 叠加——任一侧失效都拒绝副作用（嵌套编排场景）。
   */
  assertExecutionCurrent?: () => boolean
}

/**
 * 副作用提交前的统一闸门。
 * 三个条件任一不满足即拒绝：scope 已关闭或换代、abort 已触发、父 run generation 失效。
 */
export function assertScopeLive(ctx: HostContext): boolean {
  if (!ctx.scope.isCurrent(ctx.scopeGeneration)) return false
  if (ctx.abortSignal.aborted) return false
  if (ctx.assertExecutionCurrent && !ctx.assertExecutionCurrent()) return false
  return true
}

/**
 * 为副作用凭证构造内容寻址的上下文。
 *
 * 新架构没有 step graph，凭证的幂等键改由 run + 稳定业务 key 派生，
 * 这样 resume 重跑同一 key 时能命中已 committed 的凭证而不重复提交副作用。
 */
export function hostEffectCtx(runId: string, key: string): SideEffectCtx {
  return {
    runId,
    stepId: key,
    idempotencyKey: `${runId}:${key}`
  }
}
