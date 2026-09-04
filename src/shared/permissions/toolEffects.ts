import type {
  PermissionCapabilityCeiling,
  ToolEffect,
  ToolPermissionDescriptor
} from './types'

const FILESYSTEM_READ: ToolPermissionDescriptor = {
  effects: ['filesystem.read'],
  pathScope: 'dynamic'
}

const DESCRIPTORS: Record<string, ToolPermissionDescriptor> = {
  ls: FILESYSTEM_READ,
  read: FILESYSTEM_READ,
  grep: FILESYSTEM_READ,
  find: FILESYSTEM_READ,
  archive_read: { effects: ['filesystem.read'], pathScope: 'none' },
  history_read: { effects: ['filesystem.read'], pathScope: 'none' },
  memory_search: { effects: ['filesystem.read'], pathScope: 'none' },
  code_context: { effects: ['filesystem.read'], pathScope: 'none' },
  write: { effects: ['filesystem.write'], pathScope: 'dynamic' },
  edit: {
    effects: ['filesystem.read', 'filesystem.write'],
    pathScope: 'dynamic'
  },
  bash: { effects: ['shell.execute'], pathScope: 'none', risk: 'dynamic' },
  shell_session: {
    effects: ['shell.execute', 'process.control'],
    pathScope: 'none',
    risk: 'dynamic'
  },
  web_search: { effects: ['network.read'], pathScope: 'none' },
  run_code: { effects: [], pathScope: 'none' },
  todo_write: { effects: ['session.write'], pathScope: 'none' },
  stage_transition: { effects: ['session.write'], pathScope: 'none' },
  askQuestion: { effects: ['session.write'], pathScope: 'none' },
  load_tools: { effects: ['session.write'], pathScope: 'none' },
  save_plan: {
    effects: ['filesystem.write'],
    pathScope: 'workspace',
    planArtifact: true
  },
  switch_mode: { effects: ['mode.transition'], pathScope: 'none' },
  task: { effects: ['orchestration'], pathScope: 'none' },
  task_followup: { effects: ['orchestration'], pathScope: 'none' },
  batch_task: { effects: ['orchestration'], pathScope: 'none' },
  invoke_skill: { effects: ['orchestration'], pathScope: 'none' },
  agent_list: { effects: [], pathScope: 'none' },
  model_list: { effects: [], pathScope: 'none' }
}

export function getToolPermissionDescriptor(
  toolName: string
): ToolPermissionDescriptor | undefined {
  return DESCRIPTORS[toolName]
}

/** 含 filesystem.write 或 shell.execute 即视为写能力，供子代理 profile 收窄。 */
export function toolHasWriteCapability(toolName: string): boolean {
  const descriptor = getToolPermissionDescriptor(toolName)
  if (!descriptor) return false
  return (
    descriptor.effects.includes('filesystem.write') ||
    descriptor.effects.includes('shell.execute')
  )
}

const READ_ONLY_FORBIDDEN_EFFECTS = new Set<ToolEffect>([
  'filesystem.write',
  'shell.execute',
  'process.control',
  'orchestration'
])

export function effectsExceedCapabilityCeiling(
  effects: readonly ToolEffect[],
  ceiling: PermissionCapabilityCeiling | null | undefined
): boolean {
  return ceiling === 'read_only' && effects.some(effect => READ_ONLY_FORBIDDEN_EFFECTS.has(effect))
}

export function isToolAvailableWithinCapabilityCeiling(
  toolName: string,
  ceiling: PermissionCapabilityCeiling | null | undefined
): boolean {
  if (ceiling !== 'read_only') return true
  const descriptor = getToolPermissionDescriptor(toolName)
  if (!descriptor) return false
  // shell_session 仍需暴露 read；write / interrupt / stop 会按动态 effects 被硬边界拒绝。
  if (toolName === 'shell_session') return true
  return !effectsExceedCapabilityCeiling(descriptor.effects, ceiling)
}
