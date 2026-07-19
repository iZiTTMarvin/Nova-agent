import type { EventBus } from '../../../runtime/agent'

/** 验证权限弹窗等待超时（超时视为拒绝） */
export const VERIFICATION_PERMISSION_TIMEOUT_MS = 30_000

export interface PendingVerificationPermissionEntry {
  runId: string
  messageId: string
  resolve: (granted: boolean) => void
  timeoutHandle: NodeJS.Timeout
  eventBus: EventBus
}

/** 等待用户对验证权限请求的响应（verificationRequestId → 挂起状态） */
export const pendingVerificationPermissions = new Map<string, PendingVerificationPermissionEntry>()

/** 结算并清理一条挂起的验证权限请求 */
export function clearVerificationPermissionRequest(requestId: string, granted: boolean): void {
  const entry = pendingVerificationPermissions.get(requestId)
  if (!entry) return

  clearTimeout(entry.timeoutHandle)
  pendingVerificationPermissions.delete(requestId)
  entry.resolve(granted)
  entry.eventBus.emit({
    type: 'verification_permission_cleared',
    messageId: entry.messageId,
    requestId
  })
}

/** 清理挂起的验证权限（可按 runId 过滤）；一律按拒绝结算 */
export function clearPendingVerificationPermissions(runId?: string): void {
  for (const [requestId, entry] of pendingVerificationPermissions) {
    if (!runId || entry.runId === runId) {
      clearVerificationPermissionRequest(requestId, false)
    }
  }
}

export interface AwaitVerificationPermissionArgs {
  messageId: string
  runId: string
  command: string
  eventBus: EventBus
}

/**
 * 向 renderer 发起验证权限请求并等待用户响应。
 * 超时或显式拒绝均 resolve(false)。
 */
export function awaitVerificationPermission(args: AwaitVerificationPermissionArgs): Promise<boolean> {
  const { messageId, runId, command, eventBus } = args
  const requestId = `vp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

  return new Promise<boolean>((resolve) => {
    const timeoutHandle = setTimeout(() => {
      clearVerificationPermissionRequest(requestId, false)
    }, VERIFICATION_PERMISSION_TIMEOUT_MS)

    pendingVerificationPermissions.set(requestId, {
      runId,
      messageId,
      resolve,
      timeoutHandle,
      eventBus
    })

    eventBus.emit({
      type: 'verification_permission_request',
      messageId,
      requestId,
      command
    })
  })
}
