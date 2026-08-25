/**
 * PermissionManager — 权限决策引擎
 * 根据当前模式（plan/default/compose）+ 权限策略（ask/auto）和工具类型做出权限决策
 * bash 工具额外检查命令风险等级
 *
 * bash 不变量：assessCommandRisk 对整段命令永远最先执行；
 * 白名单与 allow 规则只拥有「把 ask 降为 allow」的权力，永远无权豁免高危命令。
 * shell_session 按 action 决策：write 是唯一产生副作用的动作。
 */
import type { Mode, PermissionMode } from '../../shared/session/types'
import type { PermissionQuery, PermissionResult } from './types'
import {
  getBaseDecision,
  assessCommandRisk,
  getRiskDescription,
  isAutoPermissionSemantics
} from './rules'
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
  /** 会话权限模式；compose 当前仍保持既有 auto 语义。 */
  private permissionMode: PermissionMode = 'request_approval'

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

  /** 设置当前 turn 捕获的会话权限模式。 */
  setPermissionMode(permissionMode: PermissionMode): void {
    this.permissionMode = permissionMode
  }

  getPermissionMode(): PermissionMode {
    return this.permissionMode
  }

  /**
   * 查询指定工具+模式下的权限决策
   *
   * bash 决策顺序：
   * 1. assessCommandRisk（高危命令不可被白名单/allow 规则豁免）
   * 2. 交互式入口（REPL / 交互 shell，同样不可被白名单/allow 豁免）
   * 3. 持久化 deny 规则
   * 4. 会话白名单（每一段首 token 均命中）
   * 5. 持久化 allow 规则
   * 6. mode + policy 基线决策
   */
  check(query: PermissionQuery, mode: Mode): PermissionResult {
    const { toolName, args } = query

    if (toolName === 'switch_mode') {
      if (isSafeAutomaticModeTransition(mode, args.mode)) {
        return {
          decision: 'allow',
          riskLevel: 'low',
          reason: '进入只读 Plan 模式不会扩大副作用权限'
        }
      }
      return {
        decision: 'ask',
        riskLevel: 'low',
        reason: '退出 Plan 将恢复写入能力，需要用户确认'
      }
    }

    if (toolName === 'bash') {
      const command = typeof args.command === 'string' ? args.command.trim() : ''
      const dangerous = this.resolveDangerousBash(command, mode)
      if (dangerous) return dangerous

      const interactive = this.resolveInteractiveEntry(command, mode)
      if (interactive) return interactive

      const denyFromRules = this.matchPersistentDecision(toolName, args, 'deny')
      if (denyFromRules) return denyFromRules

      if (this.sessionId) {
        const whitelist = sessionWhitelists.get(this.sessionId)
        if (whitelist && isCommandFullyWhitelisted(command, whitelist)) {
          return {
            decision: 'allow',
            riskLevel: 'low',
            reason: '本会话临时白名单允许执行该命令'
          }
        }
      }

      const allowFromRules = this.matchPersistentDecision(toolName, args, 'allow')
      if (allowFromRules) return allowFromRules

      return this.checkBashSafe(command, mode)
    }

    if (toolName === 'shell_session') {
      return this.checkShellSession(args, mode)
    }

    const denyFromRules = this.matchPersistentDecision(toolName, args, 'deny')
    if (denyFromRules) return denyFromRules

    const allowFromRules = this.matchPersistentDecision(toolName, args, 'allow')
    if (allowFromRules) return allowFromRules

    const baseDecision = getBaseDecision(mode, toolName, this.permissionMode)
    return {
      decision: baseDecision,
      riskLevel: baseDecision === 'deny' ? 'high' : 'low',
      reason: this.buildReason(toolName, mode, baseDecision)
    }
  }

  /** 高危 bash：auto 语义 deny，ask 语义强制 ask（白名单/allow 不可覆盖） */
  private resolveDangerousBash(command: string, mode: Mode): PermissionResult | null {
    if (mode === 'plan') {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: 'plan 模式下禁止执行任何 shell 命令'
      }
    }

    const { riskLevel, isDangerous, reason } = assessCommandRisk(command || '')
    if (!isDangerous) return null

    if (isAutoPermissionSemantics(mode, this.permissionMode)) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: `自动执行策略下禁止危险命令: ${reason}`
      }
    }

    return {
      decision: 'ask',
      riskLevel,
      reason
    }
  }

  /**
   * 交互式入口（REPL / 交互 shell）：不可被白名单/allow 规则豁免。
   * 白名单与 allow 是「命令前缀」语义，对会话成立后写入的 stdin 字节无定义，
   * 因此命中必须在规则匹配之前出结果。
   */
  private resolveInteractiveEntry(command: string, mode: Mode): PermissionResult | null {
    if (!isInteractiveEntryCommand(command || '')) return null

    if (isAutoPermissionSemantics(mode, this.permissionMode)) {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: '自动执行策略下禁止启动交互式会话（任意执行入口），请改用非交互命令'
      }
    }

    return {
      decision: 'ask',
      riskLevel: 'high',
      reason: '该命令会启动等待输入的交互式会话，后续可写入任意内容，需要逐次确认'
    }
  }

  /**
   * shell_session 按 action 决策。会话白名单与 PermissionMatcher 持久规则都是
   * 命令前缀语义，对 action/ref 无定义，因此本分支直接返回，不走 matchPersistentDecision。
   */
  private checkShellSession(args: Record<string, unknown>, mode: Mode): PermissionResult {
    const action = args.action
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

    if (action === 'write') {
      return this.checkShellSessionWrite(args, mode)
    }

    return {
      decision: 'allow',
      riskLevel: 'low',
      reason: '终端会话观察与终止不产生新副作用'
    }
  }

  /** 写入内容风险评估是纵深防御第二层；第一层是创建时点的交互入口判定。 */
  private checkShellSessionWrite(args: Record<string, unknown>, mode: Mode): PermissionResult {
    if (mode === 'plan') {
      return {
        decision: 'deny',
        riskLevel: 'high',
        reason: 'plan 模式下禁止向终端会话写入输入（read/interrupt/stop 可用）'
      }
    }

    const input = typeof args.input === 'string' ? args.input : ''
    const { riskLevel, isDangerous, reason } = assessCommandRisk(input)

    if (isAutoPermissionSemantics(mode, this.permissionMode)) {
      if (isDangerous) {
        return {
          decision: 'deny',
          riskLevel: 'high',
          reason: `自动执行策略下禁止向会话写入危险内容: ${reason}`
        }
      }
      return {
        decision: 'allow',
        riskLevel: 'low',
        reason: '向运行中的终端进程写入输入'
      }
    }

    return {
      decision: 'ask',
      riskLevel,
      reason: isDangerous ? reason : '向运行中的终端进程写入输入'
    }
  }

  private matchPersistentDecision(
    toolName: string,
    args: Record<string, unknown>,
    target: 'allow' | 'deny'
  ): PermissionResult | null {
    if (this.rules.length === 0) return null

    const input: MatchInput = {
      toolName,
      args,
      currentProjectPath: this.currentProjectPath
    }
    const match = matchPermission(this.rules, input)
    if (match.decision !== target) return null

    return {
      decision: target,
      riskLevel: target === 'deny' ? 'high' : 'low',
      reason: match.reason
    }
  }

  /** 已通过危险检测的 bash：走 mode + policy 基线 */
  private checkBashSafe(command: string, mode: Mode): PermissionResult {
    const baseDecision = getBaseDecision(mode, 'bash', this.permissionMode)
    const { riskLevel } = assessCommandRisk(command || '')

    return {
      decision: baseDecision,
      riskLevel,
      reason: getRiskDescription('bash', riskLevel)
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
