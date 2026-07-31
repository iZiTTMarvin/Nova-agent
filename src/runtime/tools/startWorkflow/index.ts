/**
 * AgentLoop 的显式编排入口。
 * 工具只负责校验调用参数并把当前 turn 的宿主能力交给 orchestrator。
 */
import type { ToolContext, ToolExecutor, ToolResult } from '../types'
import type { SkillManifest } from '../../skills/types'
import type { SubAgentPermissionBridge } from '../subAgentBridge'
import type { WorkflowOrchestrator } from '../../workflow/orchestrator'

export interface StartWorkflowToolDeps {
  getOrchestrator: () => WorkflowOrchestrator | undefined
  getPermissionBridge?: () => SubAgentPermissionBridge
  resolveSkill?: (name: string) => SkillManifest | undefined
}

function readRequiredString(
  args: Record<string, unknown>,
  name: string
): { value: string } | { error: string } {
  const value = args[name]
  if (typeof value !== 'string' || value.trim() === '') {
    return { error: `start_workflow 参数 ${name} 必须是非空字符串` }
  }
  return { value: value.trim() }
}

function failed(error: string): ToolResult {
  return { success: false, output: '', error }
}

export function createStartWorkflowTool(deps: StartWorkflowToolDeps): ToolExecutor {
  return {
    name: 'start_workflow',
    description: '启动一个已注册的多阶段工作流。仅在 compose 模式下使用。',
    parameters: {
      type: 'object',
      properties: {
        workflow: {
          type: 'string',
          description: '工作流名称，例如 compose'
        },
        startStage: {
          type: 'string',
          description: '工作流的起始阶段名称'
        },
        reason: {
          type: 'string',
          description: '本次编排要完成的用户请求与上下文'
        }
      },
      required: ['workflow', 'startStage', 'reason'],
      additionalProperties: false
    },
    async execute(args, context): Promise<ToolResult> {
      const workflow = readRequiredString(args, 'workflow')
      if ('error' in workflow) return failed(workflow.error)
      const startStage = readRequiredString(args, 'startStage')
      if ('error' in startStage) return failed(startStage.error)
      const reason = readRequiredString(args, 'reason')
      if ('error' in reason) return failed(reason.error)

      const orchestrator = deps.getOrchestrator()
      if (!orchestrator) return failed('start_workflow 当前不可用：编排器未装配')
      if (!context.modelClient || !context.resolveTool || !context.eventBus) {
        return failed('start_workflow 当前不可用：AgentLoop 未提供完整工作流宿主能力')
      }

      const outcome = await orchestrator.start({
        workflow: workflow.value,
        startStage: startStage.value,
        request: reason.value,
        autoMode: context.autoMode ?? false,
        abortSignal: context.abortSignal,
        host: {
          workspaceRoot: context.workspaceRoot ?? context.workingDir,
          ...(context.sessionId ? { sessionId: context.sessionId } : {}),
          eventBus: context.eventBus,
          modelClient: context.modelClient,
          resolveTool: context.resolveTool,
          ...(deps.resolveSkill ? { resolveSkill: deps.resolveSkill } : {}),
          ...(context.checkpointManager ? { checkpointManager: context.checkpointManager } : {}),
          ...(context.contextWindow !== undefined ? { contextWindow: context.contextWindow } : {}),
          ...(context.supportsVision !== undefined ? { supportsVision: context.supportsVision } : {}),
          mode: context.mode ?? 'compose',
          ...(deps.getPermissionBridge
            ? { permissionBridge: deps.getPermissionBridge() }
            : {}),
          ...(context.askQuestion ? { askQuestion: context.askQuestion } : {}),
          ...(context.assertExecutionCurrent
            ? { assertExecutionCurrent: context.assertExecutionCurrent }
            : {})
        }
      })

      if (outcome.status === 'completed') {
        return { success: true, output: outcome.summary }
      }
      if (outcome.status === 'cancelled') {
        return failed(`工作流已取消（runId=${outcome.runId}）`)
      }
      return failed(outcome.error)
    }
  }
}

