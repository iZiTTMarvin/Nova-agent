/**
 * PermissionManager — 权限决策引擎
 * 根据当前模式（plan/default/compose）+ 权限策略（ask/auto）和工具类型做出权限决策
 * bash 工具额外检查命令风险等级
 *
 * 在 mode-based 决策之前先调用 PermissionMatcher 匹配持久化规则：
 * - 命中 deny → 直接拒绝（优先级最高，覆盖 auto 语义 allow）
 * - 命中 allow → 直接放行
 * - 命中 ask 或无匹配 → 走现有 mode + policy + 黑名单逻辑
 */
import type { Mode, PermissionPolicy } from '../../shared/session/types'
import type { PermissionQuery, PermissionResult } from './types'
import {
  getBaseDecision,
  assessCommandRisk,
  getRiskDescription,
  isAutoPermissionSemantics
} from './rules'
import { matchPermission, type MatchInput } from './PermissionMatcher'
import type { PermissionRule } from './PermissionRule'

/** 会话级临时内存白名单：Map<sessionId, Set<commandPrefix>> */
const sessionWhitelists = new Map<string, Set<string>>()

/** 授权临时白名单（外部调用） */
export function grantSessionPermission(sessionId: string, commandPrefix: string): void {
  let whitelist = sessionWhitelists.get(sessionId)
  if (!whitelist) {
    whitelist = new Set()
    sessionWhitelists.set(sessionId, whitelist)
  }
  whitelist.add(commandPrefix)
}

/** 清理指定会话的临时白名单 */
export function clearSessionWhitelist(sessionId: string): void {
  sessionWhitelists.delete(sessionId)
}

export class PermissionManager {
  /** 持久化规则集合（由外部注入，运行时可热更新） */
  private rules: PermissionRule[] = []
  /** 当前项目路径（用于匹配项目级规则） */
  private currentProjectPath: string | null = null
  /** 当前会话 ID */
  private sessionId: string | null = null
  /** 工具批准策略（仅约束 default；compose 固定 auto 语义） */
  private permissionPolicy: PermissionPolicy = 'ask'

  /** 注入持久化规则集合（供 agentHandler 在加载/变更时调用） */
  setRules(rules: PermissionRule[]): void {
    this.rules = rules
  }

  /** 设置当前项目路径（供项目级规则匹配） */
  setCurrentProjectPath(path: string | null): void {
    this.currentProjectPath = path
  }

  /** 设置当前会话 ID（供会话白名单过滤） */
  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId
  }

  /** 设置工具批准策略（来自 ~/.nova/settings.json） */
  setPermissionPolicy(policy: PermissionPolicy): void {
    this.permissionPolicy = policy
  }

  getPermissionPolicy(): PermissionPolicy {
    return this.permissionPolicy
  }

  /**
   * 查询指定工具+模式下的权限决策
   *
   * 决策顺序：
   * 1. 优先比对会话级临时白名单（内存态）
   * 2. 先匹配持久化规则：deny 直接拒、allow 直接放行。
   * 3. 命中 ask 或无匹配 → 走 mode + policy + 黑名单逻辑。
   */
  check(query: PermissionQuery, mode: Mode): PermissionResult {
    const { toolName, args } = query

    if (toolName === 'bash' && this.sessionId) {
      const whitelist = sessionWhitelists.get(this.sessionId)
      if (whitelist) {
        const command = typeof args.command === 'string' ? args.command.trim() : ''
        const firstToken = command.split(/\s+/)[0]
        if (firstToken && whitelist.has(firstToken)) {
          return {
            decision: 'allow',
            riskLevel: 'low',
            reason: `本会话临时白名单允许执行前缀为 "${firstToken}" 的命令`
          }
        }
      }
    }

    if (this.rules.length > 0) {
      const input: MatchInput = {
        toolName,
        args,
        currentProjectPath: this.currentProjectPath
      }
      const match = matchPermission(this.rules, input)
      if (match.decision === 'deny') {
        return {
          decision: 'deny',
          riskLevel: 'high',
          reason: match.reason
        }
      }
      if (match.decision === 'allow') {
        return {
          decision: 'allow',
          riskLevel: 'low',
          reason: match.reason
        }
      }
    }

    const baseDecision = getBaseDecision(mode, toolName, this.permissionPolicy)

    if (toolName === 'bash') {
      return this.checkBash(args.command as string, mode, baseDecision)
    }

    return {
      decision: baseDecision,
      riskLevel: baseDecision === 'deny' ? 'high' : 'low',
      reason: this.buildReason(toolName, mode, baseDecision)
    }
  }

  private checkBash(
    command: string,
    mode: Mode,
    baseDecision: 'allow' | 'ask' | 'deny'
  ): PermissionResult {
    if (mode === 'plan') {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: 'plan 模式下禁止执行任何 shell 命令'
      }
    }

    const { riskLevel, isDangerous, reason } = assessCommandRisk(command || '')

    // auto 语义下危险命令强制拒绝
    if (isAutoPermissionSemantics(mode, this.permissionPolicy) && isDangerous) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: `自动执行策略下禁止危险命令: ${reason}`
      }
    }

    return {
      decision: baseDecision,
      riskLevel,
      reason: isDangerous ? reason : getRiskDescription('bash', riskLevel)
    }
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
}
