import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createRunCoordinator } from '../../../../src/runtime/run'
import { SessionStore } from '../../../../src/runtime/sessions'
import { SubagentDeliveryCoordinator } from '../../../../src/runtime/subagents'
import type { RuntimeInputBlock } from '../../../../src/shared/session/types'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'nova-delivery-'))
  roots.push(root)
  const sessionStore = new SessionStore(root)
  const parent = sessionStore.create(root)
  const coordinator = createRunCoordinator(join(root, 'runs'))
  const parentRun = coordinator.startRun({
    kind: 'agent', runId: 'parent-active', workspaceId: root, sessionId: parent.id
  })
  coordinator.markRunning(parentRun.runId, 'parent-message')
  coordinator.upsertTurnDraft(parentRun.runId, {
    messageId: 'parent-message', attemptId: 'attempt', blocks: [], finalized: false
  })
  const active = new Set<string>()

  const addSource = (index: number, summary = `result-${index}`) => {
    const child = sessionStore.create(root)
    const runId = `child-${String(index).padStart(2, '0')}`
    coordinator.startRun({
      kind: 'agent', runId, workspaceId: root, sessionId: child.id,
      dispatch: {
        version: 1,
        callKind: 'task',
        parentSessionId: parent.id,
        parentRunId: parentRun.runId,
        parentMessageId: 'parent-message',
        execution: 'background_read_only',
        topParentSessionId: parent.id,
        originUserMessageId: 'user-message'
      }
    })
    coordinator.markRunning(runId, `child-message-${index}`)
    sessionStore.appendMessageFast(child.id, {
      id: `child-message-${index}`,
      role: 'assistant',
      content: summary,
      timestamp: index + 1
    })
    coordinator.commitTerminal({
      runId,
      status: 'completed',
      terminalTransitionId: `terminal-${index}`
    })
    return runId
  }

  const delivery = new SubagentDeliveryCoordinator({
    runCoordinator: coordinator,
    sessionStore,
    isRunExecutionActive: runId => active.has(runId)
  })
  const persisted: RuntimeInputBlock[] = []
  const receiver = delivery.createActiveTurnReceiver({
    sessionId: parent.id,
    runId: () => parentRun.runId,
    persistence: {
      persist: (messageId, input) => {
        const blocks = [...(coordinator.getSnapshot(parentRun.runId)?.turnDraft?.blocks ?? []), input]
        coordinator.upsertTurnDraft(parentRun.runId, {
          messageId,
          attemptId: 'attempt',
          blocks,
          finalized: false
        })
        coordinator.updateDeliveryBinding(input.sourceRunId, {
          boundRunId: parentRun.runId,
          boundSessionId: parent.id
        })
        persisted.push(input)
        return { notificationId: input.notificationId }
      }
    }
  })
  return { addSource, active, coordinator, delivery, parent, persisted, receiver }
}

describe('SubagentDeliveryCoordinator', () => {
  it('终态先到但执行句柄未释放时不交付，settled 后在同一持久事实链接收', async () => {
    const fixture = setup()
    const runId = fixture.addSource(1)
    fixture.active.add(runId)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)

    expect(await fixture.receiver.receive({ messageId: 'parent-message', afterStep: -1 })).toEqual([])
    fixture.active.delete(runId)
    fixture.delivery.noteExecutionSettled(runId)
    const received = await fixture.receiver.receive({ messageId: 'parent-message', afterStep: -1 })

    expect(received).toHaveLength(1)
    expect(fixture.persisted).toMatchObject([{
      sourceRunId: runId,
      afterStep: -1,
      order: 0
    }])
    expect(fixture.coordinator.getSnapshot(runId)?.deliveryBinding).toMatchObject({
      boundRunId: 'parent-active',
      boundSessionId: fixture.parent.id
    })
  })

  it('每 turn 最多接收三批，每批不超过八项和八千字符', async () => {
    const fixture = setup()
    for (let index = 0; index < 30; index++) fixture.addSource(index, 'x'.repeat(2_000))
    for (const snapshot of fixture.coordinator.listDispatchSnapshots()) {
      fixture.delivery.noteTerminal(snapshot)
    }

    const batchSizes: number[] = []
    for (let step = 0; step < 4; step++) {
      const before = fixture.persisted.length
      await fixture.receiver.receive({ messageId: 'parent-message', afterStep: step })
      batchSizes.push(fixture.persisted.length - before)
    }

    expect(batchSizes.slice(0, 3).every(size => size > 0 && size <= 8)).toBe(true)
    expect(batchSizes[3]).toBe(0)
    for (let step = 0; step < 3; step++) {
      const chars = fixture.persisted
        .filter(input => input.afterStep === step)
        .reduce((sum, input) => sum + input.content.length, 0)
      expect(chars).toBeLessThanOrEqual(8_000)
    }
  })
})
