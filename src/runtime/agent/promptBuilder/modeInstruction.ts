/**
 * 模式指令 — 附加到每轮 user 消息尾部的模式约束文本
 *
 * 将模式约束从 system prompt 移出，挂到 user 消息尾部。
 * 这样切模式只改尾部，前面整条历史的缓存前缀全部保留。
 */
import type { DevelopmentMode } from '../../../shared/session/mode'

/** 当前工具调用方言，决定模式指令是否要重复格式提醒 */
export interface ModeInstructionOptions {
  dialect?: 'native' | 'xml'
  activePlanPath?: string
}

function buildPlanInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[Current mode: plan — repository analysis and implementation planning]',
    'Read the actual code, tests, configuration, and project rules before planning. Use askQuestion to clarify material product or architecture ambiguities.',
    'Do not modify application files or execute shell commands. The only allowed file side effect is save_plan, which writes the complete Markdown plan under the current project\'s .nova/plans/.',
    'Cover the goal, scope and non-goals, call-chain evidence, ownership and data flow, implementation steps, preserved behavior, failure modes, verification, rollback, and open decisions.',
    'Call save_plan before finishing; a plan left only in the conversation is not a recoverable deliverable.',
    'Immediately after save_plan succeeds, call switch_mode(mode: default) and wait for the structured plan review: approve, correct, or ignore. Do not end the turn first.',
    'Do not use askQuestion to duplicate plan approval or ask how to proceed. The review result resumes switch_mode in the same run. After approval, implement the active plan immediately; after corrections, revise it using the feedback; after ignore, finish the turn normally.'
  ]
  if (opts?.activePlanPath) {
    lines.push(`The current session already has an active plan: ${opts.activePlanPath}. When revising it, reuse its original title to avoid duplicate files.`)
  }
  if (opts?.dialect === 'xml') {
    lines.push('Continue calling these tools with the XML <invoke> format specified in the system prompt.')
  }
  return lines.join('\n')
}

function buildDefaultInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[Current mode: default — standard development]',
    'You may read, modify, and verify the workspace. Tool approval follows the user\'s settings: request approval or execute automatically.',
    'When the user explicitly requests planning, or the task involves multiple modules, significant architecture tradeoffs, high regression risk, or unresolved requirements, first call switch_mode to enter plan, then continue analyzing and saving the plan within the current task. Do not merely claim to have switched.',
    'Entering plan narrows capabilities to read-only analysis and needs no additional user confirmation. Complete simple, clear, low-risk local tasks directly; use plan only when warranted.'
  ]
  if (opts?.activePlanPath) {
    lines.push(
      `The current session\'s active plan is ${opts.activePlanPath}. ` +
      'When the user asks to continue or implement it, read it and check it against the current repository before proceeding. Apply it only when relevant to the request.'
    )
  }
  if (opts?.dialect === 'xml') {
    lines.push('Call tools with the XML <invoke> format specified in the system prompt.')
  }
  return lines.join('\n')
}

function buildPilotInstruction(opts?: ModeInstructionOptions): string {
  const lines = [
    '[Current mode: pilot — Nova pilot]',
    'You may read, modify, and verify the workspace. Tool approval follows the user\'s settings: request approval or execute automatically.',
    'For each distinct new task, first call invoke_skill(skill_name: "builtin:nova-pilot", task: the current task). Then use read to load only the relevant workflows/*.md from the returned directory. Reuse the method for ordinary follow-ups; choose again when the task direction changes.',
    'Briefly restate the goal, then proceed. Use reasonable defaults for clear small tasks instead of a fixed interview. Batch material ambiguities into at most one necessary clarification round, then proceed autonomously.',
    'Investigate questions answerable through execution, source code, layout inspection, or performance measurement. Ask the user only about goals, preferences, and irreversible actions.',
    'Organize planning, implementation, and verification within the current mode. Express steps with the ordinary todo_write tool and finish through the ordinary Run terminal state. Mode changes require an explicit user action.',
    'Verify through the real usage entry point. An incorrect entry point, an uncertain result, or an unexecuted check is not a pass. When real artifacts exist and present_evidence is available, use it to select relevant evidence. An artifact\'s existence is not proof of success; report save failures and unavailable targets honestly.',
    'Do not automatically commit, push, deploy, or perform irreversible actions.',
    'General Skills are neither automatically discovered nor automatically invoked. When the user manually invokes a Skill, follow this precedence: the current explicit user task, then the Skill\'s specific behavior, then pilot\'s general organization and honest-delivery rules. Do not mechanically add a duplicate workflow.'
  ]
  if (opts?.activePlanPath) {
    lines.push(
      `The current session\'s active plan is ${opts.activePlanPath}. ` +
      'When the user asks to continue or implement it, read it and check it against the current repository before proceeding. Apply it only when relevant to the request.'
    )
  }
  if (opts?.dialect === 'xml') {
    lines.push('Call tools with the XML <invoke> format specified in the system prompt.')
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

export function getModeInstruction(mode: DevelopmentMode, opts?: ModeInstructionOptions): string {
  switch (mode) {
    case 'plan':
      return buildPlanInstruction(opts)
    case 'pilot':
      return buildPilotInstruction(opts)
    case 'default':
    default:
      return buildDefaultInstruction(opts)
  }
}
