/**
 * PermissionManager — 权限决策引擎。
 *
 * 每次查询显式携带 turn 级权限快照；实例只持有可热更新的持久化规则。
 * 静态命令分类器无法证明任意 Shell 命令安全，未命中仅表示没有命中已知高风险模式。
 */
import type { Mode } from '../../shared/session/types'
import type {
  PermissionQuery,
  PermissionRequestMeta,
  PermissionResult,
  RiskLevel
} from './types'
import { assessCommandRisk, getBaseDecision, getRiskDescription } from './rules'
import { isCommandFullyWhitelisted } from './commandSegments'
import { matchPermission, type MatchInput } from './PermissionMatcher'
import type { PermissionRule } from './PermissionRule'
import { isInteractiveEntryCommand } from '../tools/bash'

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
    const { toolName, args } = query

    if (toolName === 'switch_mode') {
      const denyFromRules = this.matchPersistentDecision(query, 'deny')
      if (denyFromRules) return denyFromRules

      if (isSafeAutomaticModeTransition(mode, args.mode)) {
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

    if (toolName === 'bash') {
      return this.checkBash(query, mode)
    }

    if (toolName === 'shell_session') {
      return this.checkShellSession(query, mode)
    }

    const baseDecision = getBaseDecision(mode, toolName, query.permissionMode)
    if (baseDecision === 'deny') {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: this.buildReason(toolName, mode, baseDecision)
      }
    }

    const denyFromRules = this.matchPersistentDecision(query, 'deny')
    if (denyFromRules) return denyFromRules

    const allowFromRules = this.matchPersistentDecision(query, 'allow')
    if (allowFromRules) return allowFromRules

    const reason = this.buildReason(toolName, mode, baseDecision)
    return baseDecision === 'ask'
      ? { decision: 'ask', riskLevel: 'low', reason, request: {} }
      : { decision: 'allow', reason }
  }

  private checkBash(query: PermissionQuery, mode: Mode): PermissionResult {
    const command = typeof query.args.command === 'string' ? query.args.command.trim() : ''

    if (mode === 'plan') {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: 'plan 模式下禁止执行任何 shell 命令'
      }
    }

    if (isInteractiveEntryCommand(command)) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: '该命令会占用前台交互，Nova 将无法继续工作；请改用 shell_session 或后台执行'
      }
    }

    const denyFromRules = this.matchPersistentDecision(query, 'deny')
    if (denyFromRules) return denyFromRules

    const risk = assessCommandRisk(command)
    if (risk.isDangerous && query.permissionMode !== 'full_access') {
      return this.buildAskResult(risk.reason, { command, riskReason: risk.reason }, 'high')
    }

    const whitelist = sessionWhitelists.get(query.sessionId)
    if (whitelist && isCommandFullyWhitelisted(command, whitelist)) {
      return {
        decision: 'allow',
        reason: '本会话临时白名单允许执行该命令'
      }
    }

    const allowFromRules = this.matchPersistentDecision(query, 'allow')
    if (allowFromRules) return allowFromRules

    const decision = getBaseDecision(mode, 'bash', query.permissionMode)
    const reason = risk.isDangerous ? risk.reason : getRiskDescription('bash', risk.riskLevel)
    return decision === 'ask'
      ? this.buildAskResult(reason, { command, riskReason: risk.isDangerous ? risk.reason : undefined }, risk.riskLevel)
      : { decision: 'allow', reason }
  }

  private checkShellSession(query: PermissionQuery, mode: Mode): PermissionResult {
    const action = query.args.action
    if (
      action !== 'read' &&
      action !== 'write' &&
      action !== 'interrupt' &&
      action !== 'stop'
    ) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: '未知的 shell_session action'
      }
    }

    if (mode === 'plan') {
      if (action === 'write') {
        return {
          decision: 'deny',
          riskLevel: 'high',
          reason: 'plan 模式下禁止向终端会话写入输入（read/interrupt/stop 可用）'
        }
      }
    }

    if (action !== 'write') {
      return {
        decision: 'allow',
        reason: action === 'read' ? '读取终端会话输出' : '控制现有终端进程'
      }
    }

    const input = typeof query.args.input === 'string' ? query.args.input : ''
    const commandQuery: PermissionQuery = {
      ...query,
      args: { ...query.args, command: input }
    }
    const denyFromRules = this.matchPersistentDecision(commandQuery, 'deny')
    if (denyFromRules) return denyFromRules

    const risk = assessCommandRisk(input)
    if (risk.isDangerous && query.permissionMode !== 'full_access') {
      return this.buildAskResult(risk.reason, { command: input, riskReason: risk.reason }, 'high')
    }

    const allowFromRules = this.matchPersistentDecision(commandQuery, 'allow')
    if (allowFromRules) return allowFromRules

    const decision = getBaseDecision(mode, 'shell_session', query.permissionMode)
    const reason = risk.isDangerous ? risk.reason : '向运行中的终端进程写入输入'
    return decision === 'ask'
      ? this.buildAskResult(reason, { command: input, riskReason: risk.isDangerous ? risk.reason : undefined }, risk.riskLevel)
      : { decision: 'allow', reason }
  }

  private matchPersistentDecision(
    query: PermissionQuery,
    target: 'allow' | 'deny'
  ): PermissionResult | null {
    if (this.rules.length === 0) return null

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

  private buildReason(
    toolName: string,
    mode: Mode,
    decision: 'allow' | 'ask' | 'deny'
  ): string {
    if (decision === 'deny') {
      if (mode === 'plan') {
        return `plan 模式下禁止使用 "${toolName}" 工具，请切换到默认模式或编排模式`
      }
      return `权限策略拒绝执行 "${toolName}"`
    }
    return getRiskDescription(toolName, 'low')
  }

  private buildAskResult(
    reason: string,
    request: PermissionRequestMeta,
    riskLevel: RiskLevel
  ): PermissionResult {
    return { decision: 'ask', reason, riskLevel, request }
  }
}
