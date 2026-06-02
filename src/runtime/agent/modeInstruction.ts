/**
 * 模式指令 — 附加到每轮 user 消息尾部的模式约束文本
 *
 * 将模式约束从 system prompt 移出，挂到 user 消息尾部。
 * 这样切模式只改尾部，前面整条历史的缓存前缀全部保留。
 */
import type { Mode } from '../../shared/session/types'

const PLAN_INSTRUCTION = [
  '[当前模式: plan — 只读规划]',
  '你只能使用 ls、read、grep、find 工具读取和分析项目。',
  '不能编辑文件、不能写入、不能执行 bash。',
  '输出应为分析、计划、风险说明和需要确认的问题。',
  '如果用户要求直接实现，请说明需要切换到 default 或 auto 模式。'
].join('\n')

const DEFAULT_INSTRUCTION = [
  '[当前模式: default — 标准模式]',
  '你可以读取、修改和验证工作区，高风险操作需用户审批。'
].join('\n')

const AUTO_INSTRUCTION = [
  '[当前模式: auto — 主动模式]',
  '你可以主动推进实现和验证，遵守安全边界。'
].join('\n')

/** 获取当前模式的约束指令文本，附加到 user 消息尾部 */
export function getModeInstruction(mode: Mode): string {
  switch (mode) {
    case 'plan':
      return PLAN_INSTRUCTION
    case 'auto':
      return AUTO_INSTRUCTION
    case 'default':
    default:
      return DEFAULT_INSTRUCTION
  }
}
