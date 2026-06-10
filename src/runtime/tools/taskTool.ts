/**
 * task 工具 — 启动隔离子代理执行子任务
 * 三层隔离：ToolRegistry / PermissionManager / CheckpointManager（子代理不注入 checkpoint）
 */
import { AgentLoop } from '../agent/AgentLoop'
import { EventBus } from '../agent/EventBus'
import { SystemPromptBuilder } from '../agent/SystemPromptBuilder'
import { getSubAgentSpec } from '../agent/SubAgentConfig'
import type { ModelClient } from '../model/ModelClient'
import { PermissionManager } from '../permissions/PermissionManager'
import type { Mode } from '../../shared/session/types'
import type { ToolExecutor, ToolContext, ToolResult } from './types'
import { ToolRegistry } from './ToolRegistry'
import { defaultSubAgentPermissionBridge, type SubAgentPermissionBridge } from './subAgentBridge'

const BASE_RULES_MINIMAL = '遵守工具结果，简洁汇报。你是子代理，不要反问父 agent。'

export interface TaskToolDeps {
  modelClient: ModelClient
  /** 父 agent 事件总线（仅转发 permission_request 等到 UI） */
  parentEventBus: EventBus
  /** 从父注册表按名取工具定义 */
  resolveTool: (name: string) => ToolExecutor | undefined
  contextWindow?: number
  supportsVision?: boolean
  /** 子代理权限桥接（默认单例，可注入独立实例以隔离多 session） */
  permissionBridge?: SubAgentPermissionBridge
}

/** 子代理类型 → 权限模式（explore 强制只读） */
function subAgentMode(subagentType: string): Mode {
  return subagentType === 'explore' ? 'plan' : 'default'
}

/**
 * 创建 task 子代理工具
 * @param deps 父 agent 依赖注入
 */
export function createTaskTool(deps: TaskToolDeps): ToolExecutor {
  return {
    name: 'task',
    description: '启动子代理完成子任务。子代理在干净上下文中运行，结果以摘要形式返回。',
    parameters: {
      type: 'object',
      properties: {
        subagent_type: { type: 'string', description: '子代理类型，如 explore / code' },
        task: { type: 'string', description: '子任务描述' }
      },
      required: ['subagent_type', 'task']
    },
    executionMode: 'sequential',
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const subagentType = String(args.subagent_type ?? '')
      const task = String(args.task ?? '')
      const spec = getSubAgentSpec(subagentType)
      if (!spec) {
        return { success: false, output: '', error: `未知子代理类型: ${subagentType}` }
      }

      // 1. 隔离 ToolRegistry
      const subRegistry = new ToolRegistry()
      for (const toolName of spec.allowedTools) {
        const tool = deps.resolveTool(toolName)
        if (tool) subRegistry.register(tool)
      }

      const toolSummary = subRegistry.getToolDefinitions()
        .map(t => `- ${t.name}: ${t.description.split('\n')[0]}`)
        .join('\n')

      const frozenPrompt = SystemPromptBuilder.build({
        agentRole: spec.prompt,
        baseRules: BASE_RULES_MINIMAL,
        projectRules: null,
        skillContext: '',
        modeInstruction: 'You are a sub-agent. Be concise. Return a structured summary.',
        toolSummary
      })

      // 2. 隔离 EventBus + PermissionManager
      const subBus = new EventBus()
      const subPermission = new PermissionManager()
      const permissionBridge = deps.permissionBridge ?? defaultSubAgentPermissionBridge
      let summary = ''
      let subMessageId = ''

      let subLoop!: AgentLoop

      const unsub = subBus.on((event) => {
        if (event.type === 'message_start') {
          subMessageId = event.messageId
        }
        if (event.type === 'text_delta' && event.messageId === subMessageId) {
          summary += event.delta
        }
        // 权限请求：绑定子循环后用 sub: 前缀转发，与父 agent 的 requestId 命名空间隔离
        if (event.type === 'permission_request') {
          const bridgedId = permissionBridge.bind(event.requestId, subLoop)
          deps.parentEventBus.emit({ ...event, requestId: bridgedId })
        }
      })

      subLoop = new AgentLoop(deps.modelClient, subBus, {
        systemPrompt: frozenPrompt,
        maxToolRounds: spec.maxToolRounds ?? 20,
        contextWindow: spec.contextWindow ?? deps.contextWindow,
        supportsVision: deps.supportsVision ?? true,
        toolExecution: 'sequential'
      })

      subLoop.setWorkingDir(ctx.workingDir)
      subLoop.setToolRegistry(subRegistry)
      subLoop.setPermissionManager(subPermission)
      subLoop.setMode(subAgentMode(subagentType))
      if (ctx.shellPath || ctx.binDirs) {
        subLoop.setBashEnvironment({ shellPath: ctx.shellPath, binDirs: ctx.binDirs })
      }

      // 3. checkpoint 隔离：不注入 checkpointManager
      try {
        await subLoop.sendMessage(task)
      } finally {
        unsub()
        permissionBridge.clearForLoop(subLoop)
      }

      if (!summary.trim()) {
        summary = subLoop.getState() === 'error' ? '子代理执行出错' : '子代理未产生文本输出'
      }

      return {
        success: subLoop.getState() !== 'error',
        output: `[子代理 ${subagentType} / ${subMessageId || 'unknown'}]\n${summary.trim()}`
      }
    }
  }
}
