/**
 * PermissionManager — 权限决策引擎。
 *
 * 每次查询显式携带 turn 级权限快照；实例只持有可热更新的持久化规则。
 * 静态命令分类器无法证明任意 Shell 命令安全，未命中仅表示没有命中已知高风险模式。
 */
import type { Mode } from '../../shared/session/types'
import { getToolPermissionDescriptor } from '../../shared/permissions/toolEffects'
import type { SessionPathGrant } from '../../shared/permissions/types'
import type {
  PermissionQuery,
  PermissionRequestMeta,
  PermissionResult,
  RiskLevel
} from './types'
import { resolvePermissionEffects, type EffectResolution } from './effectResolver'
import { getRiskDescriptionFromEffects, resolveModeBaseline } from './permissionBaseline'
import { isCommandFullyWhitelisted } from './commandSegments'
import { matchPermission, type MatchInput } from './PermissionMatcher'
import type { PermissionRule } from './PermissionRule'
import { isInteractiveEntryCommand } from '../tools/bash'
import { resolveToolArg } from '../tools/toolArgResolver'

/** 进入只读 Plan 或保持当前模式不会扩大副作用权限，可以由 Agent 自动完成。 */
export function isSafeAutomaticModeTransition(
  currentMode: Mode,
  targetMode: unknown
): boolean {
  return targetMode === currentMode || (currentMode === 'default' && targetMode === 'plan')
}

const sessionWhitelists = new Map<string, Set<string>>()

export function grantSessionPermission(sessionId: string, commandPrefix: string): void {
  let whitelist = sessionWhitelists.get(sessionId)
  if (!whitelist) {
    whitelist = new Set()
    sessionWhitelists.set(sessionId, whitelist)
  }
  whitelist.add(commandPrefix)
}

export function clearSessionWhitelist(sessionId: string): void {
  sessionWhitelists.delete(sessionId)
}

export class PermissionManager {
  private rules: PermissionRule[] = []

  setRules(rules: PermissionRule[]): void {
    this.rules = rules
  }

