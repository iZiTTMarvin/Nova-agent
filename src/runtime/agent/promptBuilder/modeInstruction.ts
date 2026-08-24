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
    'save_plan 成功后必须立即调用 switch_mode(mode: default)，通过计划审阅交互等待用户批准、更正或忽略；不要先结束本轮。',
    '不要用 askQuestion 询问是否批准或如何推进计划；审阅结果会在同一 run 内恢复 switch_mode。批准后立即按 active plan 继续实施，更正时根据反馈继续修订，忽略时正常结束本轮。'
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
    '[当前模式: compose — 编排模式]',
    '你作为主编排 Agent，亲自按「构思 → 计划 → 开发 → 验证 → 审查 → 收尾」六阶段推进生命周期。每轮消息尾部会附当前阶段的阶段指南，阶段目标与完成标准以指南为准。',
    '阶段推进只能调用 stage_transition：complete 完成当前阶段并进入下一阶段，skip 跳过当前阶段（需原因），return 回退到更早阶段（需目标阶段与原因）。',
    '旧的编排路由工具已废弃，不要尝试调用：编排职责由你亲自承担，开发阶段亲自实现，审查阶段只派唯一一个只读子代理。',
    '部分阶段会收窄可用工具（构思阶段仅只读，计划阶段仅可额外写计划文档）；工具被拦截时，先按指南完成当前阶段再推进。',
    '质量门禁以真实工具结果、实际跑过的测试与独立审查为准；模型自报通过不算过。',
    '不自动执行 git commit、push 或 deploy；需要发布时须由用户确认。危险命令仍会被拦截；需要澄清时使用 askQuestion。'
  ]
  if (opts?.dialect === 'xml') {
    lines.push('调用工具时请使用 system prompt 中指定的 XML \u003cinvoke\u003e 格式。')
  }
  return lines.join('\n')
}

export function getHeadlessExecutionInstruction(): string {
  return [
    '[执行环境: headless coding task]',
    '直接在当前工作区完成任务；这里没有交互式模式切换或工具批准流程，不要等待用户确认，也不要请求切换模式。',
    '先用工具定位根因，实施最小且完整的修改，再运行与改动匹配的测试或检查。',
    '只有任务完成，或工具证据表明确有无法自行解决的阻塞时，才停止执行。'
  ].join('\n')
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
