/**
 * 验证结果格式化
 */
import type { VerificationResult } from './types'

/**
 * 将验证结果格式化为用户可读摘要
 */
export function formatVerificationSummary(result: VerificationResult): string {
  const typeLabel = getTypeLabel(result.type)
  const statusIcon = result.success ? '✓' : '✗'
  const duration = (result.durationMs / 1000).toFixed(1)

  if (result.success) {
    return `${statusIcon} ${typeLabel}通过 (${duration}s) — ${result.command}`
  }

  const outputLines = result.output.split('\n')
  const tailOutput = outputLines.length > 5
    ? `...\n${outputLines.slice(-5).join('\n')}`
    : result.output

  return `${statusIcon} ${typeLabel}失败 (${duration}s) — ${result.command}\n${tailOutput}`
}

function getTypeLabel(type: string): string {
  switch (type) {
    case 'test': return '测试'
    case 'lint': return '代码检查'
    case 'build': return '构建'
    default: return '验证'
  }
}
