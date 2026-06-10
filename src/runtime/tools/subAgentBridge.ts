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
 */
export class SubAgentPermissionBridge {
  private bindings = new Map<string, PermissionBinding>()

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

  /** 清空全部绑定（测试 / 全局 cancel 用） */
  clear(): void {
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
