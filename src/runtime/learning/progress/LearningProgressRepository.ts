import type { LearningCommand, LearningCommandReceipt } from '../../../shared/learning/command'
import { parseLearningCommandReceipt } from '../../../shared/learning/command'
import type { LearningDbWorkerClient } from '../storage/LearningDbWorkerClient'
import type { LearningDbWorkerOp, PersistedCheckpointView } from '../storage/workerCommand'

export class LearningProgressRepository {
  constructor(private readonly client: LearningDbWorkerClient) {}

  saveCheckpoint(params: {
    workspaceRoot: string
    sessionId: string
    runId: string
    checkpointId: string
    cursorVersion: number
    question: string
    rubricJson: string
    createdAt: number
  }): Promise<PersistedCheckpointView> {
    const command: LearningDbWorkerOp = {
      domain: 'progress',
      op: 'save_checkpoint',
      ...params
    }
    return this.client.invoke<PersistedCheckpointView>(command)
  }

  getCheckpoint(sessionId: string): Promise<PersistedCheckpointView | null> {
    return this.client.invoke<PersistedCheckpointView | null>({
      domain: 'progress',
      op: 'get_checkpoint',
      sessionId
    })
  }

  applyCommand(command: LearningCommand): Promise<LearningCommandReceipt> {
    return this.client
      .invoke<LearningCommandReceipt>({
        domain: 'progress',
        op: 'apply_command',
        command
      })
      .then(raw => parseLearningCommandReceipt(raw))
  }

  clearPersonal(workspaceRoot: string, sessionId: string): Promise<{ clearGeneration: number }> {
    return this.client.invoke({
      domain: 'progress',
      op: 'clear_personal',
      workspaceRoot,
      sessionId
    })
  }

  submitAssessment(params: {
    workspaceRoot: string
    sessionId: string
    runId: string
    cursorVersion: number
    submissionJson: string
    createdAt: number
  }): Promise<{ assessmentId: string }> {
    return this.client.invoke({
      domain: 'progress',
      op: 'submit_assessment',
      ...params
    })
  }

  getLearningContext(params: {
    workspaceRoot: string
    sessionId: string
    nodeId?: string
    page: number
  }): Promise<unknown> {
    return this.client.invoke({
      domain: 'progress',
      op: 'get_learning_context',
      ...params
    })
  }

  getCursor(workspaceRoot: string, sessionId: string): Promise<{
    cursorVersion: number
    clearGeneration: number
    selectedNodeId: string | null
  }> {
    return this.client.invoke({
      domain: 'progress',
      op: 'get_cursor',
      workspaceRoot,
      sessionId
    })
  }

  getPendingOutbox(sessionId: string): Promise<{
    command_id: string
    user_message_id: string
    payload_json: string
  } | null> {
    return this.client.invoke({
      domain: 'progress',
      op: 'get_pending_outbox',
      sessionId
    })
  }

  markOutboxDelivered(commandId: string): Promise<void> {
    return this.client
      .invoke({
        domain: 'progress',
        op: 'mark_outbox_delivered',
        commandId
      })
      .then(() => undefined)
  }
}
