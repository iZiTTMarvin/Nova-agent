import { relative } from 'path'
import type { ToolDefinition } from '../../model/types'
import { assessCommandRisk } from '../../permissions/rules'
import { resolveAndValidatePath } from '../../tools/ToolRegistry'
import { resolveToolArg } from '../../tools/toolArgResolver'
import {
  isPathAllowedByChangeScope,
  normalizeWorkspaceRelativePath
} from './changeScope'
import type { XForgeValidatedPlan } from './plan'
import type { XForgeStage } from './types'

export type XForgeToolEffect =
  | 'readonly'
  | 'workspace_write'
  | 'shell'
  | 'orchestration'
  | 'user_interaction'
  | 'unknown'

export interface XForgeToolExposureContext {
  stage: XForgeStage
  toolDefinitions: ToolDefinition[]
}

export interface XForgeToolAuthorizationContext {
  stage: XForgeStage
  workspaceRoot: string
  validatedPlan: XForgeValidatedPlan | null
  toolName: string
  args: Record<string, unknown>
}

export interface XForgeToolAuthorizationDecision {
  allowed: boolean
  reason: string
  effect: XForgeToolEffect
}

export interface XForgeVerificationPolicyDecision {
  allowed: boolean
  reason: string
}

const XFORGE_READ_TOOLS = new Set(['ls', 'read', 'grep', 'find', 'web_search', 'memory_search'])
const XFORGE_WRITE_TOOLS = new Set(['edit', 'write'])
const XFORGE_PRE_WRITE_STAGES = new Set<XForgeStage>(['resolve', 'brainstorm', 'plan', 'scope_check'])
const XFORGE_WRITE_STAGES = new Set<XForgeStage>(['implement', 'fix'])

const FORBIDDEN_XFORGE_SIDE_EFFECT_COMMAND =
  /(?:\bgit\b[^\r\n;&|]*\b(?:commit|push|reset|clean)\b|\b(?:npm|pnpm|yarn)\b[^\r\n;&|]*\b(?:publish|deploy)\b|\b(?:vercel|netlify|fly)\b[^\r\n;&|]*\bdeploy\b|\bkubectl\b[^\r\n;&|]*\b(?:apply|delete)\b|\bdocker\b[^\r\n;&|]*\bpush\b|\bgh\b[^\r\n;&|]*\brelease\s+create\b)/i

