/**
 * runSkillFork — slash / tool 触发的 skill 子 agent 执行
 * 复用 taskTool 的隔离模式（ToolRegistry / PermissionManager / subAgentBridge）
 */
import { AgentLoop } from '../agent/AgentLoop'
import { EventBus } from '../agent/EventBus'
import { SystemPromptBuilder } from '../agent/SystemPromptBuilder'
import type { ModelClient } from '../model/ModelClient'
import { PermissionManager } from '../permissions/PermissionManager'
import type { Mode } from '../../shared/session/types'
import type { SkillManifest } from './types'
import { ToolRegistry } from '../tools/ToolRegistry'
import type { ToolExecutor, ToolContext } from '../tools/types'
import { defaultSubAgentPermissionBridge } from '../tools/subAgentBridge'
import { expandTemplate } from './template'
import type { TemplateContext } from './types'

const BASE_RULES_MINIMAL = '遵守工具结果，简洁汇报。你是技能子代理，不要反问父 agent。'

export interface RunSkillForkDeps {
  modelClient: ModelClient
  parentEventBus: EventBus
  resolveTool: (name: string) => ToolExecutor | undefined
  contextWindow?: number
  supportsVision?: boolean
}

export interface RunSkillForkParams {
  skill: SkillManifest
  args: string
  ctx: ToolContext
  templateContext?: TemplateContext
}

/**
 * 在隔离子循环中执行 fork skill，返回摘要文本
 */
export async function runSkillFork(
  deps: RunSkillForkDeps,
  params: RunSkillForkParams
): Promise<{ success: boolean; summary: string }> {
  const { skill, args, ctx, templateContext = {} } = params
  const { content: skillBody } = expandTemplate(skill.body, {
    ...templateContext,
    arguments: args
  })

  const forbidden = new Set(skill.forbiddenTools ?? [])
  const allowed = skill.allowedTools

  const subRegistry = new ToolRegistry()
  if (allowed && allowed.length > 0) {
    for (const toolName of allowed) {
      const tool = deps.resolveTool(toolName)
      if (tool) subRegistry.register(tool)
    }
  } else {
    // 未声明白名单时继承父注册表（排除 forbidden）
    for (const name of ['ls', 'read', 'grep', 'find', 'edit', 'write', 'bash', 'todo_write']) {
      if (forbidden.has(name)) continue
      const tool = deps.resolveTool(name)
      if (tool) subRegistry.register(tool)
    }
  }

  const toolSummary = subRegistry.getToolDefinitions()
    .map(t => `- ${t.name}: ${t.description.split('\n')[0]}`)
    .join('\n')

  const frozenPrompt = SystemPromptBuilder.build({
    agentRole: skillBody,
    baseRules: BASE_RULES_MINIMAL,
    projectRules: null,
    skillContext: '',
    modeInstruction: 'You are a skill sub-agent. Be concise. Return a structured summary.',
    toolSummary
  })

  const subBus = new EventBus()
  const subPermission = new PermissionManager()
  let summary = ''
  let subMessageId = ''
  let subLoop!: AgentLoop

  const unsub = subBus.on((event) => {
    if (event.type === 'message_start') subMessageId = event.messageId
    if (event.type === 'text_delta' && event.messageId === subMessageId) {
      summary += event.delta
    }
    if (event.type === 'permission_request') {
      const bridgedId = defaultSubAgentPermissionBridge.bind(event.requestId, subLoop)
      deps.parentEventBus.emit({ ...event, requestId: bridgedId })
    }
  })

  subLoop = new AgentLoop(deps.modelClient, subBus, {
    systemPrompt: frozenPrompt,
    maxToolRounds: 20,
    contextWindow: deps.contextWindow,
    supportsVision: deps.supportsVision ?? true,
    toolExecution: 'sequential'
  })

  subLoop.setWorkingDir(ctx.workingDir)
  subLoop.setToolRegistry(subRegistry)
  subLoop.setPermissionManager(subPermission)
  subLoop.setMode('default' as Mode)
  if (ctx.shellPath || ctx.binDirs) {
    subLoop.setBashEnvironment({ shellPath: ctx.shellPath, binDirs: ctx.binDirs })
  }
  // 隔离 readState：sub agent 拿主 readState 的深拷贝，避免它读过的文件污染主 agent 后续 edit 校验（I1）。
  subLoop.setReadState(ctx.readState.clone())

  const task = args.trim() || '按技能说明执行'
  try {
    await subLoop.sendMessage(task)
  } finally {
    unsub()
    defaultSubAgentPermissionBridge.clearForLoop(subLoop)
    // 释放 subLoop 资源：cancel() 在 idle 时空操作，dispose 才能停掉 idleTimer，
    // 避免 266 秒后技能子代理的 IdleCompressionTimer 触发后台压缩烧 token
    subLoop.dispose()
  }

  if (!summary.trim()) {
    summary = subLoop.getState() === 'error' ? '技能子代理执行出错' : '技能子代理未产生文本输出'
  }

  return {
    success: subLoop.getState() !== 'error',
    summary: `[技能 ${skill.name} / ${subMessageId || 'unknown'}]\n${summary.trim()}`
  }
}
