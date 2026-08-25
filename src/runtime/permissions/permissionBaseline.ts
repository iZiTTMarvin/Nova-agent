import type { PermissionDecision, ToolEffect } from '../../shared/permissions/types'
import type { PermissionMode } from '../../shared/session/types'
import type { RiskLevel } from './types'

function stricter(left: PermissionDecision, right: PermissionDecision): PermissionDecision {
  if (left === 'deny' || right === 'deny') return 'deny'
  if (left === 'ask' || right === 'ask') return 'ask'
  return 'allow'
}

function decisionForEffect(
  effect: ToolEffect,
  permissionMode: PermissionMode,
  riskLevel: RiskLevel,
  hasExternalPath: boolean
): PermissionDecision {
  switch (effect) {
    case 'filesystem.read':
    case 'filesystem.write':
      if (!hasExternalPath) return 'allow'
      return permissionMode === 'full_access' ? 'allow' : 'ask'
    case 'shell.execute':
      if (permissionMode === 'full_access') return 'allow'
      if (permissionMode === 'request_approval') return 'ask'
      return riskLevel === 'high' ? 'ask' : 'allow'
    case 'process.control':
    case 'session.write':
    case 'orchestration':
      return 'allow'
    case 'network.read':
      return permissionMode === 'request_approval' ? 'ask' : 'allow'
    case 'network.write':
      return permissionMode === 'full_access' ? 'allow' : 'ask'
    case 'mode.transition':
      return 'ask'
  }
}

/** Permission Mode baseline：多 effect 取最严结果。空 effects 为已知无授权副作用，allow。 */
export function resolveModeBaseline(input: {
  permissionMode: PermissionMode
  effects: readonly ToolEffect[]
  riskLevel: RiskLevel
  hasExternalPath: boolean
}): PermissionDecision {
  if (input.effects.length === 0) return 'allow'
  let current: PermissionDecision = 'allow'
  for (const effect of input.effects) {
    current = stricter(
      current,
      decisionForEffect(effect, input.permissionMode, input.riskLevel, input.hasExternalPath)
    )
  }
  return current
}

export function getRiskDescriptionFromEffects(
  effects: readonly ToolEffect[],
  riskLevel: RiskLevel,
  hasExternalPath: boolean
): string {
  if (hasExternalPath && effects.includes('filesystem.write')) {
    return riskLevel === 'high' ? '高风险的工作区外写入' : '需要访问工作区外文件'
  }
  if (hasExternalPath && effects.includes('filesystem.read')) {
    return '需要访问工作区外文件'
  }
  if (effects.includes('shell.execute')) {
    return riskLevel === 'high' ? '高风险命令' : 'Shell 命令'
  }
  if (effects.includes('network.write')) return '网络写入'
  if (effects.includes('network.read')) return '网络读取'
  if (effects.includes('filesystem.write')) {
    return riskLevel === 'high' ? '高风险写入' : '写入操作'
  }
  if (effects.includes('mode.transition')) return '切换运行模式'
  if (effects.includes('orchestration')) return '编排操作'
  if (effects.includes('process.control')) return '控制现有终端进程'
  if (effects.includes('session.write')) return '更新会话状态'
  return '只读操作'
}