const VALIDATION_COMMAND_PATTERNS: readonly RegExp[] = [
  /^(?:npm|pnpm|yarn)(?:\.cmd)?\s+(?:test(?:\s+--.*)?|run\s+(?:test|typecheck|lint|build|validate)(?::[\w.-]+)?(?:\s+--.*)?)$/i,
  /^npx(?:\.cmd)?\s+(?:vitest|tsc|eslint|playwright)\b[^;&|<>`]*$/i,
  /^(?:python(?:\.exe)?\s+-m\s+)?(?:pytest|unittest)\b[^;&|<>`]*$/i,
  /^node(?:\.exe)?\s+--test\b[^;&|<>`]*$/i,
  /^cargo\s+(?:test|check|clippy)\b[^;&|<>`]*$/i,
  /^go\s+test\b[^;&|<>`]*$/i,
  /^dotnet\s+(?:test|build)\b[^;&|<>`]*$/i,
  /^(?:mvn|mvnw|\.\/mvnw)\s+(?:test|verify)\b[^;&|<>`]*$/i,
  /^(?:gradle|gradlew|\.\/gradlew)\s+(?:test|check|build)\b[^;&|<>`]*$/i,
  /^(?:make|cmake\s+--build\s+\S+\s+--target)\s+(?:test|check)\b[^;&|<>`]*$/i
]

export function getXForgeEffectiveToolDefinitions(
  context: XForgeToolExposureContext
): ToolDefinition[] {
  const visible = getVisibleXForgeMainAgentTools(context.stage)
  return context.toolDefinitions.filter(tool => visible.has(tool.name))
}

export function authorizeXForgeToolCall(
  context: XForgeToolAuthorizationContext
): XForgeToolAuthorizationDecision {
  const effect = getXForgeToolEffect(context.toolName)

  if (effect === 'unknown') {
    return deny(effect, `XForge 不允许调用未登记工具: ${context.toolName}`)
  }
  if (effect === 'user_interaction') {
    return deny(effect, 'XForge 用户交互只能由 Runtime 阶段控制器发起')
  }
  if (effect === 'orchestration') {
    return deny(effect, `XForge 主 Agent 不允许派遣编排工具: ${context.toolName}`)
  }
  if (effect === 'shell') {
    return deny(effect, 'XForge 主 Agent 不执行 shell；验证命令只能由 Runtime Test Gate 执行')
  }
  if (effect === 'readonly') {
    return allow(effect)
  }
  if (!XFORGE_WRITE_STAGES.has(context.stage)) {
    return deny(effect, `XForge ${context.stage} 阶段禁止写入工作区`)
  }

  const scopeFailure = validateWriteTargetInChangeScope(context)
  if (scopeFailure) return deny(effect, scopeFailure)
  return allow(effect)
}

export function getXForgeToolEffect(toolName: string): XForgeToolEffect {
  if (XFORGE_READ_TOOLS.has(toolName)) return 'readonly'
  if (XFORGE_WRITE_TOOLS.has(toolName)) return 'workspace_write'
  if (toolName === 'bash') return 'shell'
  if (toolName === 'task' || toolName === 'invoke_skill') return 'orchestration'
  if (toolName === 'askQuestion') return 'user_interaction'
  return 'unknown'
}

export function getVisibleXForgeMainAgentTools(stage: XForgeStage): ReadonlySet<string> {
  if (XFORGE_WRITE_STAGES.has(stage)) {
    return new Set([...XFORGE_READ_TOOLS, ...XFORGE_WRITE_TOOLS])
  }
  if (XFORGE_PRE_WRITE_STAGES.has(stage)) {
    return XFORGE_READ_TOOLS
  }
  return new Set()
}

export function getXForgeMainAgentModeInstruction(stage: XForgeStage): string {
  const visibleTools = [...getVisibleXForgeMainAgentTools(stage)].join('、') || '无'
  const canWrite = XFORGE_WRITE_STAGES.has(stage)
  const lines = [
    '[当前模式: XForge — BuildRail 阶段自适应顺序工作流]',
    `当前阶段：${stage}。模型本轮只会看到这些主 Agent 工具：${visibleTools}。`,
    canWrite
      ? '主 Agent 可以读取文件，并且只能在 validated changeScope 内调用 edit/write 修改工作区。'
      : '主 Agent 只能读取和分析工作区，不能调用 edit/write 修改文件。',
    '主 Agent 永远不能执行 bash、task、invoke_skill 或 askQuestion；测试、验证、用户提问和阶段推进由 Runtime 控制。',
    '质量门禁以 Runtime 受控命令结果、真实测试与隔离 Review 为准；模型自报通过不算过。',
    '不自动执行 git commit、push、deploy 或 publish；需要发布时须由用户确认。'
  ]
  return lines.join('\n')
}

export function authorizeXForgeVerificationCommand(command: string): XForgeVerificationPolicyDecision {
  const trimmed = command.trim()
  if (!trimmed) return { allowed: false, reason: '验证命令为空' }
  if (isForbiddenXForgeSideEffectCommand(trimmed)) {
    return { allowed: false, reason: `拒绝非验证或高风险命令: ${command}` }
  }
  if (/[;&|<>`\r\n]/.test(trimmed)) {
    return { allowed: false, reason: `拒绝 shell 组合命令: ${command}` }
  }
  if (!VALIDATION_COMMAND_PATTERNS.some(pattern => pattern.test(trimmed))) {
    return { allowed: false, reason: `拒绝非验证命令: ${command}` }
  }
  if (assessCommandRisk(trimmed).isDangerous) {
    return { allowed: false, reason: `拒绝高风险验证命令: ${command}` }
  }
  return { allowed: true, reason: '' }
}

export function isForbiddenXForgeSideEffectCommand(command: string): boolean {
  return FORBIDDEN_XFORGE_SIDE_EFFECT_COMMAND.test(command.trim())
}

export function isSafeRuntimeTestCommand(command: string): boolean {
  return authorizeXForgeVerificationCommand(command).allowed
}

function validateWriteTargetInChangeScope(context: XForgeToolAuthorizationContext): string | null {
  if (!context.validatedPlan) return 'XForge 写入前缺少 Validated Plan'
  const inputPath = resolveToolArg(context.args, 'path')
  if (!inputPath) return `XForge ${context.toolName} 缺少 path 参数`

  const resolved = resolveAndValidatePath(context.workspaceRoot, inputPath)
  if (!resolved.ok) return resolved.error

  const relativePath = normalizeWorkspaceRelativePath(
    relative(context.workspaceRoot, resolved.path)
  )
  if (!isPathAllowedByChangeScope(relativePath, context.validatedPlan.changeScope)) {
    return `XForge 写入越过 changeScope: ${relativePath}`
  }
  return null
}

function allow(effect: XForgeToolEffect): XForgeToolAuthorizationDecision {
  return { allowed: true, reason: '', effect }
}

function deny(effect: XForgeToolEffect, reason: string): XForgeToolAuthorizationDecision {
  return { allowed: false, reason, effect }
}
