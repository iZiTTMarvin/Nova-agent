/** learn 模式可见工具；呈现与授权双门禁共用此清单。 */
export const LEARN_VISIBLE_TOOL_NAMES: readonly string[] = [
  'ls',
  'read',
  'grep',
  'find',
  'code_context',
  'learning_context',
  'learning_checkpoint',
  'learning_assess'
]

const VISIBLE = new Set(LEARN_VISIBLE_TOOL_NAMES)

/** learn 模式硬禁止（含 full_access 不可解除的产品只读）。 */
export const LEARN_FORBIDDEN_TOOL_NAMES: readonly string[] = [
  'write',
  'edit',
  'bash',
  'shell_session',
  'web_search',
  'web_fetch',
  'browser_open',
  'browser_observe',
  'browser_act',
  'browser_close',
  'browser_capture',
  'memory_manage',
  'todo_write',
  'askQuestion',
  'invoke_skill',
  'task',
  'task_followup',
  'task_wait',
  'batch_task',
  'subagent_read',
  'save_plan',
  'switch_mode',
  'stage_transition',
  'load_tools',
  'run_code',
  'agent_list',
  'model_list',
  'inspection_report'
]

const FORBIDDEN = new Set(LEARN_FORBIDDEN_TOOL_NAMES)

const LEARNING_DOMAIN_TOOLS = new Set([
  'learning_context',
  'learning_checkpoint',
  'learning_assess'
])

export function isLearningDomainTool(toolName: string): boolean {
  return LEARNING_DOMAIN_TOOLS.has(toolName)
}

export function isLearnVisibleTool(toolName: string): boolean {
  return VISIBLE.has(toolName)
}

export function isLearnForbiddenTool(toolName: string): boolean {
  return FORBIDDEN.has(toolName)
}
