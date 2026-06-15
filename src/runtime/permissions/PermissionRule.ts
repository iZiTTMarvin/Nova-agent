/**
 * PermissionRule — 持久化的工具权限规则（PRD §5.2）
 *
 * 定义某个工具在某个范围（全局/项目）下是 allow / deny / ask。
 * 注意：与现有针对 .mdc 规则文件的 RuleFileEntry 概念无关，命名上请勿混淆
 *       （后者是 agent 行为规则文件，本类型是工具调用授权规则）。
 */
import { createHash } from 'crypto'
import type { PermissionDecision } from '../../shared/session/types'

export type PermissionBehavior = PermissionDecision // 'allow' | 'deny' | 'ask'

/** 匹配条件的目标工具名，'*' 表示通配所有工具 */
export type PermissionToolName = string

export interface PermissionRule {
  /**
   * 规则稳定标识。生成策略：`<scope>:<toolName>:<matcher>:<behavior>` 四段
   * 去冒号/空白后取 sha1 前 12 位。
   * 这样同一目标重复"始终允许"会命中同一 id 去重（upsert），而非无限新增规则；
   * UI 删除时按 id 定位。不依赖 uuid，保证跨进程/跨重启可复现。
   */
  id: string
  /** 目标工具名：'bash' | 'write' | 'edit' | '*' 等 */
  toolName: PermissionToolName
  behavior: PermissionBehavior
  /** 范围：global 全局 / project 项目级 */
  scope: 'global' | 'project'
  /** 项目级规则绑定的项目绝对路径（scope=global 时为空） */
  projectPath?: string
  /** 匹配条件，满足一条即可（commandPrefix 与 commandRegex 主要用于 bash） */
  commandPrefix?: string
  commandRegex?: string
  /** 目标文件 glob（write/edit 工具） */
  filePath?: string
  /** UI 展示用的人类可读描述 */
  description?: string
  createdAt: number
}

/**
 * 计算规则 id。
 * 同一组 (scope, toolName, matcher, behavior) 生成相同 id，便于 upsert 去重。
 *
 * 防碰撞：matcher 各字段用显式前缀标记（prefix=/regex=/file=），
 * 避免用 '|' 连接导致 prefix='a|b' 与 prefix='a'+regex='b' 产生相同串。
 */
export function computePermissionRuleId(
  scope: PermissionRule['scope'],
  toolName: PermissionToolName,
  behavior: PermissionBehavior,
  matcher: { commandPrefix?: string; commandRegex?: string; filePath?: string }
): string {
  // 显式字段标记，消除 matcher 值本身的歧义
  const matcherParts: string[] = []
  if (matcher.commandPrefix !== undefined) {
    matcherParts.push(`prefix=${matcher.commandPrefix}`)
  }
  if (matcher.commandRegex !== undefined) {
    matcherParts.push(`regex=${matcher.commandRegex}`)
  }
  if (matcher.filePath !== undefined) {
    matcherParts.push(`file=${matcher.filePath}`)
  }
  const matcherStr = matcherParts.join('&')
  const raw = `${scope}:${toolName}:${matcherStr}:${behavior}`
  return createHash('sha1').update(raw).digest('hex').slice(0, 12)
}

/** 构造一条完整规则（自动生成 id 与 createdAt） */
export function createPermissionRule(input: {
  toolName: PermissionToolName
  behavior: PermissionBehavior
  scope: PermissionRule['scope']
  projectPath?: string
  commandPrefix?: string
  commandRegex?: string
  filePath?: string
  description?: string
}): PermissionRule {
  const id = computePermissionRuleId(input.scope, input.toolName, input.behavior, {
    commandPrefix: input.commandPrefix,
    commandRegex: input.commandRegex,
    filePath: input.filePath
  })
  return {
    id,
    toolName: input.toolName,
    behavior: input.behavior,
    scope: input.scope,
    ...(input.projectPath ? { projectPath: input.projectPath } : {}),
    ...(input.commandPrefix ? { commandPrefix: input.commandPrefix } : {}),
    ...(input.commandRegex ? { commandRegex: input.commandRegex } : {}),
    ...(input.filePath ? { filePath: input.filePath } : {}),
    ...(input.description ? { description: input.description } : {}),
    createdAt: Date.now()
  }
}