  check(query: PermissionQuery, mode: Mode): PermissionResult {
    if (query.toolName === 'switch_mode') {
      return this.checkSwitchMode(query, mode)
    }

    const command = this.extractCommand(query)
    if (query.toolName === 'bash' && isInteractiveEntryCommand(command)) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: '该命令会占用前台交互，Nova 将无法继续工作；请改用 shell_session 或后台执行'
      }
    }

    const resolution = resolvePermissionEffects(query)
    const hard = this.resolveHardBoundary(query, mode, resolution)
    if (hard) return hard

    const ruleQuery = this.ruleQuery(query, command)
    const denyFromRules = this.matchPersistentDecision(ruleQuery, 'deny')
    if (denyFromRules) return denyFromRules

    if (
      resolution.ok &&
      resolution.riskLevel === 'high' &&
      query.permissionMode !== 'full_access'
    ) {
      return this.buildAskResult(
        resolution.reasons[0] || '高风险操作需要确认',
        this.buildRequestMeta(query, resolution),
        'high'
      )
    }

    if (query.toolName === 'bash' && command) {
      const whitelist = sessionWhitelists.get(query.sessionId)
      if (whitelist && isCommandFullyWhitelisted(command, whitelist)) {
        return { decision: 'allow', reason: '本会话临时白名单允许执行该命令' }
      }
    }

    const allowFromRules = this.matchPersistentDecision(ruleQuery, 'allow')
    if (allowFromRules) {
      return resolution.ok
        ? { ...allowFromRules, ...this.executionGrants(resolution) }
        : allowFromRules
    }

    if (!resolution.ok) {
      return this.failClosed(query, resolution.reason)
    }

    const baseline = resolveModeBaseline({
      permissionMode: query.permissionMode,
      effects: resolution.effects,
      riskLevel: resolution.riskLevel,
      hasExternalPath: resolution.externalPaths.length > 0
    })
    const reason =
      resolution.reasons[0] ||
      getRiskDescriptionFromEffects(
        resolution.effects,
        resolution.riskLevel,
        resolution.externalPaths.length > 0
      )
    if (baseline === 'ask') {
      return this.buildAskResult(reason, this.buildRequestMeta(query, resolution), resolution.riskLevel)
    }
    return {
      decision: 'allow',
      reason,
      ...this.executionGrants(resolution)
    }
  }

  private checkSwitchMode(query: PermissionQuery, mode: Mode): PermissionResult {
    const denyFromRules = this.matchPersistentDecision(query, 'deny')
    if (denyFromRules) return denyFromRules
    if (isSafeAutomaticModeTransition(mode, query.args.mode)) {
      return {
        decision: 'allow',
        reason: '进入只读 Plan 模式不会扩大副作用权限'
      }
    }
    return {
      decision: 'ask',
      riskLevel: 'low',
      reason: '退出 Plan 将恢复写入能力，需要用户确认',
      request: {}
    }
  }

  private resolveHardBoundary(
    query: PermissionQuery,
    mode: Mode,
    resolution: EffectResolution
  ): PermissionResult | null {
    if (!resolution.ok && resolution.kind === 'unknown_action') {
      return { decision: 'deny', riskLevel: 'high', reason: resolution.reason }
    }

    const ceiling = this.resolveCapabilityCeiling(query, resolution)
    if (ceiling) return ceiling

    if (mode !== 'plan') return null

    if (!resolution.ok) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: `plan 模式下禁止使用无法解析副作用的工具 "${query.toolName}"`
      }
    }

    const descriptor = getToolPermissionDescriptor(query.toolName)
    if (resolution.effects.includes('orchestration')) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: this.planDenyReason(query.toolName)
      }
    }
    if (resolution.effects.includes('shell.execute')) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason:
          query.toolName === 'shell_session'
            ? 'plan 模式下禁止向终端会话写入输入（read/interrupt/stop 可用）'
            : 'plan 模式下禁止执行任何 shell 命令'
      }
    }
    if (resolution.effects.includes('filesystem.write') && descriptor?.planArtifact !== true) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: this.planDenyReason(query.toolName)
      }
    }
    return null
  }

  /**
   * 只读能力上限：排除写文件、执行 Shell、控制进程与编排派生。
   * 编排也在排除之列，保持与只读子代理此前借用 plan 边界时一致的收窄面。
   */
  private resolveCapabilityCeiling(
    query: PermissionQuery,
    resolution: EffectResolution
  ): PermissionResult | null {
    if (query.capabilityCeiling !== 'read_only') return null
    if (!resolution.ok) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: `只读上限下禁止使用无法解析副作用的工具 "${query.toolName}"`
      }
    }
    const effects = resolution.effects
    if (
      effects.includes('filesystem.write') ||
      effects.includes('shell.execute') ||
      effects.includes('process.control') ||
      effects.includes('orchestration')
    ) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: `只读上限下禁止 "${query.toolName}" 产生的副作用（写文件 / 执行 Shell / 控制进程 / 编排）`
      }
    }
    return null
  }

  private failClosed(query: PermissionQuery, reason: string): PermissionResult {
    if (query.permissionMode === 'full_access') {
      return { decision: 'allow', reason }
    }
    return {
      decision: 'ask',
      riskLevel: 'low',
      reason,
      request: {}
    }
  }

  private extractCommand(query: PermissionQuery): string {
    if (query.toolName === 'bash') {
      return (resolveToolArg(query.args, 'command') ?? '').trim()
    }
    if (query.toolName === 'shell_session' && query.args.action === 'write') {
      return typeof query.args.input === 'string' ? query.args.input : ''
    }
    return ''
  }

  private ruleQuery(query: PermissionQuery, command: string): PermissionQuery {
    if (!command || query.args.command === command) return query
    return { ...query, args: { ...query.args, command } }
  }

  private buildRequestMeta(
    query: PermissionQuery,
    resolution: Extract<EffectResolution, { ok: true }>
  ): PermissionRequestMeta {
    const command = this.extractCommand(query)
    return {
      ...(command ? { command } : {}),
      ...(resolution.reasons[0] ? { riskReason: resolution.reasons[0] } : {}),
      ...(resolution.externalPaths.length > 0 ? { externalPaths: resolution.externalPaths } : {}),
      ...(resolution.pathAccess ? { pathAccess: resolution.pathAccess } : {})
    }
  }

  private executionGrants(
    resolution: Extract<EffectResolution, { ok: true }>
  ): { executionPathGrants?: SessionPathGrant[] } {
    if (resolution.externalPaths.length === 0 || !resolution.pathAccess) return {}
    return {
      executionPathGrants: resolution.externalPaths.map(canonicalRoot => ({
        canonicalRoot,
        access: resolution.pathAccess!,
        match: 'exact' as const,
        origin: 'user' as const
      }))
    }
  }

  private matchPersistentDecision(
    query: PermissionQuery,
    target: 'allow' | 'deny'
  ): PermissionResult | null {
    if (this.rules.length === 0) return null
    if (
      query.toolName === 'shell_session' &&
      query.args.action !== 'write'
    ) {
      return null
    }

    const input: MatchInput = {
      toolName: query.toolName,
      args: query.args,
      currentProjectPath: query.workspaceRoot || null
    }
    const match = matchPermission(this.rules, input)
    if (match.decision !== target) return null

    return target === 'deny'
      ? { decision: 'deny', riskLevel: 'high', reason: match.reason }
      : { decision: 'allow', reason: match.reason }
  }

  private planDenyReason(toolName: string): string {
    return `plan 模式下禁止使用 "${toolName}" 工具，请切换到默认模式或编排模式`
  }

  private buildAskResult(
    reason: string,
    request: PermissionRequestMeta,
    riskLevel: RiskLevel
  ): PermissionResult {
    return { decision: 'ask', reason, riskLevel, request }
  }
}
