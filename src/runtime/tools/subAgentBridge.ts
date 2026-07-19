/**
 * subAgentBridge — 子代理权限请求与父 UI 的桥接
 * 子 AgentLoop 实例独立，但 permission_request 需转发到父 EventBus 供用户审批
 */
import type { AgentLoop } from '../agent/AgentLoop'

/** 子代理权限 requestId 前缀，与父 agent 的 uuid 命名空间隔离 */
export const SUB_PERMISSION_PREFIX = 'sub:'

interface PermissionBinding {
  loop: AgentLoop
  /** 子循环内部使用的原始 requestId */
  rawRequestId: string
}

/**
 * 子代理权限桥接器（实例级，避免多 session 共享全局 Map）
 *
 * 持有两套独立的子代理状态：
 * - bindings：等待权限审批的请求（permission_request 发出 → 用户决策到达）
 * - activeLoops：正在运行的子 AgentLoop（用于父 cancel 时联动终止）
 *
 * 二者生命周期不同：只读 explore 子代理从不发 permission_request（bindings 一直空），
 * 但仍需被 cancel 联动，所以 activeLoops 必须在 subLoop 创建时主动注册，
 * 不能依赖 bindings。
 */
export class SubAgentPermissionBridge {
  private bindings = new Map<string, PermissionBinding>()
  /** 活跃子 AgentLoop 集合（register 注销 / cancelAll 终止） */
  private activeLoops = new Set<AgentLoop>()

  /**
   * 注册一个活跃子 AgentLoop。
   *
   * 必须在 subLoop.sendMessage 之前调用，否则 cancel 来时子代理已在跑但未注册。
   * taskTool 创建 subLoop 后立即注册，finally 块注销。
   */
  register(loop: AgentLoop): void {
    this.activeLoops.add(loop)
  }

  /**
   * 注销子 AgentLoop（正常结束 / 异常 / 取消后调用）。
   * 重复注销是安全的（Set.delete 对不存在元素无操作）。
   */
  unregister(loop: AgentLoop): void {
    this.activeLoops.delete(loop)
  }

  /**
   * 联动终止所有活跃子 AgentLoop（父 cancel 时调用）。
   *
   * 遍历 activeLoops 调 loop.cancel()。cancel() 内部有 state==='running' 守卫
   * （AgentLoop.ts:946），已结束的子代理会被安全跳过，不会报错。
   * 取消后清空集合——被 cancel 的 loop 不再需要被追踪。
   */
  cancelAll(): void {
    for (const loop of this.activeLoops) {
      loop.cancel()
    }
    this.activeLoops.clear()
  }

  /**
   * 绑定子循环并返回转发给父 UI 的 requestId（带 sub: 前缀）
   * @param requestId 子循环内部的 requestId
   * @param loop 子 AgentLoop 实例
   */
  bind(requestId: string, loop: AgentLoop): string {
    const bridgedId = `${SUB_PERMISSION_PREFIX}${requestId}`
    this.bindings.set(bridgedId, { loop, rawRequestId: requestId })
    return bridgedId
  }

  /** 是否仍持有指定桥接权限请求的子循环 resolver。 */
  hasBinding(bridgedRequestId: string): boolean {
    return this.bindings.has(bridgedRequestId)
  }

  /**
   * 尝试将用户决策路由到子 AgentLoop（仅处理 sub: 前缀的 requestId）
   * @returns true 表示已交给子循环处理
   */
  resolve(bridgedRequestId: string, granted: boolean): boolean {
    if (!bridgedRequestId.startsWith(SUB_PERMISSION_PREFIX)) {
      return false
    }
    const entry = this.bindings.get(bridgedRequestId)
    if (!entry) return false
    entry.loop.respondPermission(entry.rawRequestId, granted)
    this.bindings.delete(bridgedRequestId)
    return true
  }

  /** 清除指定子循环的全部挂起绑定（task 结束 / cancel 时调用） */
  clearForLoop(loop: AgentLoop): void {
    for (const [id, entry] of this.bindings) {
      if (entry.loop === loop) this.bindings.delete(id)
    }
  }

  /** 清空权限绑定（测试 / cancel 时清除挂起权限弹窗）。不清 activeLoops —— 二者生命周期不同。 */
  clear(): void {
    this.bindings.clear()
  }

  /** 清空一切（activeLoops + bindings）。仅测试用，CANCEL 路径走 cancelAll() + clear()。 */
  clearAll(): void {
    this.activeLoops.clear()
    this.bindings.clear()
  }
}

/** 默认单例（agentHandler / 未注入自定义 bridge 的 task 工具使用） */
export const defaultSubAgentPermissionBridge = new SubAgentPermissionBridge()

/** @deprecated 请优先使用 SubAgentPermissionBridge 实例；保留以兼容测试导入 */
export function bindSubAgentPermission(requestId: string, loop: AgentLoop): string {
  return defaultSubAgentPermissionBridge.bind(requestId, loop)
}

export function resolveSubAgentPermission(requestId: string, granted: boolean): boolean {
  return defaultSubAgentPermissionBridge.resolve(requestId, granted)
}

export function clearSubAgentPermissionBindings(): void {
  defaultSubAgentPermissionBridge.clear()
}
