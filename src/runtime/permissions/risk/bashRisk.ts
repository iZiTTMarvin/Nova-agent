import type { RiskLevel } from '../types'

/**
 * 静态命令分类器无法证明任意 shell 命令是安全的。
 * 未命中危险模式只代表「没命中已知高风险模式」，不代表已证明安全。
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
  { pattern: /\b(rmdir|rd)\s+\/[sSqQ]\s+\/[qQ]/i, reason: 'Windows 静默递归删除目录' },
  {
    pattern: /\bdel\b(?=[^\r\n]*\/[fFsS])(?=[^\r\n]*\/[sS])(?=[^\r\n]*\/[qQ])/i,
    reason: 'Windows 静默强制递归删除文件'
  },
  { pattern: /\bformat\s+[a-zA-Z]:/, reason: '格式化磁盘驱动器' },
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
