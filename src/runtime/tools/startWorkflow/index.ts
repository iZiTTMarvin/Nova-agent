/**
 * AgentLoop 的显式编排入口。
 * 工具只负责校验调用参数并把当前 turn 的宿主能力交给 orchestrator。
 */
import type { ToolContext, ToolExecutor, ToolResult } from '../types'
import type { WorkflowOrchestrator } from '../../workflow'
import type { SpawnSubagentPort } from '../../subagents'
import { isReadablePlanInWorkspace, readPlanDocumentInWorkspace } from '../../plans'

export interface StartWorkflowToolDeps {
  getOrchestrator: () => WorkflowOrchestrator | undefined
  getSpawnSubagentPort: () => SpawnSubagentPort | undefined
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

function readActivePlanContext(context: ToolContext): Record<string, unknown> | undefined {
  if (!context.sessionStore || !context.sessionId) return undefined
  try {
    const session = context.sessionStore.load(context.sessionId)
    const activePlan = session?.activePlan
    if (!activePlan || !isReadablePlanInWorkspace(context.workingDir, activePlan.path)) {
      return undefined
    }
    const content = readPlanDocumentInWorkspace(context.workingDir, activePlan.path)
    if (!content) return undefined
    return {
      activePlan: {
        path: activePlan.path,
        title: activePlan.title,
        content
      }
    }
  } catch {
    return undefined
  }
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
          description: '工作流名称，必须取自系统提示中列出的可用工作流'
        },
        startStage: {
          type: 'string',
          description: '工作流的起始阶段名称，必须是该工作流已声明的起始阶段之一'
        },
        reason: {
          type: 'string',
          description: '本次编排要完成的用户请求与上下文'
        },
        runId: {
          type: 'string',
          description: '可选：恢复已有的中断或失败 workflow run；必须使用该 run 的原始 id'
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
      const runId = args.runId
      if (runId !== undefined && (typeof runId !== 'string' || runId.trim() === '')) {
        return failed('start_workflow 参数 runId 必须是非空字符串')
      }

      const orchestrator = deps.getOrchestrator()
      if (!orchestrator) return failed('start_workflow 当前不可用：编排器未装配')
      if (!context.eventBus) {
        return failed('start_workflow 当前不可用：AgentLoop 未提供完整工作流宿主能力')
      }
      if (!context.sessionId || !context.invocationRef) {
        return failed('start_workflow 当前不可用：缺少 durable tool invocation identity')
      }
      const spawnSubagentPort = deps.getSpawnSubagentPort()
      if (!spawnSubagentPort) {
        return failed('start_workflow 当前不可用：统一子代理执行端口未装配')
      }

      const injectedContext = readActivePlanContext(context)

      const outcome = await orchestrator.start({
        workflow: workflow.value,
        startStage: startStage.value,
        request: reason.value,
        autoMode: context.autoMode ?? false,
        abortSignal: context.abortSignal,
        ...(typeof runId === 'string' ? { runId: runId.trim() } : {}),
        ...(injectedContext ? { injectedContext } : {}),
        host: {
          workspaceRoot: context.workspaceRoot ?? context.workingDir,
          sessionId: context.sessionId,
          parentRunId: context.invocationRef.runId,
          parentMessageId: context.invocationRef.messageId,
          parentToolCallId: context.invocationRef.toolCallId,
          spawnSubagentPort,
          eventBus: context.eventBus,
          ...(context.checkpointManager ? { checkpointManager: context.checkpointManager } : {}),
          ...(context.supportsVision !== undefined ? { supportsVision: context.supportsVision } : {}),
          mode: context.mode ?? 'compose',
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
      return failed(
        `${outcome.error}${outcome.runId ? `（runId=${outcome.runId}）` : ''}`
      )
    }
  }
}
