import { resolve } from 'path'
import type { PermissionMode } from '../shared/session/types'
import { resolveHeadlessMaxToolRounds } from './roundBudget'

export interface CliOptions {
  workdir: string
  logsDir: string
  model: string
  baseUrl: string
  /** 显式指定的权限模式；headless 无默认值，缺参即启动失败。 */
  permissionMode: PermissionMode
  reasoningEffort: 'low' | 'medium' | 'high' | 'max'
  maxToolRounds: number
  deadlineSeconds?: number
  instructionFile?: string
  /** 显式上下文窗口覆盖；缺省时由模型元数据解析 */
  contextWindow?: number
  economyTaskMode?: boolean
  heavyTaskMode?: boolean
  taskCategory?: string
  taskTags?: string[]
  /** 强制开启工具分组过滤（即使任务分级不是 economy） */
  toolEconomy?: boolean
  /** 显式启用本次运行的本地代码索引。 */
  codeGraph?: boolean
  evaluationCase?: string
}

export const PERMISSION_MODE_CHOICES: readonly PermissionMode[] = [
  'request_approval',
  'auto',
  'full_access'
]

export const MISSING_PERMISSION_MODE_ERROR = [
  '错误：必须显式指定 --permission-mode',
  `可选值：${PERMISSION_MODE_CHOICES.join(' | ')}`,
  'Headless 不存在交互式授权通道，权限模式不能猜测默认值。'
].join('\n')

function parseArgs(argv: string[]): CliOptions {
  const supported = new Set([
    'workdir',
    'logs-dir',
    'model',
    'base-url',
    'permission-mode',
    'reasoning-effort',
    'max-tool-rounds',
    'deadline-seconds',
    'instruction-file',
    'context-window',
    'economy-task-mode',
    'heavy-task-mode',
    'task-category',
    'task-tags',
    'tool-economy',
    'code-graph',
    'evaluation-case'
  ])
  const flagOnly = new Set([
    'economy-task-mode',
    'heavy-task-mode',
    'tool-economy',
    'code-graph'
  ])
  const values = new Map<string, string>()
  const flags = new Set<string>()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) throw new Error(`无法识别的参数: ${arg}`)
    const name = arg.slice(2)
    if (!supported.has(name)) throw new Error(`无法识别的参数: ${arg}`)
    if (flagOnly.has(name)) {
      flags.add(name)
      continue
    }
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少值`)
    values.set(name, value)
    i += 1
  }

  const permissionModeValue = values.get('permission-mode')
  if (permissionModeValue === undefined) {
    throw new Error(MISSING_PERMISSION_MODE_ERROR)
  }
  if (!PERMISSION_MODE_CHOICES.includes(permissionModeValue as PermissionMode)) {
    throw new Error(
      `不支持的 --permission-mode: ${permissionModeValue}\n可选值：${PERMISSION_MODE_CHOICES.join(' | ')}`
    )
  }

  const workdir = resolve(values.get('workdir') ?? process.cwd())
  const logsDir = resolve(values.get('logs-dir') ?? resolve(workdir, '.nova-headless'))
  const effort = values.get('reasoning-effort') ?? 'max'
  if (!['low', 'medium', 'high', 'max'].includes(effort)) {
    throw new Error(`不支持的 reasoning effort: ${effort}`)
  }
  const deadlineValue = values.get('deadline-seconds')
  const deadlineSeconds = deadlineValue === undefined ? undefined : Number(deadlineValue)
  if (deadlineSeconds !== undefined && (!Number.isFinite(deadlineSeconds) || deadlineSeconds <= 0)) {
    throw new Error('--deadline-seconds 必须是正数')
  }
  const maxToolRounds = resolveHeadlessMaxToolRounds(
    values.get('max-tool-rounds'),
    deadlineSeconds
  )
  const contextWindowValue = values.get('context-window')
  const contextWindow = contextWindowValue === undefined ? undefined : Number(contextWindowValue)
  if (contextWindow !== undefined && (!Number.isInteger(contextWindow) || contextWindow <= 0)) {
    throw new Error('--context-window 必须是正整数')
  }
  const evaluationCase = values.get('evaluation-case')
  if (evaluationCase !== undefined && (evaluationCase.trim().length === 0 || evaluationCase.length > 512)) {
    throw new Error('--evaluation-case 必须是 1 到 512 个字符')
  }

  const taskTagsRaw = values.get('task-tags')
  const taskTags = taskTagsRaw
    ? taskTagsRaw.split(',').map(t => t.trim()).filter(Boolean)
    : undefined

  return {
    workdir,
    logsDir,
    model: values.get('model') ?? 'deepseek-v4-flash',
    baseUrl: values.get('base-url') ?? 'https://api.deepseek.com',
    permissionMode: permissionModeValue as PermissionMode,
    reasoningEffort: effort as CliOptions['reasoningEffort'],
    maxToolRounds,
    ...(deadlineSeconds === undefined ? {} : { deadlineSeconds }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(values.get('instruction-file')
      ? { instructionFile: resolve(values.get('instruction-file')!) }
      : {}),
    ...(flags.has('economy-task-mode') ? { economyTaskMode: true } : {}),
    ...(flags.has('heavy-task-mode') ? { heavyTaskMode: true } : {}),
    ...(values.get('task-category') ? { taskCategory: values.get('task-category') } : {}),
    ...(taskTags ? { taskTags } : {}),
    ...(flags.has('tool-economy') ? { toolEconomy: true } : {}),
    ...(flags.has('code-graph') ? { codeGraph: true } : {}),
    ...(evaluationCase === undefined ? {} : { evaluationCase })
  }
}

export { parseArgs }
