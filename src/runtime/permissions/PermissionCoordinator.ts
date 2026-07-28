/**
 * PermissionCoordinator — 权限交互协调器，工具执行前权限判定与用户确认等待的唯一 owner。
 *
 * 职责边界：
 * - PermissionManager 仍是规则判定真源（allow/deny/ask），本类不复制任何规则；
 * - 本类独占 pending resolver（requestId → resolve/reject），负责 ask 决策的
 *   permission_request 事件发射与用户回应等待；
 * - 单项与批量路径共享同一基础判定（authorization overlay → 无 Manager 安全降级 →
 *   PermissionManager.check），不存在第二套规则入口。
 *
 * requestId 只由本类生成和持有；每个 AgentLoop 持有独立实例，
 * 跨 run / 子代理的路由仍由主进程 controller 与 SubAgentPermissionBridge 负责。
 */
import { randomUUID } from 'crypto'
import type { Mode } from '../../shared/session/types'
import { getToolCapability } from '../../shared/session/toolVisibility'
import type { AgentEvent } from '../agent/types'
import type { RiskLevel } from './types'
import {
  isSafeAutomaticModeTransition,
  type PermissionManager
} from './PermissionManager'

/** plan 模式下仅允许只读和 plan-artifact 能力的工具 */
function isPlanModeBlocked(toolName: string): boolean {
  const cap = getToolCapability(toolName)
  return cap !== 'readonly' && cap !== 'plan-artifact'
}

/**
 * 表示权限请求被 cancel 中断的 sentinel 错误。
 * 用于区分"用户主动拒绝"（产生"权限拒绝"工具结果）
 * 和"流程被取消"（不产生任何 tool_result，不污染 context 与持久化）。
 */
export class PermissionAbortedError extends Error {
  constructor() {
    super('permission request aborted by cancel')
    this.name = 'PermissionAbortedError'
  }
}

/**
 * 权限检查结果：
 * - { allowed: true }：可执行
 * - { allowed: false, reason }：用户主动拒绝或规则拒绝，需把"权限拒绝: {reason}"作为 tool_result 回传模型
 * - { aborted: true }：流程被 cancel 打断，调用方应跳过该工具的 tool_result 与 context 注入
 */
export interface PermissionCheckResult {
  allowed: boolean
  reason: string
  aborted?: boolean
}

/** 叠加在基础 PermissionManager 之前的运行时权限策略（阶段工作流等更窄的能力边界） */
export type ToolAuthorizationPolicy = (
  toolName: string,
  args: Record<string, unknown>
) => { allowed: boolean; reason: string }

type PermissionRequestEvent = Extract<AgentEvent, { type: 'permission_request' }>

/** 基础判定结果：单项与批量路径共用，ask 携带发起用户确认所需的展示信息 */
type BaseDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; riskLevel: RiskLevel; reason: string }

export interface PermissionCoordinatorDeps {
  /** 发射 permission_request 事件（由宿主接到 EventBus） */
  emit: (event: PermissionRequestEvent) => void
  /** 当前运行模式；权限判定时实时读取，模式切换后无需重新装配 */
  getMode: () => Mode
}

export class PermissionCoordinator {
  /** 权限决策引擎（可选；缺失时走安全降级） */
  private permissionManager: PermissionManager | null = null
  private toolAuthorizationPolicy: ToolAuthorizationPolicy | null = null

  /** 等待用户确认的权限请求（requestId → { resolve, reject } 回调） */
  private readonly pendingPermissions = new Map<
    string,
    { resolve: (granted: boolean) => void; reject: (err: Error) => void }
  >()

  constructor(private readonly deps: PermissionCoordinatorDeps) {}

  setPermissionManager(manager: PermissionManager): void {
    this.permissionManager = manager
  }

  setToolAuthorizationPolicy(policy: ToolAuthorizationPolicy | null): void {
    this.toolAuthorizationPolicy = policy
  }

  /**
   * 基础判定：overlay 拒绝优先 → 无 PermissionManager 时安全降级 →
   * PermissionManager 规则判定。单项与批量路径都必须经过这里，不得复制规则。
   *
   * 安全降级不变量：缺 Manager 时 switch_mode 不得恢复写入能力（fail closed），
   * plan 模式只放行只读与 plan-artifact 工具。
   */
  private evaluate(toolName: string, args: Record<string, unknown>): BaseDecision {
    const overlay = this.toolAuthorizationPolicy?.(toolName, args)
    if (overlay && !overlay.allowed) {
      return { decision: 'deny', reason: overlay.reason }
    }

    const mode = this.deps.getMode()

    if (!this.permissionManager) {
      if (
        toolName === 'switch_mode' &&
        !isSafeAutomaticModeTransition(mode, args.mode)
      ) {
        return {
          decision: 'deny',
          reason: '缺少 PermissionManager，不能执行会恢复写入能力的模式切换。'
        }
      }
      if (mode === 'plan' && isPlanModeBlocked(toolName)) {
        return {
          decision: 'deny',
          reason: `当前为 plan 模式，"${toolName}" 工具不可用。请切换到 default 或 auto 模式后再执行写入操作。`
        }
      }
      return { decision: 'allow' }
    }

    const result = this.permissionManager.check({ toolName, args }, mode)
    if (result.decision === 'allow') {
      return { decision: 'allow' }
    }
    if (result.decision === 'deny') {
      return { decision: 'deny', reason: result.reason }
    }
    return { decision: 'ask', riskLevel: result.riskLevel, reason: result.reason }
  }

