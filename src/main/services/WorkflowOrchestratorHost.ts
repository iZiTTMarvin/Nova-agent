/**
 * 主进程 WorkflowOrchestrator 单例宿主。
 *
 * orchestrator 是 workflow run 状态的唯一 Owner；主进程各处（入口互斥判断、停止按钮、
 * 后续的 start_workflow 工具）都必须经这里取同一个实例，不得各自 new。
 *
 * definition 解析器由应用启动时接入；本服务只保存单例 orchestrator 和解析端口，
 * 不拥有 definition 注册表。
 */
import { WorkflowOrchestrator, type ResolveWorkflowDefinition } from '../../runtime/workflow'

let orchestrator: WorkflowOrchestrator | null = null
let resolveDefinition: ResolveWorkflowDefinition = () => undefined

export function getWorkflowOrchestrator(): WorkflowOrchestrator {
  if (!orchestrator) {
    orchestrator = new WorkflowOrchestrator({
      resolveDefinition: (name) => resolveDefinition(name)
    })
  }
  return orchestrator
}

/** 注册 definition 解析器（注册表接入点）。 */
export function setWorkflowDefinitionResolver(resolver: ResolveWorkflowDefinition): void {
  resolveDefinition = resolver
}

/**
 * 该会话是否有运行中的编排。
 * 入口互斥的唯一判据：编排期间 turn 不释放，新消息不得进 steering queue。
 */
export function getActiveWorkflowRunForSession(
  sessionId: string
): { runId: string; workflow: string; phase: string } | null {
  const snap = getWorkflowOrchestrator().getActiveRunForSession(sessionId)
  if (!snap) return null
  return { runId: snap.runId, workflow: snap.workflow, phase: snap.phase }
}

/** 停止按钮：取消该会话所有运行中的编排（穿透到 TaskScope.close）。 */
export async function cancelWorkflowRunsForSession(sessionId: string): Promise<string[]> {
  return getWorkflowOrchestrator().cancelForSession(sessionId)
}

/** 测试用：重置单例与解析器 */
export function resetWorkflowOrchestratorHostForTests(): void {
  orchestrator = null
  resolveDefinition = () => undefined
}
