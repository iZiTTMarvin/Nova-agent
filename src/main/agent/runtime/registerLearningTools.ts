import { ToolRegistry } from '../../../runtime/tools/ToolRegistry'
import { createLearningCheckpointTool } from '../../../runtime/tools/learning_checkpoint'
import { createLearningContextTool } from '../../../runtime/tools/learning_context'
import { createLearningAssessTool } from '../../../runtime/tools/learning_assess'
import type { LearningProgress } from '../../../runtime/learning/progress/LearningProgress'

export interface RegisterLearningToolsDeps {
  getProgress: () => LearningProgress | null
}

export function registerLearningTools(
  registry: ToolRegistry,
  deps?: RegisterLearningToolsDeps
): void {
  const getProgress = deps?.getProgress
  const toolDeps = getProgress ? { getProgress } : undefined
  registry.register(createLearningContextTool(toolDeps))
  registry.register(createLearningCheckpointTool(toolDeps))
  registry.register(createLearningAssessTool(toolDeps))
}
