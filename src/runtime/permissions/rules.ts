/**
 * 模式 + 权限策略规则表 + 危险命令检测
 *
 * | 工具                 | plan    | default+ask | default+auto / compose |
 * |----------------------|---------|-------------|------------------------|
 * | ls/read/grep/find    | allow   | allow       | allow                  |
 * | edit/write           | deny    | allow       | allow                  |
 * | bash                 | deny    | ask         | allow*                 |
 * | task/invoke_skill    | deny    | allow       | allow                  |
 *
 * *auto 语义下危险命令（sudo、rm -rf、curl|sh 等）强制 deny
 *
 * task/invoke_skill 为编排类（orchestration）：派遣动作本身无副作用，直接放行；
 * 真正的副作用由子代理内部工具各自走权限检查（不在派遣层重复拦截）。
 */
import type { Mode, PermissionDecision, PermissionPolicy } from '../../shared/session/types'
import { getToolCapability } from '../../shared/session/toolVisibility'
import type { RiskLevel } from './types'

/**
 * 危险命令黑名单模式
 * 匹配这些模式的命令在 auto 语义下也会被拒绝
 */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: '需要超级用户权限' },
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/, reason: '强制递归删除' },
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive\b)/, reason: '递归删除目录' },
  { pattern: /(^|[\s;&|`(])eval\s/, reason: '在当前 shell 中执行任意字符串' },
  { pattern: /(^|[\s;&|`(])(source|\.)\s+\S/, reason: '在当前 shell 中执行脚本（source）' },
  { pattern: /`[^`]+`/, reason: '通过反引号执行任意命令，可能隐藏危险关键字' },
  { pattern: /\bcurl\b.*\|\s*(sh|bash|zsh)/, reason: '从网络下载并直接执行脚本' },
  { pattern: /\bwget\b.*\|\s*(sh|bash|zsh)/, reason: '从网络下载并直接执行脚本' },
  { pattern: /\bchmod\s+([0-7]{3,4}|[+-][rwx])/, reason: '修改文件权限' },
  { pattern: /\bchown\b/, reason: '修改文件所有者' },
  { pattern: /\bmkfs\b/, reason: '格式化文件系统' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: '直接写入块设备' },
  { pattern: />\s*\/dev\//, reason: '直接写入设备文件' },
  { pattern: /\bservice\s+\w+\s+start/, reason: '启动系统服务' },
  { pattern: /\bsystemctl\s+(start|enable)/, reason: '启动或启用系统服务' },
  // Windows cmd：rd 为 rmdir 别名；del 的 /f /s /q 顺序无关
  { pattern: /\b(rmdir|rd)\s+\/[sSqQ]\s+\/[qQ]/i, reason: 'Windows 静默递归删除目录' },
  {
    pattern: /\bdel\b(?=[^\r\n]*\/[fFsS])(?=[^\r\n]*\/[sS])(?=[^\r\n]*\/[qQ])/i,
    reason: 'Windows 静默强制递归删除文件'
  },
  { pattern: /\bformat\s+[a-zA-Z]:/, reason: '格式化磁盘驱动器' },
  // PowerShell cmdlet 辨识度极高，不依赖命令串是否含 powershell 一词
  {
    pattern: /Remove-Item\b[^\r\n]*-(?:Recurse|Force)/i,
    reason: 'PowerShell 强制递归删除'
  },
  { pattern: /\b(Invoke-Expression|iex)\b/i, reason: 'PowerShell 动态执行' },
  {
    pattern: /\b(Invoke-WebRequest|iwr|Invoke-RestMethod)\b[^\r\n]*\|\s*(iex|Invoke-Expression)\b/i,
    reason: '从网络下载并执行脚本'
  },
  { pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk)\b/i, reason: 'PowerShell 磁盘破坏性操作' },
  { pattern: /\bSet-ExecutionPolicy\b/i, reason: '修改 PowerShell 执行策略' },
  { pattern: /\b(Stop-Computer|Restart-Computer)\b/i, reason: '关闭或重启计算机' },
  { pattern: /\bStart-Process\b[^\r\n]*-Verb\s+RunAs/i, reason: '提权启动进程' },
  {
    pattern: /\b(Set-ItemProperty|Remove-ItemProperty)\b[^\r\n]*(HKLM:|HKCU:)/i,
    reason: '修改注册表'
  },
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
 * 是否走 auto 语义（自动放行，危险命令仍拦）。
 * - plan：永不 auto
 * - compose：run 内固定 auto 语义
 * - default：读 permissionPolicy
 */
export function isAutoPermissionSemantics(
  mode: Mode,
  policy: PermissionPolicy = 'ask'
): boolean {
  if (mode === 'plan') return false
  if (mode === 'compose') return true
  return policy === 'auto'
}

/**
 * 根据模式、权限策略和工具名查询权限决策（不含 bash 命令级别判断）
 */
export function getBaseDecision(
  mode: Mode,
  toolName: string,
  policy: PermissionPolicy = 'ask'
): PermissionDecision {
  const capability = getToolCapability(toolName)
  const category = capability === 'unknown' ? 'bash' : capability

  // 模式切换始终要求确认，不能被 default auto / compose 的自动语义放行。
  if (category === 'mode-transition') {
    return 'ask'
  }

  // plan 模式：只读与受限计划产物 allow，其余全部 deny。
  if (mode === 'plan') {
    return category === 'readonly' || category === 'plan-artifact' ? 'allow' : 'deny'
  }

  // compose / default+auto：所有工具默认 allow（bash 危险命令在 PermissionManager 层处理）
  if (isAutoPermissionSemantics(mode, policy)) {
    return 'allow'
  }

  // default + ask：只读和写入 allow，bash 需确认
  return category === 'bash' ? 'ask' : 'allow'
}

/**
 * 获取工具在当前模式下的风险等级描述
 */
export function getRiskDescription(toolName: string, riskLevel: RiskLevel): string {
  const capability = getToolCapability(toolName)
  const category = capability === 'unknown' ? 'bash' : capability

  if (category === 'readonly') return '只读操作'
  if (category === 'plan-artifact') return '写入工作区计划文档'
  if (category === 'mode-transition') return '切换运行模式'
  if (category === 'write') return riskLevel === 'high' ? '高风险写入' : '写入操作'
  return riskLevel === 'high' ? '高风险命令' : 'Shell 命令'
}
