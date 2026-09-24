import { ToolRegistry } from '../../../runtime/tools/ToolRegistry'
import { createLearningCheckpointTool } from '../../../runtime/tools/learning_checkpoint'
import { createLearningContextTool } from '../../../runtime/tools/learning_context'
import { createLearningAssessTool } from '../../../runtime/tools/learning_assess'

export function registerLearningTools(registry: ToolRegistry): void {
  registry.register(createLearningContextTool())
  registry.register(createLearningCheckpointTool())
  registry.register(createLearningAssessTool())
}
