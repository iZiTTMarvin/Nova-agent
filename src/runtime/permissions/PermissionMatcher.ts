/**
 * PermissionMatcher — 权限规则匹配引擎（PRD §5.2）
 *
 * 纯函数、无副作用、无 IO，可独立单测。
 *
 * 匹配顺序（优先级从高到低）：
 * 1. 项目级规则 > 全局规则
 * 2. 显式工具名规则 > '*' 通配规则
 * 3. deny 优先于 allow（同级同工具下，deny 一票否决）
 *
 * 命中策略：
 * - deny 直接拒绝（即便有同级 allow 也拒绝）
 * - allow 直接放行
 * - ask 转交现有 mode + 黑名单逻辑
 * - 无匹配返回 no-match，由调用方走 mode-based 决策
 */
import type { PermissionRule, PermissionBehavior } from './PermissionRule'

export type MatcherDecision = 'allow' | 'ask' | 'deny' | 'no-match'

export interface MatchResult {
  decision: MatcherDecision
  matchedRule?: PermissionRule
  reason: string
}

export interface MatchInput {
  toolName: string
  /** 工具参数（bash 的 command、write/edit 的 filePath 等） */
  args: Record<string, unknown>
  /** 当前项目路径（用于筛选项目级规则） */
  currentProjectPath: string | null
}

/**
 * 判断单条规则是否匹配当前输入。
 */
function ruleMatches(rule: PermissionRule, input: MatchInput): boolean {
  // 1. 工具名：'*' 通配，否则需精确匹配
  if (rule.toolName !== '*' && rule.toolName !== input.toolName) {
    return false
  }

  // 2. 项目级规则只对绑定的项目生效
  if (rule.scope === 'project') {
    if (!rule.projectPath || !input.currentProjectPath) return false
    if (rule.projectPath !== input.currentProjectPath) return false
  }

  // 3. bash 命令匹配：commandPrefix 或 commandRegex
  if (rule.commandPrefix !== undefined || rule.commandRegex !== undefined) {
    const command = typeof input.args.command === 'string' ? input.args.command : ''
    if (rule.commandPrefix !== undefined) {
      // 前缀匹配（去首尾空白后）
      if (!command.trim().startsWith(rule.commandPrefix.trim())) return false
    }
    if (rule.commandRegex !== undefined) {
      try {
        const re = new RegExp(rule.commandRegex)
        if (!re.test(command)) return false
      } catch {
        // 非法正则视为不匹配
        return false
      }
    }
  }

  // 4. 文件路径匹配（write/edit）
  if (rule.filePath !== undefined) {
    const target = typeof input.args.filePath === 'string'
      ? input.args.filePath
      : (typeof input.args.path === 'string' ? input.args.path : '')
    // 简单 glob：'*' 视为通配，否则前缀匹配
    if (rule.filePath === '*') {
      // 通配，命中
    } else if (!target.includes(rule.filePath.replace(/\*/g, ''))) {
      return false
    }
  }

  return true
}

/**
 * 在规则集合中查找匹配项并给出决策。
 *
 * 优先级实现：按 (scope, toolNameSpecificity) 分桶，逐桶检查。
 */
export function matchPermission(rules: PermissionRule[], input: MatchInput): MatchResult {
  if (rules.length === 0) {
    return { decision: 'no-match', reason: '无持久化权限规则' }
  }

  // 分桶：[项目级显式, 项目级通配, 全局显式, 全局通配]
  // 优先级从高到低；deny 在同桶内优先于 allow
  const buckets: PermissionRule[][] = [[], [], [], []]

  for (const rule of rules) {
    if (!ruleMatches(rule, input)) continue
    const isProject = rule.scope === 'project'
    const isExplicit = rule.toolName !== '*'
    const idx = (isProject ? 0 : 2) + (isExplicit ? 0 : 1)
    buckets[idx].push(rule)
  }

  // 按桶优先级遍历；每桶内 deny 优先
  for (const bucket of buckets) {
    if (bucket.length === 0) continue
    // 桶内优先找 deny
    const deny = bucket.find(r => r.behavior === 'deny')
    if (deny) {
      return { decision: 'deny', matchedRule: deny, reason: `命中拒绝规则: ${deny.description ?? deny.id}` }
    }
    // 再找 allow
    const allow = bucket.find(r => r.behavior === 'allow')
    if (allow) {
      return { decision: 'allow', matchedRule: allow, reason: `命中允许规则: ${allow.description ?? allow.id}` }
    }
    // 再找 ask
    const ask = bucket.find(r => r.behavior === 'ask')
    if (ask) {
      return { decision: 'ask', matchedRule: ask, reason: `命中询问规则: ${ask.description ?? ask.id}` }
    }
  }

  return { decision: 'no-match', reason: '无匹配规则' }
}

/** 便捷：判断决策是否为最终放行（不再走 mode 逻辑） */
export function isAllow(decision: MatcherDecision): boolean {
  return decision === 'allow'
}

/** 便捷：判断决策是否为最终拒绝（不再走 mode 逻辑） */
export function isDeny(decision: MatcherDecision): boolean {
  return decision === 'deny'
}

/** 把 MatcherDecision 转为 PermissionBehavior（no-match 时返回 undefined） */
export function toBehavior(decision: MatcherDecision): PermissionBehavior | undefined {
  if (decision === 'allow' || decision === 'deny' || decision === 'ask') return decision
  return undefined
}
