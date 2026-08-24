import { randomUUID } from 'crypto'
import type { PlanReviewResolution } from '../../../shared/planReview'
import type { ToolInvocationRef } from '../../../runtime/tools/types'

interface PlanReviewWaiter {
  ref: ToolInvocationRef
  resolve: (resolution: PlanReviewResolution) => void
}

function sameRef(left: ToolInvocationRef, right: ToolInvocationRef): boolean {
  return left.sessionId === right.sessionId &&
    left.runId === right.runId &&
    left.messageId === right.messageId &&
    left.toolCallId === right.toolCallId
}

class PlanReviewWaiters {
  private readonly entries = new Map<string, PlanReviewWaiter>()

  create(ref: ToolInvocationRef): {
    interactionId: string
    promise: Promise<PlanReviewResolution>
  } {
    const interactionId = randomUUID()
    const promise = new Promise<PlanReviewResolution>((resolve) => {
      this.entries.set(interactionId, { ref, resolve })
    })
    return { interactionId, promise }
  }

  has(interactionId: string, ref: ToolInvocationRef): boolean {
    const entry = this.entries.get(interactionId)
    return !!entry && sameRef(entry.ref, ref)
  }

  resolve(interactionId: string, resolution: PlanReviewResolution): boolean {
    const entry = this.entries.get(interactionId)
    if (!entry) return false
    this.entries.delete(interactionId)
    entry.resolve(resolution)
    return true
  }

  cancel(interactionId: string): boolean {
    return this.resolve(interactionId, { decision: 'ignore' })
  }

  cancelForRun(runId: string): void {
    for (const [interactionId, entry] of this.entries) {
      if (entry.ref.runId === runId) this.cancel(interactionId)
    }
  }

  cancelForSession(sessionId: string): void {
    for (const [interactionId, entry] of this.entries) {
      if (entry.ref.sessionId === sessionId) this.cancel(interactionId)
    }
  }
}

export const planReviewWaiters = new PlanReviewWaiters()
