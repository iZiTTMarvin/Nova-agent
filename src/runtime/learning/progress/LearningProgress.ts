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
  readonly rubricJson: string
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

  async submitAssessment(input: {
    workspaceRoot: string
    sessionId: string
    runId: string
    cursorVersion: number
    submissionJson: string
  }): Promise<{ assessmentId: string }> {
    return this.repo.submitAssessment({ ...input, createdAt: Date.now() })
  }

  getLearningContext(input: {
    workspaceRoot: string
    sessionId: string
    nodeId?: string
    page: number
  }): Promise<unknown> {
    return this.repo.getLearningContext(input)
  }

  getCursor(workspaceRoot: string, sessionId: string) {
    return this.repo.getCursor(workspaceRoot, sessionId)
  }

  getPendingOutbox(sessionId: string) {
    return this.repo.getPendingOutbox(sessionId)
  }

  markOutboxDelivered(commandId: string) {
    return this.repo.markOutboxDelivered(commandId)
  }
}

let defaultProgress: LearningProgress | null = null

export function getDefaultLearningProgress(): LearningProgress | null {
  return defaultProgress
}

export function setDefaultLearningProgress(progress: LearningProgress | null): void {
  defaultProgress = progress
}
