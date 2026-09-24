import type { LearningCommand, LearningCommandReceipt } from '../../../shared/learning/command'
import { LearningProgressRepository } from './LearningProgressRepository'
import type { PersistedCheckpointView } from '../storage/workerCommand'

export interface LearningCheckpointPersistInput {
  readonly workspaceRoot: string
  readonly sessionId: string
  readonly runId: string
  readonly checkpointId: string
  readonly cursorVersion: number
  readonly question: string
}

export class LearningProgress {
  constructor(private readonly repo: LearningProgressRepository) {}

  async saveCheckpoint(input: LearningCheckpointPersistInput): Promise<PersistedCheckpointView> {
    return this.repo.saveCheckpoint({
      ...input,
      createdAt: Date.now()
    })
  }

  async getCheckpointForSession(sessionId: string): Promise<PersistedCheckpointView | null> {
    return this.repo.getCheckpoint(sessionId)
  }

  async applyCommand(command: LearningCommand): Promise<LearningCommandReceipt> {
    return this.repo.applyCommand(command)
  }

  async clearPersonalRecords(workspaceRoot: string, sessionId: string): Promise<number> {
    const result = await this.repo.clearPersonal(workspaceRoot, sessionId)
    return result.clearGeneration
  }
}

let defaultProgress: LearningProgress | null = null

export function getDefaultLearningProgress(): LearningProgress | null {
  return defaultProgress
}

export function setDefaultLearningProgress(progress: LearningProgress | null): void {
  defaultProgress = progress
}
