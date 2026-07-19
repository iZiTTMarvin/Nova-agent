import type { RunCoordinator } from '../../../../../src/runtime/run/RunCoordinator'
import type { XForgeRunService } from '../../../../../src/runtime/workflow/xforge/XForgeRunService'
import type { XForgeRunCommitter } from '../../../../../src/runtime/workflow/xforge/runState'

let nextGeneration = 1

export function bindXForgeTestExecution(
  service: XForgeRunService,
  coordinator: RunCoordinator,
  runId: string
): XForgeRunCommitter {
  const current = coordinator.getSnapshot(runId)?.executionGeneration
  const generation = current && current > 0 ? current : nextGeneration++
  if (!current) coordinator.bindExecutionGeneration(runId, generation)
  return service.createExecutionCommitter(generation)
}
