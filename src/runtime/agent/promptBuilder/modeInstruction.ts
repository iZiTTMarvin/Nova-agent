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
    '如果用户要求直接实现，请说明需要切换到默认模式或编排模式。'
  ]
  if (opts?.dialect === 'xml') {
    lines.push('请继续用 system prompt 中指定的 XML \u003cinvoke\u003e 格式调用这些工具。')
  }
  return lines.join('\n')
}

function buildDefaultInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[当前模式: default — 默认模式]',
    '你可以读取、修改和验证工作区；工具批准策略由用户设置决定（执行前确认或自动执行）。'
  ]
  if (opts?.dialect === 'xml') {
    lines.push('调用工具时请使用 system prompt 中指定的 XML \u003cinvoke\u003e 格式。')
  }
  return lines.join('\n')
}

function buildComposeInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[当前模式: XForge — BuildRail 阶段自适应顺序工作流]',
    'XForge 是基于 BuildRail 开发生命周期的单主 Agent 自动工作流：根据用户自然语言与仓库事实选择安全起点，并自动向后推进（探索 → 计划 → Scope → 实现 → 测试 → 审查 → 汇报）。',
    '质量门禁以 Runtime 受控命令结果、真实测试与隔离 Review 为准；模型自报通过不算过。',
    '不自动执行 git commit、push 或 deploy；需要发布时须由用户确认。',
    '自然语言需求与 /br-full-dev 统一进入原生 XForge 阶段执行器；历史脚本只用于恢复旧任务。',
    '可以读取、修改和验证工作区；危险命令仍会被拦截。阻塞或连续失败时通过 askQuestion / askUser 询问用户，不要跳过强制门禁。'
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
    case 'compose':
      return buildComposeInstruction(opts)
    case 'default':
    default:
      return buildDefaultInstruction(opts)
  }
}
