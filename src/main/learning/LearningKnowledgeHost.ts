import type { ModelClient } from '../../runtime/model/ModelClient'
import type { LearningBuildState } from '../../shared/learning/surface'
import { SkeletonKnowledgeBuild } from '../../runtime/learning/build/SkeletonKnowledgeBuild'
import { isAgentTurnInProgress } from '../agent/state'
import { getRunCoordinator } from '../services/RunCoordinatorHost'
import { getWorkspaceService } from '../services/WorkspaceService'
import { ensureLearningDatabaseReady, getLearningKnowledgeReaderOrNull, getLearningKnowledgeOrNull } from './LearningDbHost'

const states = new Map<string, LearningBuildState>()
let active: { workspaceRoot: string; controller: AbortController; finished: Promise<void> } | null = null

export function getLearningBuildState(workspaceRoot: string): LearningBuildState {
  return states.get(workspaceRoot) ?? { status: 'idle' }
}

export async function buildLearningKnowledge(workspaceRoot: string, model: ModelClient | null, changed: () => void): Promise<void> {
  if (active) throw new Error('已有教材正在整理，请等待或取消后再试')
  if (isAgentTurnInProgress()) throw new Error('请等待当前任务结束后再整理教材')
  if (!model) throw new Error('请先配置模型；已保存的教材仍可离线查看')
  const controller = new AbortController()
  let finish!: () => void
  const finished = new Promise<void>(resolve => { finish = resolve })
  active = { workspaceRoot, controller, finished }
  const unsubscribe = getRunCoordinator().subscribe(() => {
    if (isAgentTurnInProgress()) controller.abort(new Error('前台任务开始，教材整理已暂停'))
  })
  const unsubscribeWorkspace = getWorkspaceService().subscribeWorkspaceRootChanges(change => {
    if (change.previousRoot === workspaceRoot && change.nextRoot !== workspaceRoot) controller.abort()
  })
  states.set(workspaceRoot, { status: 'running' })
  changed()
  try {
    await ensureLearningDatabaseReady()
    const knowledge = getLearningKnowledgeOrNull()
    const reader = getLearningKnowledgeReaderOrNull()
    if (!knowledge || !reader) throw new Error('学习数据库未就绪')
    controller.signal.throwIfAborted()
    const result = await new SkeletonKnowledgeBuild().run({ workspaceRoot, modelClient: model, knowledge, reader, signal: controller.signal })
    if (!result.ok) throw new Error(result.reason)
    states.set(workspaceRoot, { status: 'ready' })
  } catch (error) {
    states.set(workspaceRoot, controller.signal.aborted
      ? { status: 'cancelled' }
      : { status: 'failed', message: error instanceof Error ? error.message : String(error) })
  } finally {
    unsubscribe()
    unsubscribeWorkspace()
    active = null
    finish()
    changed()
  }
}

export function cancelLearningBuild(workspaceRoot: string): void {
  if (active?.workspaceRoot === workspaceRoot) active.controller.abort()
}

export async function shutdownLearningKnowledge(): Promise<void> {
  active?.controller.abort()
  await active?.finished
  states.clear()
}
