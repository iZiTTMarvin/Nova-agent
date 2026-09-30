/**
 * 大纲生成的生产装配：把调度器接到前台运行状态、工作区切换、学习数据库与骨架构建。
 */
import type { ModelClient } from '../../runtime/model/ModelClient'
import type { LearningBuildState } from '../../shared/learning/surface'
import { SkeletonKnowledgeBuild } from '../../runtime/learning/build/SkeletonKnowledgeBuild'
import { isAgentTurnInProgress } from '../agent/state'
import { getRunCoordinator, getRunExecutionRegistry } from '../services/RunCoordinatorHost'
import { getWorkspaceService } from '../services/WorkspaceService'
import { ensureLearningDatabaseReady, getLearningKnowledgeReaderOrNull, getLearningKnowledgeOrNull } from './LearningDbHost'
import { LearningBuildScheduler } from './LearningBuildScheduler'

let scheduler: LearningBuildScheduler | null = null
let changedListener: ((workspaceRoot: string) => void) | null = null

export function setLearningBuildChangedListener(listener: ((workspaceRoot: string) => void) | null): void {
  changedListener = listener
}

function getScheduler(): LearningBuildScheduler {
  scheduler ??= new LearningBuildScheduler({
    isForegroundBusy: isAgentTurnInProgress,
    subscribeForeground: listener => {
      const unsubscribeSnapshot = getRunCoordinator().subscribe(() => listener())
      const unsubscribeExecution = getRunExecutionRegistry().subscribe(listener)
      return () => {
        unsubscribeSnapshot()
        unsubscribeExecution()
      }
    },
    subscribeWorkspaceChanges: listener => getWorkspaceService().subscribeWorkspaceRootChanges(listener),
    runBuild: async (workspaceRoot, model, signal, onStage) => {
      try {
        await ensureLearningDatabaseReady()
      } catch (error) {
        return { ok: false, code: 'storage_unavailable', reason: error instanceof Error ? error.message : String(error) }
      }
      const knowledge = getLearningKnowledgeOrNull()
      const reader = getLearningKnowledgeReaderOrNull()
      if (!knowledge || !reader) return { ok: false, code: 'storage_unavailable', reason: '学习数据库未就绪' }
      return new SkeletonKnowledgeBuild().run({ workspaceRoot, modelClient: model, knowledge, reader, signal, onProgress: onStage })
    },
    onChanged: workspaceRoot => changedListener?.(workspaceRoot)
  })
  return scheduler
}

export function getLearningBuildState(workspaceRoot: string): LearningBuildState {
  return scheduler?.getState(workspaceRoot) ?? { status: 'idle' }
}

/** 接纳即返回；进度与结果只经学习投影下发。 */
export function requestLearningBuild(workspaceRoot: string, model: ModelClient | null): void {
  getScheduler().request(workspaceRoot, model)
}

export function cancelLearningBuild(workspaceRoot: string): void {
  scheduler?.cancel(workspaceRoot)
}

export async function shutdownLearningKnowledge(): Promise<void> {
  scheduler?.dispose()
  scheduler = null
}
