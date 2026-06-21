/**
 * 模式指令 — 附加到每轮 user 消息尾部的模式约束文本
 *
 * 将模式约束从 system prompt 移出，挂到 user 消息尾部。
 * 这样切模式只改尾部，前面整条历史的缓存前缀全部保留。
 */
import type { Mode } from '../../../shared/session/types'

/** 当前工具调用方言，决定模式指令是否要重复格式提醒 */
export interface ModeInstructionOptions {
  dialect?: 'native' | 'xml'
}

function buildPlanInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[当前模式: plan — 只读规划]',
    '你只能使用 ls、read、grep、find 工具读取和分析项目。',
    '不能编辑文件、不能写入、不能执行 bash。',
    '输出应为分析、计划、风险说明和需要确认的问题。',
    '如果用户要求直接实现，请说明需要切换到 default 或 auto 模式。'
  ]
  if (opts?.dialect === 'xml') {
    lines.push('请继续用 system prompt 中指定的 XML \u003cinvoke\u003e 格式调用这些工具。')
  }
  return lines.join('\n')
}

function buildDefaultInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[当前模式: default — 标准模式]',
    '你可以读取、修改和验证工作区，高风险操作需用户审批。'
  ]
  if (opts?.dialect === 'xml') {
    lines.push('调用工具时请使用 system prompt 中指定的 XML \u003cinvoke\u003e 格式。')
  }
  return lines.join('\n')
}

function buildAutoInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[当前模式: auto — 主动模式]',
    '你可以主动推进实现和验证，遵守安全边界。'
  ]
  if (opts?.dialect === 'xml') {
    lines.push('调用工具时请使用 system prompt 中指定的 XML \u003cinvoke\u003e 格式。')
  }
  return lines.join('\n')
}

/** 获取当前模式的约束指令文本，附加到 user 消息尾部 */
export function getModeInstruction(mode: Mode, opts?: ModeInstructionOptions): string {
  switch (mode) {
    case 'plan':
      return buildPlanInstruction(opts)
    case 'auto':
      return buildAutoInstruction(opts)
    case 'default':
    default:
      return buildDefaultInstruction(opts)
  }
}