  /** 单项权限检查入口（toolBatchExecutor 对非 bash 工具逐项调用） */
  async checkPermission(
    toolName: string,
    args: Record<string, unknown>,
    messageId: string,
    toolCallId?: string
  ): Promise<PermissionCheckResult> {
    const base = this.evaluate(toolName, args)
    if (base.decision === 'allow') {
      return { allowed: true, reason: '' }
    }
    if (base.decision === 'deny') {
      return { allowed: false, reason: base.reason }
    }

    // ask：发射 permission_request 事件，等待用户决策
    const requestId = randomUUID()
    const permissionResponse = this.waitForPermissionResponse(requestId)

    this.deps.emit({
      type: 'permission_request',
      messageId,
      requestId,
      toolName,
      args,
      riskLevel: base.riskLevel,
      reason: base.reason,
      // 内联放行：单工具场景把自身 toolCallId 作为唯一锚点传给渲染层
      ...(toolCallId ? { toolCallIds: [toolCallId] } : {})
    })

    try {
      const granted = await permissionResponse
      if (!granted) {
        return { allowed: false, reason: `用户拒绝了 "${toolName}" 工具的执行请求` }
      }
      return { allowed: true, reason: '' }
    } catch (err) {
      if (err instanceof PermissionAbortedError) {
        return { allowed: false, reason: '', aborted: true }
      }
      throw err
    }
  }

  /**
   * 批量权限检查入口（toolBatchExecutor 对连续 bash 组调用）。
   * 逐项走同一基础判定，需要 ask 的项合并成一个 permission_request 弹卡片。
   */
  async checkBatchPermission(
    items: Array<{ toolCallId: string; toolName: string; args: Record<string, unknown> }>,
    messageId: string
  ): Promise<Map<string, PermissionCheckResult>> {
    const results = new Map<string, PermissionCheckResult>()

    if (items.length === 0) {
      return results
    }

    const askItems: Array<{
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      riskLevel: RiskLevel
      reason: string
    }> = []

    for (const item of items) {
      const base = this.evaluate(item.toolName, item.args)
      if (base.decision === 'allow') {
        results.set(item.toolCallId, { allowed: true, reason: '' })
      } else if (base.decision === 'deny') {
        results.set(item.toolCallId, { allowed: false, reason: base.reason })
      } else {
        askItems.push({
          toolCallId: item.toolCallId,
          toolName: item.toolName,
          args: item.args,
          riskLevel: base.riskLevel,
          reason: base.reason
        })
      }
    }

    if (askItems.length === 0) {
      return results
    }

    const requestId = randomUUID()
    const permissionResponse = this.waitForPermissionResponse(requestId)

    // 合并展示信息：命令列表、最高风险等级、去重原因说明
    const commands: string[] = []
    let maxRiskLevel: RiskLevel = 'low'
    const riskLevelsWeight = { low: 1, medium: 2, high: 3 }
    const reasons: string[] = []

    for (const item of askItems) {
      const cmd = typeof item.args.command === 'string' ? item.args.command : JSON.stringify(item.args)
      commands.push(cmd)
      if (riskLevelsWeight[item.riskLevel] > riskLevelsWeight[maxRiskLevel]) {
        maxRiskLevel = item.riskLevel
      }
      reasons.push(item.reason)
    }

    const combinedReason = Array.from(new Set(reasons)).join('; ')

    this.deps.emit({
      type: 'permission_request',
      messageId,
      requestId,
      toolName: 'bash', // 批量路径只收 bash 组，以主类型描述
      args: askItems[0].args, // 兼容旧字段
      riskLevel: maxRiskLevel,
      reason: combinedReason,
      commands,
      // 内联放行：携带本批命令对应的 toolCallId 列表，
      // 渲染层据此把放行卡片直接挂到消息流中对应命令卡片上（锚点取末尾一张）。
      toolCallIds: askItems.map(item => item.toolCallId)
    })

    try {
      const granted = await permissionResponse
      for (const item of askItems) {
        if (!granted) {
          results.set(item.toolCallId, { allowed: false, reason: `用户拒绝了 "${item.toolName}" 工具的执行请求` })
        } else {
          results.set(item.toolCallId, { allowed: true, reason: '' })
        }
      }
      return results
    } catch (err) {
      if (err instanceof PermissionAbortedError) {
        for (const item of askItems) {
          results.set(item.toolCallId, { allowed: false, reason: '', aborted: true })
        }
        return results
      }
      throw err
    }
  }

  /** 等待用户对权限请求的响应；abortPending 时会以 PermissionAbortedError reject */
  private waitForPermissionResponse(requestId: string): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.pendingPermissions.set(requestId, { resolve, reject })
    })
  }

  /** 是否仍持有指定权限请求的 resolver */
  hasPendingPermission(requestId: string): boolean {
    return this.pendingPermissions.has(requestId)
  }

  /**
   * 回应权限请求（由 IPC 经宿主代理调用）。
   * 未知 / 已消费的 requestId 是无操作——过期回应不得串到其他等待中的请求。
   */
  respondPermission(requestId: string, granted: boolean): void {
    const entry = this.pendingPermissions.get(requestId)
    if (entry) {
      this.pendingPermissions.delete(requestId)
      entry.resolve(granted)
    }
  }

  /**
   * 中止所有等待中的权限请求（cancel / dispose 共用）。
   * 用 PermissionAbortedError 而非 resolve(false)，
   * 使 checkPermission 不把取消当成"用户拒绝"生成权限拒绝 tool_result。
   */
  abortPending(): void {
    for (const [id, entry] of this.pendingPermissions) {
      entry.reject(new PermissionAbortedError())
      this.pendingPermissions.delete(id)
    }
  }
}
