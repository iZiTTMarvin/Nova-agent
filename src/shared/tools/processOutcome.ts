import type { ToolBlock } from '../session/types'
import type { ToolProcessOutcome } from './types'

export function isToolProcessOutcome(value: unknown): value is ToolProcessOutcome {
  if (!value || typeof value !== 'object' || !('state' in value)) return false
  if (value.state === 'running' || value.state === 'unconfirmed') return !('exitCode' in value)
  return value.state === 'exited' && 'exitCode' in value &&
    (value.exitCode === null || (typeof value.exitCode === 'number' && Number.isInteger(value.exitCode)))
}

/** 兼容未保存 processOutcome 的旧工具块；旧格式退出读取停止支持后可删除文本分支。 */
export function readToolProcessOutcome(block: ToolBlock): ToolProcessOutcome | undefined {
  if (block.toolName !== 'bash' && block.toolName !== 'shell_session') return undefined
  if (block.processOutcome !== undefined) {
    return isToolProcessOutcome(block.processOutcome) ? block.processOutcome : { state: 'unconfirmed' }
  }
  if (block.status !== 'success') return undefined
  const text = block.result ?? ''
  if (/\[进程仍在运行 ref:/.test(text)) return { state: 'running' }
  const match = block.toolName === 'bash'
    ? text.match(/\[命令退出码:\s*(-?\d+)/)
    : text.match(/\[会话已(?:终止|结束)，退出码:\s*(-?\d+)/)
  if (match) return { state: 'exited', exitCode: Number(match[1]) }
  // 旧版前台 bash 仅非零退出写标记；持久进程引用不属于该旧版成功约定。
  if (block.toolName === 'bash' && !/psn_[A-Za-z0-9_-]{12}/.test(text)) {
    return { state: 'exited', exitCode: 0 }
  }
  return { state: 'unconfirmed' }
}
