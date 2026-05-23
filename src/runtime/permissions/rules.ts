/**
 * 三模式权限规则表 + 危险命令检测
 *
 * 规则矩阵：
 * | 工具              | plan    | default | auto    |
 * |-------------------|---------|---------|---------|
 * | ls/read/grep/find | allow   | allow   | allow   |
 * | edit/write        | deny    | allow   | allow   |
 * | bash              | deny    | ask     | allow*  |
 *
 * *auto 模式下危险命令（sudo、rm -rf、curl|sh 等）强制 deny
 */
import type { Mode, PermissionDecision } from '../../shared/session/types'
import { getToolCapability } from '../../shared/session/toolVisibility'
import type { RiskLevel } from './types'

/**
 * 危险命令黑名单模式
 * 匹配这些模式的命令在 auto 模式下也会被拒绝
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  // Unix 危险命令
  { pattern: /\bsudo\b/, reason: '需要超级用户权限' },
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/, reason: '强制递归删除' },
  { pattern: /\brm\s+-[a-zA-Z]*r/, reason: '递归删除目录' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash|zsh)/, reason: '从网络下载并直接执行脚本' },
  { pattern: /\bwget\b.*\|\s*(sh|bash|zsh)/, reason: '从网络下载并直接执行脚本' },
  { pattern: /\bchmod\s+([0-7]{3,4}|[+-][rwx])/, reason: '修改文件权限' },
  { pattern: /\bchown\b/, reason: '修改文件所有者' },
  { pattern: /\bmkfs\b/, reason: '格式化文件系统' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写入块设备' },
  { pattern: />\s*\/dev\//, reason: '直接写入设备文件' },
  { pattern: /\bservice\s+\w+\s+start/, reason: '启动系统服务' },
  { pattern: /\bsystemctl\s+(start|enable)/, reason: '启动或启用系统服务' },
  // Windows 危险命令
  { pattern: /\brmdir\s+\/[sS]\s+\/[qQ]/, reason: 'Windows 静默递归删除目录' },
  { pattern: /\bdel\s+\/[sS]\s+\/[fF]\s+\/[qQ]/, reason: 'Windows 静默强制递归删除文件' },
  { pattern: /\bformat\s+[a-zA-Z]:/, reason: '格式化磁盘驱动器' },
  { pattern: /\bpowershell\b.*Remove-Item.*-Recurse.*-Force/i, reason: 'PowerShell 强制递归删除' },
  { pattern: /\bpowershell\b.*Invoke-WebRequest.*\|\s*Invoke-Expression/i, reason: '从网络下载并执行脚本' },
  { pattern: /\bnet\s+(user|localgroup)\s+/i, reason: '修改系统用户或用户组' },
  { pattern: /\breg\s+(add|delete)\s+/i, reason: '修改或删除系统注册表' },
  { pattern: /\bschtasks\s+\/(create|delete)\s+/i, reason: '创建或删除计划任务' },
]

/**
 * 检测命令是否为危险命令
 * 返回风险等级和原因说明
 */
export function assessCommandRisk(command: string): {
  riskLevel: RiskLevel
  isDangerous: boolean
  reason: string
} {
  for (const { pattern, reason } of DANGEROUS_PATTERNS) {
    if (pattern.test(command)) {
      return { riskLevel: 'high', isDangerous: true, reason }
    }
  }
  return { riskLevel: 'low', isDangerous: false, reason: '' }
}

/**
 * 根据模式和工具名查询权限决策（不含 bash 命令级别判断）
 * 用于非 bash 工具的快速查询
 */
export function getBaseDecision(mode: Mode, toolName: string): PermissionDecision {
  const capability = getToolCapability(toolName)
  const category = capability === 'unknown' ? 'bash' : capability

  // plan 模式：只读工具 allow，其余全部 deny
  if (mode === 'plan') {
    return category === 'readonly' ? 'allow' : 'deny'
  }

  // default 模式：只读和写入工具 allow，bash 工具 ask
  if (mode === 'default') {
    return category === 'bash' ? 'ask' : 'allow'
  }

  // auto 模式：所有工具默认 allow（bash 的危险命令检测在 PermissionManager 层处理）
  return 'allow'
}

/**
 * 获取工具在当前模式下的风险等级描述
 */
export function getRiskDescription(toolName: string, riskLevel: RiskLevel): string {
  const capability = getToolCapability(toolName)
  const category = capability === 'unknown' ? 'bash' : capability
  if (category === 'readonly') return '只读操作'
  if (category === 'write') return '文件修改操作'
  if (riskLevel === 'high') return '高危命令执行'
  return '命令执行'
}
