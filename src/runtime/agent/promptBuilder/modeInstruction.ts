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
  activePlanPath?: string
}

function buildPlanInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[当前模式: plan — 仓库分析与实施计划]',
    '先读取真实代码、测试、配置和项目规范，再形成计划；关键产品或架构歧义可用 askQuestion 澄清。',
    '禁止修改业务文件、禁止执行 shell。唯一允许的文件副作用是调用 save_plan，把完整 Markdown 计划写入当前项目的 .nova/plans/。',
    '计划必须覆盖目标、范围与非目标、当前调用链证据、职责与数据流、分阶段改动、保护的已有行为、失败模式、验证、回退和待决事项。',
    '完成前必须调用 save_plan；不要只在聊天正文里留下不可恢复的计划。',
    'save_plan 成功后，完整计划会显示在计划审阅卡中。请明确邀请用户选择「开始实施」或「继续完善」，不要假定用户已经批准。',
    '用户通过审阅卡或文字明确批准计划后，可调用 switch_mode 请求切换到 default；切换必须经过用户确认，不能进入 XForge。'
  ]
  if (opts?.activePlanPath) {
    lines.push(`当前会话已有 active plan: ${opts.activePlanPath}。修订同一计划时沿用原标题，避免生成重复文件。`)
  }
  if (opts?.dialect === 'xml') {
    lines.push('请继续用 system prompt 中指定的 XML \u003cinvoke\u003e 格式调用这些工具。')
  }
  return lines.join('\n')
}

function buildDefaultInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[当前模式: default — 默认模式]',
    '你可以读取、修改和验证工作区；工具批准策略由用户设置决定（执行前确认或自动执行）。',
    '当用户明确要求先规划，或任务涉及多个模块、关键架构取舍、较高回归风险、需求仍需澄清时，先调用 switch_mode 进入 plan，并在当前任务中继续分析和保存计划；不要只口头声称已切换。',
    '进入 plan 是收窄为只读能力，不需要额外征求用户确认。简单、明确、低风险的局部任务应直接完成，不要滥用计划模式。'
  ]
  if (opts?.activePlanPath) {
    lines.push(
      `当前会话的 active plan 是 ${opts.activePlanPath}。` +
      '当用户要求继续或实施该计划时，先读取它并结合当前仓库复核，再按计划推进；若请求与该计划无关，不要擅自套用。'
    )
  }
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
