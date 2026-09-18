/**
 * SubagentDeliveryCoordinator 单测。
 *
 * 覆盖两条投递路径：活跃 turn 内的接收（drain / recheck / 单飞）与空闲会话的接力预约
 * （接纳幂等、链路预算、源资格分类、启动对账、回调时机）。
 * 状态一律走真实 RunCoordinator / RunStore / SessionStore 落盘，只有「源 run 是否仍有执行句柄」
 * 与「接收器持久化端口」是受控依赖；断电视窗用会抛错的依赖包装制造。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { RunCoordinator, RunStore } from '../../../../src/runtime/run'
import { SessionStore, type SessionData } from '../../../../src/runtime/sessions'
import {
  MAX_RELAY_TURNS_PER_CHAIN,
  SubagentDeliveryCoordinator,
  type ActiveSubagentDeliveryReceiver
} from '../../../../src/runtime/subagents'
import { deriveSubagentNotificationId } from '../../../../src/shared/run/types'
import type { RuntimeInputBlock } from '../../../../src/shared/session/types'

const roots: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface SourceOptions {
  readonly summary?: string
  readonly originUserMessageId?: string
}

interface DeliveryOptions {
  readonly onIdleRelayAvailable?: (sessionId: string) => void
}

interface Rebooted {
  readonly sessionStore: SessionStore
  readonly coordinator: RunCoordinator
  readonly delivery: SubagentDeliveryCoordinator
  readonly interrupted: string[]
}

interface Harness {
  readonly root: string
  readonly sessionStore: SessionStore
  readonly coordinator: RunCoordinator
  readonly parent: SessionData
  readonly parentRunId: string
  readonly active: Set<string>
  readonly delivery: SubagentDeliveryCoordinator
  readonly persisted: RuntimeInputBlock[]
  readonly receiver: ActiveSubagentDeliveryReceiver
  addSource(index: number, options?: SourceOptions): string
  note(runId: string): void
  makeDelivery(options?: DeliveryOptions): SubagentDeliveryCoordinator
  /** 制造崩溃窗口：在派生事实的某一步抛出，等价于进程在该步之前退出。 */
  makeCrashDelivery(step: 'binding' | 'message'): SubagentDeliveryCoordinator
  /** 按接纳时的持久格式落一个 queued 预约（可含绑定），用于表达「预约已落盘、派生事实未落盘」。 */
  seedQueuedReservation(sourceRunIds: string[], options?: { readonly bind?: boolean }): string
  reboot(options?: DeliveryOptions): Rebooted
}

function createHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), 'nova-delivery-'))
  roots.push(root)
  const runsRoot = join(root, 'runs')
  const sessionStore = new SessionStore(root)
  const parent = sessionStore.create(root)
  const coordinator = new RunCoordinator({ store: new RunStore({ runsRoot }) })
  const parentRun = coordinator.startRun({
    kind: 'agent', runId: 'parent-active', workspaceId: root, sessionId: parent.id
  })
  coordinator.markRunning(parentRun.runId, 'parent-message')
  coordinator.upsertTurnDraft(parentRun.runId, {
    messageId: 'parent-message', attemptId: 'attempt', blocks: [], finalized: false
  })
  const active = new Set<string>()

  const addSource = (index: number, options: SourceOptions = {}): string => {
    const child = sessionStore.create(root)
    const runId = `child-${String(index).padStart(2, '0')}`
    coordinator.startRun({
      kind: 'agent',
      runId,
      workspaceId: root,
      sessionId: child.id,
      dispatch: {
        version: 1,
        callKind: 'task',
        parentSessionId: parent.id,
        parentRunId: parentRun.runId,
        parentMessageId: 'parent-message',
        execution: 'background_read_only',
        topParentSessionId: parent.id,
        originUserMessageId: options.originUserMessageId ?? 'user-message'
      }
    })
    coordinator.markRunning(runId, `child-message-${index}`)
    sessionStore.appendMessageFast(child.id, {
      id: `child-message-${index}`,
      role: 'assistant',
      content: options.summary ?? `result-${index}`,
      timestamp: index + 1
    })
    coordinator.commitTerminal({
      runId,
      status: 'completed',
      terminalTransitionId: `terminal-${index}`
    })
    return runId
  }

  const makeDelivery = (options: DeliveryOptions = {}): SubagentDeliveryCoordinator =>
    new SubagentDeliveryCoordinator({
      runCoordinator: coordinator,
      sessionStore,
      isRunExecutionActive: runId => active.has(runId),
      ...(options.onIdleRelayAvailable ? { onIdleRelayAvailable: options.onIdleRelayAvailable } : {})
    })

  const persisted: RuntimeInputBlock[] = []
  const delivery = makeDelivery()
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

  const makeCrashDelivery = (step: 'binding' | 'message'): SubagentDeliveryCoordinator =>
    new SubagentDeliveryCoordinator({
      runCoordinator: step === 'binding'
        ? {
            getSnapshot: id => coordinator.getSnapshot(id),
            listDispatchSnapshots: () => coordinator.listDispatchSnapshots(),
            listRelayTriggerSnapshots: () => coordinator.listRelayTriggerSnapshots(),
            listSnapshotsForSession: id => coordinator.listSnapshotsForSession(id),
            startRun: params => coordinator.startRun(params),
            commitTerminal: params => coordinator.commitTerminal(params),
            updateDeliveryBinding: () => {
              throw new Error('process exited before binding persisted')
            }
          }
        : coordinator,
      sessionStore: step === 'message'
        ? {
            findRuntimeInputFact: (sessionId, notificationId) =>
              sessionStore.findRuntimeInputFact(sessionId, notificationId),
            findSubagentNotificationReceipt: (sessionId, notificationId) =>
              sessionStore.findSubagentNotificationReceipt(sessionId, notificationId),
            getControlIntent: id => sessionStore.getControlIntent(id),
            load: id => sessionStore.load(id),
            appendMessageFast: () => {
              throw new Error('process exited before relay message persisted')
            }
          }
        : sessionStore,
      isRunExecutionActive: runId => active.has(runId)
    })

  const seedQueuedReservation = (
    sourceRunIds: string[],
    options: { readonly bind?: boolean } = {}
  ): string => {
    const relayRunId = `relay-${sourceRunIds.join('-')}`
    const items = sourceRunIds.map(sourceRunId => {
      const source = coordinator.getSnapshot(sourceRunId)!
      return {
        notificationId: deriveSubagentNotificationId(sourceRunId, source.terminalTransitionId!),
        sourceRunId,
        content: `frozen-${sourceRunId}`
      }
    })
    const first = coordinator.getSnapshot(sourceRunIds[0])!
    coordinator.startRun({
      kind: 'agent',
      workspaceId: root,
      sessionId: parent.id,
      runId: relayRunId,
      messageId: `msg_relay_${relayRunId}`,
      relayTrigger: {
        version: 1,
        requestId: relayRunId,
        receiveMessageId: `msg_relay_${relayRunId}`,
        originUserMessageId: first.dispatch!.originUserMessageId ?? first.dispatch!.parentMessageId,
        anchorMessageId: null,
        items,
        createdAt: Date.now()
      }
    })
    if (options.bind !== false) {
      for (const item of items) {
        coordinator.updateDeliveryBinding(item.sourceRunId, {
          boundRunId: relayRunId,
          boundSessionId: parent.id
        })
      }
    }
    return relayRunId
  }

  const reboot = (options: DeliveryOptions = {}): Rebooted => {
    const nextSessionStore = new SessionStore(root)
    const nextCoordinator = new RunCoordinator({ store: new RunStore({ runsRoot }) })
    const interrupted = nextCoordinator.reconcileOnStartup().map(snapshot => snapshot.runId)
    const nextDelivery = new SubagentDeliveryCoordinator({
      runCoordinator: nextCoordinator,
      sessionStore: nextSessionStore,
      isRunExecutionActive: () => false,
      ...(options.onIdleRelayAvailable ? { onIdleRelayAvailable: options.onIdleRelayAvailable } : {})
    })
    return {
      sessionStore: nextSessionStore,
      coordinator: nextCoordinator,
      delivery: nextDelivery,
      interrupted
    }
  }

  return {
    root,
    sessionStore,
    coordinator,
    parent,
    parentRunId: parentRun.runId,
    active,
    delivery,
    persisted,
    receiver,
    addSource,
    note: runId => delivery.noteExecutionSettled(runId),
    makeDelivery,
    makeCrashDelivery,
    seedQueuedReservation,
    reboot
  }
}

function notificationOf(coordinator: RunCoordinator, runId: string): string {
  const snapshot = coordinator.getSnapshot(runId)!
  return deriveSubagentNotificationId(runId, snapshot.terminalTransitionId!)
}

function boundRunId(coordinator: RunCoordinator, runId: string): string | undefined {
  return coordinator.getSnapshot(runId)?.deliveryBinding?.boundRunId
}

function relayRuns(coordinator: RunCoordinator, sessionId: string) {
  return coordinator.listSnapshotsForSession(sessionId).filter(snapshot => snapshot.relayTrigger)
}

function relayMessages(sessionStore: SessionStore, sessionId: string) {
  return sessionStore.load(sessionId)!.messages.filter(message => message.id.startsWith('msg_relay_'))
}

describe('SubagentDeliveryCoordinator 活跃 turn 接收', () => {
  it('终态先到但执行句柄未释放时不交付，注销后在同一持久事实链接收', async () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    // terminal hook 先触发（句柄仍在册），noteTerminal 把候选加入 pending
    fixture.active.add(runId)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)

    // 活跃 turn receiver 检查时句柄仍在册 → 不交付
    expect(await fixture.receiver.receive({ messageId: 'parent-message', afterStep: -1 })).toEqual([])

    // 生产顺序：先注销句柄，再调 noteExecutionSettled
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

  it('receive 启动时无候选，drain 活跃期到来的终态通知在同一 receive 内交付', async () => {
    const fixture = createHarness()

    // 首次扫描必然为空，drain 已登记但尚未返回
    const pending = fixture.receiver.receive({ messageId: 'parent-message', afterStep: -1 })
    // 同一 receive 未结束前终态事实到达：必须重扫当前 drain，而不是等下一次 receive
    const runId = fixture.addSource(1)
    fixture.delivery.noteExecutionSettled(runId)

    const received = await pending

    expect(received).toHaveLength(1)
    expect(fixture.persisted).toMatchObject([{ sourceRunId: runId, afterStep: -1, order: 0 }])
  })

  it('单飞 drain：重入合并进同一 drain，持久化只执行一次', async () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.delivery.noteExecutionSettled(runId)

    let releasePersist!: () => void
    const gate = new Promise<void>(resolve => { releasePersist = resolve })
    const persisted: RuntimeInputBlock[] = []
    const slowReceiver = fixture.delivery.createActiveTurnReceiver({
      sessionId: fixture.parent.id,
      runId: () => 'parent-active',
      persistence: {
        persist: async (_messageId, input) => {
          persisted.push(input)
          await gate
          return { notificationId: input.notificationId }
        }
      }
    })

    const first = slowReceiver.receive({ messageId: 'parent-message', afterStep: 0 })
    // 第一次 drain 停在 persist：此时重入必须 join 同一 drain，不能各投一次
    const second = slowReceiver.receive({ messageId: 'parent-message', afterStep: 0 })
    releasePersist()

    expect(await second).toEqual([])
    const firstMessages = await first
    expect(firstMessages).toHaveLength(1)
    expect(persisted).toMatchObject([{ sourceRunId: runId }])
  })

  it('重启后从磁盘终态派遣事实重建索引', async () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)

    // 模拟重启：新 RunCoordinator 实例 + 新协调器实例读同一磁盘目录
    const reborn = fixture.reboot()
    expect(reborn.coordinator.listDispatchSnapshots().map(snapshot => snapshot.runId)).toContain(runId)

    const persisted: RuntimeInputBlock[] = []
    const receiver = reborn.delivery.createActiveTurnReceiver({
      sessionId: fixture.parent.id,
      runId: () => 'parent-active',
      persistence: {
        persist: (_messageId, input) => {
          persisted.push(input)
          reborn.coordinator.updateDeliveryBinding(input.sourceRunId, {
            boundRunId: 'parent-active',
            boundSessionId: fixture.parent.id
          })
          return { notificationId: input.notificationId }
        }
      }
    })

    const received = await receiver.receive({ messageId: 'parent-message', afterStep: -1 })
    expect(received).toHaveLength(1)
    expect(persisted).toMatchObject([{ sourceRunId: runId }])
  })

  it('每 turn 最多接收三批，每批不超过八项和八千字符', async () => {
    const fixture = createHarness()
    for (let index = 0; index < 30; index++) fixture.addSource(index, { summary: 'x'.repeat(2_000) })
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

describe('SubagentDeliveryCoordinator 空闲接力接纳', () => {
  it('同一会话重复接纳复用同一预约，重启后仍复用', () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.note(runId)

    const first = fixture.delivery.admitIdleRelay(fixture.parent.id)
    expect(first).not.toBeNull()
    // 同一实例第二次接纳：不新开预约
    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)?.relayRunId).toBe(first!.relayRunId)

    const reborn = fixture.reboot()
    expect(reborn.delivery.admitIdleRelay(fixture.parent.id)?.relayRunId).toBe(first!.relayRunId)
    expect(relayRuns(reborn.coordinator, fixture.parent.id)).toHaveLength(1)
    expect(relayMessages(reborn.sessionStore, fixture.parent.id)).toHaveLength(1)
  })

  it('同一发起链最多接力三次，耗尽后不再接纳且重启后计数仍成立', () => {
    const fixture = createHarness()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const admitted: string[] = []

    for (let turn = 1; turn <= MAX_RELAY_TURNS_PER_CHAIN; turn++) {
      const child = fixture.addSource(turn)
      fixture.note(child)
      const admission = fixture.delivery.admitIdleRelay(fixture.parent.id)
      expect(admission).not.toBeNull()
      admitted.push(admission!.relayRunId)
      // 预约进入执行后不再算「未执行预约」，下一轮才可能新建
      fixture.coordinator.markRunning(admission!.relayRunId)
    }
    expect(new Set(admitted).size).toBe(MAX_RELAY_TURNS_PER_CHAIN)

    const fourth = fixture.addSource(4)
    fixture.note(fourth)
    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    expect(relayRuns(fixture.coordinator, fixture.parent.id)).toHaveLength(MAX_RELAY_TURNS_PER_CHAIN)
    expect(boundRunId(fixture.coordinator, fourth)).toBeUndefined()

    // 重启后预算从已持久 trigger 派生，不因内存索引丢失而重开
    const reborn = fixture.reboot()
    expect(reborn.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    expect(relayRuns(reborn.coordinator, fixture.parent.id)).toHaveLength(MAX_RELAY_TURNS_PER_CHAIN)
    expect(reborn.sessionStore.findRuntimeInputFact(fixture.parent.id, notificationOf(reborn.coordinator, fourth)))
      .toBeNull()
    expect(info).toHaveBeenCalled()
  })

  it('接力消息已构成接收事实时不再重复接纳', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)
    const admission = fixture.delivery.admitIdleRelay(fixture.parent.id)!
    // 预约被用户取代：源解绑，源从「被预约占用」回到资格候选
    fixture.delivery.supersedeQueuedRelayReservations(fixture.parent.id)
    expect(boundRunId(fixture.coordinator, child)).toBeUndefined()

    // 通知已在接力消息中，只有接收事实能阻止再次接纳（否则用户每发一条消息都会重发通知）
    expect(
      fixture.sessionStore.findRuntimeInputFact(fixture.parent.id, notificationOf(fixture.coordinator, child))
    ).not.toBeNull()
    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    expect(relayRuns(fixture.coordinator, fixture.parent.id)).toHaveLength(1)
    expect(relayMessages(fixture.sessionStore, fixture.parent.id)).toHaveLength(1)
    expect(admission.relayRunId).toBe(
      fixture.coordinator.listSnapshotsForSession(fixture.parent.id)
        .find(snapshot => snapshot.relayTrigger)!.runId
    )
  })

  it('源绑定到未终态 run 时跳过接纳但保留候选', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)
    // 活跃 turn 已占用该源（父 run 仍 running）：不得另开接力，也不得丢弃候选
    fixture.coordinator.updateDeliveryBinding(child, {
      boundRunId: fixture.parentRunId,
      boundSessionId: fixture.parent.id
    })

    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    expect(fixture.coordinator.listRelayTriggerSnapshots()).toEqual([])
    expect(fixture.delivery.listSessionsAwaitingRelay()).toEqual([fixture.parent.id])
    expect(boundRunId(fixture.coordinator, child)).toBe(fixture.parentRunId)
  })

  it('源已绑定到其它会话时不再接纳', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)
    fixture.coordinator.updateDeliveryBinding(child, {
      boundRunId: undefined,
      boundSessionId: 'sess-other'
    })

    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    expect(fixture.coordinator.listRelayTriggerSnapshots()).toEqual([])
    expect(fixture.delivery.listSessionsAwaitingRelay()).toEqual([])
  })

  it('源绑定到已执行的终态 run 时不再接纳', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)
    // 源已被一轮真正进入执行的 run 消费；其接收消息不在此会话激活路径上，
    // 因此只能靠「绑定终态且已执行」判定为已消费。
    fixture.coordinator.startRun({
      kind: 'agent', runId: 'relay-done', workspaceId: fixture.root, sessionId: fixture.parent.id
    })
    fixture.coordinator.markRunning('relay-done')
    fixture.coordinator.commitTerminal({ runId: 'relay-done', status: 'completed', reason: 'done' })
    fixture.coordinator.updateDeliveryBinding(child, {
      boundRunId: 'relay-done',
      boundSessionId: fixture.parent.id
    })

    expect(
      fixture.sessionStore.findRuntimeInputFact(fixture.parent.id, notificationOf(fixture.coordinator, child))
    ).toBeNull()
    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    expect(fixture.coordinator.listRelayTriggerSnapshots()).toEqual([])
    expect(fixture.delivery.listSessionsAwaitingRelay()).toEqual([])
    expect(boundRunId(fixture.coordinator, child)).toBe('relay-done')
  })

  it('未执行即取消的预约解绑源后重新接纳', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    // 崩溃窗口：预约与源绑定已落盘，接力消息尚未落盘
    const relayRunId = fixture.seedQueuedReservation([child])
    fixture.note(child)

    fixture.delivery.settleRelayReservation(relayRunId, 'cancelled', 'superseded_by_user_message')
    expect(fixture.coordinator.getSnapshot(relayRunId)?.status).toBe('cancelled')
    expect(boundRunId(fixture.coordinator, child)).toBeUndefined()

    const readmitted = fixture.delivery.admitIdleRelay(fixture.parent.id)
    expect(readmitted).not.toBeNull()
    expect(readmitted!.relayRunId).not.toBe(relayRunId)
    expect(boundRunId(fixture.coordinator, child)).toBe(readmitted!.relayRunId)
    expect(relayMessages(fixture.sessionStore, fixture.parent.id)).toHaveLength(1)
  })

  it('冻结批次成员全部失效时预约按 relay_items_invalidated 结算', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    const relayRunId = fixture.seedQueuedReservation([child])
    fixture.coordinator.updateDeliveryBinding(child, { invalidatedReason: 'stop:op' })

    expect(fixture.delivery.reconcileDeliveryOnStartup()).toEqual([])
    expect(fixture.coordinator.getSnapshot(relayRunId)).toMatchObject({
      status: 'cancelled',
      terminalReason: 'relay_items_invalidated'
    })
    expect(relayMessages(fixture.sessionStore, fixture.parent.id)).toHaveLength(0)
    expect(boundRunId(fixture.coordinator, child)).toBeUndefined()
  })

  it('构造期回放终态事实不触发唤醒回调，live 终态经一个微任务触发一次', async () => {
    const fixture = createHarness()
    fixture.addSource(1)
    const wake = vi.fn()
    const delivery = fixture.makeDelivery({ onIdleRelayAvailable: wake })

    await Promise.resolve()
    expect(wake).not.toHaveBeenCalled()

    const live = fixture.addSource(2)
    delivery.noteExecutionSettled(live)
    await Promise.resolve()

    expect(wake).toHaveBeenCalledTimes(1)
    expect(wake).toHaveBeenCalledWith(fixture.parent.id)
  })

  it('启动对账补绑缺失绑定、幂等补消息并解绑指向不存在 run 的源', () => {
    const fixture = createHarness()
    const bound = fixture.addSource(1)
    const unbound = fixture.addSource(2)
    const orphan = fixture.addSource(3)
    const relayRunId = fixture.seedQueuedReservation([bound, unbound], { bind: false })
    fixture.coordinator.updateDeliveryBinding(bound, { boundRunId: 'run-ghost', boundSessionId: fixture.parent.id })
    fixture.coordinator.updateDeliveryBinding(orphan, { boundRunId: 'run-ghost', boundSessionId: fixture.parent.id })

    expect(fixture.delivery.reconcileDeliveryOnStartup()).toEqual([fixture.parent.id])
    expect(boundRunId(fixture.coordinator, bound)).toBe(relayRunId)
    expect(boundRunId(fixture.coordinator, unbound)).toBe(relayRunId)
    expect(boundRunId(fixture.coordinator, orphan)).toBeUndefined()

    const messages = relayMessages(fixture.sessionStore, fixture.parent.id)
    expect(messages).toHaveLength(1)
    expect(messages[0].internalSource).toBe('runtime_input')
    expect(messages[0].blocks).toMatchObject([
      { type: 'runtime_input', sourceRunId: bound, afterStep: -1, order: 0 },
      { type: 'runtime_input', sourceRunId: unbound, afterStep: -1, order: 1 }
    ])

    // 重复对账：消息不重复追加，仍报告有有效预约
    expect(fixture.delivery.reconcileDeliveryOnStartup()).toEqual([fixture.parent.id])
    expect(relayMessages(fixture.sessionStore, fixture.parent.id)).toHaveLength(1)
  })
})

describe('SubagentDeliveryCoordinator 接力预约断电恢复', () => {
  it('W1 queued 预约落盘后崩溃：重启保留预约、补齐绑定与消息、接纳复用同一 run', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)

    const crashing = fixture.makeCrashDelivery('binding')
    expect(() => crashing.admitIdleRelay(fixture.parent.id)).toThrow(/before binding/)
    const [reservation] = fixture.coordinator.listRelayTriggerSnapshots()
    expect(reservation.status).toBe('queued')
    expect(boundRunId(fixture.coordinator, child)).toBeUndefined()
    expect(relayMessages(fixture.sessionStore, fixture.parent.id)).toHaveLength(0)

    const reborn = fixture.reboot()
    expect(reborn.interrupted).not.toContain(reservation.runId)
    expect(reborn.coordinator.getSnapshot(reservation.runId)?.status).toBe('queued')
    expect(reborn.delivery.reconcileDeliveryOnStartup()).toEqual([fixture.parent.id])
    expect(boundRunId(reborn.coordinator, child)).toBe(reservation.runId)
    expect(relayMessages(reborn.sessionStore, fixture.parent.id)).toHaveLength(1)

    expect(reborn.delivery.admitIdleRelay(fixture.parent.id)?.relayRunId).toBe(reservation.runId)
    expect(relayRuns(reborn.coordinator, fixture.parent.id)).toHaveLength(1)
    expect(relayMessages(reborn.sessionStore, fixture.parent.id)).toHaveLength(1)
  })

  it('W2 源绑定已落盘、接力消息未落盘时崩溃：重启补消息且只补一条', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)

    const crashing = fixture.makeCrashDelivery('message')
    expect(() => crashing.admitIdleRelay(fixture.parent.id)).toThrow(/before relay message/)
    const [reservation] = fixture.coordinator.listRelayTriggerSnapshots()
    expect(boundRunId(fixture.coordinator, child)).toBe(reservation.runId)
    expect(relayMessages(fixture.sessionStore, fixture.parent.id)).toHaveLength(0)

    const reborn = fixture.reboot()
    expect(reborn.coordinator.getSnapshot(reservation.runId)?.status).toBe('queued')
    expect(reborn.delivery.reconcileDeliveryOnStartup()).toEqual([fixture.parent.id])
    expect(relayMessages(reborn.sessionStore, fixture.parent.id)).toHaveLength(1)
    expect(boundRunId(reborn.coordinator, child)).toBe(reservation.runId)

    expect(reborn.delivery.admitIdleRelay(fixture.parent.id)?.relayRunId).toBe(reservation.runId)
    expect(relayMessages(reborn.sessionStore, fixture.parent.id)).toHaveLength(1)
  })

  it('W3 接力消息已落盘后崩溃：重启不重复追加，接管同一 run', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)
    const admission = fixture.delivery.admitIdleRelay(fixture.parent.id)!
    expect(relayMessages(fixture.sessionStore, fixture.parent.id)).toHaveLength(1)

    const reborn = fixture.reboot()
    expect(reborn.coordinator.getSnapshot(admission.relayRunId)?.status).toBe('queued')
    expect(reborn.delivery.reconcileDeliveryOnStartup()).toEqual([fixture.parent.id])
    expect(relayMessages(reborn.sessionStore, fixture.parent.id)).toHaveLength(1)
    expect(boundRunId(reborn.coordinator, child)).toBe(admission.relayRunId)

    expect(reborn.delivery.admitIdleRelay(fixture.parent.id)?.relayRunId).toBe(admission.relayRunId)
    expect(relayRuns(reborn.coordinator, fixture.parent.id)).toHaveLength(1)
    expect(relayMessages(reborn.sessionStore, fixture.parent.id)).toHaveLength(1)
  })

  it('W4 预约已进入执行后崩溃：重启标 interrupted、保留源绑定、不再自动接纳', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)
    const admission = fixture.delivery.admitIdleRelay(fixture.parent.id)!
    fixture.coordinator.markRunning(admission.relayRunId)

    const reborn = fixture.reboot()
    expect(reborn.interrupted).toContain(admission.relayRunId)
    expect(reborn.coordinator.getSnapshot(admission.relayRunId)).toMatchObject({
      status: 'interrupted',
      terminalReason: 'process_exit'
    })
    expect(reborn.delivery.reconcileDeliveryOnStartup()).toEqual([])
    expect(boundRunId(reborn.coordinator, child)).toBe(admission.relayRunId)

    expect(reborn.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    // 通知已在接力消息中：被消费的事实不因重启丢失
    expect(reborn.sessionStore.findRuntimeInputFact(fixture.parent.id, notificationOf(reborn.coordinator, child)))
      .not.toBeNull()
    expect(reborn.sessionStore.load(fixture.parent.id)!.messages.filter(m => m.id.startsWith('msg_relay_')))
      .toHaveLength(1)
    expect(reborn.delivery.listSessionsAwaitingRelay()).toEqual([])
    expect(relayRuns(reborn.coordinator, fixture.parent.id)).toHaveLength(1)
  })

  it('用户入场取代未执行预约：预约取消、源解绑且不再重复接纳', () => {
    const fixture = createHarness()
    const child = fixture.addSource(1)
    fixture.note(child)
    const admission = fixture.delivery.admitIdleRelay(fixture.parent.id)!

    fixture.delivery.supersedeQueuedRelayReservations(fixture.parent.id)

    expect(fixture.coordinator.getSnapshot(admission.relayRunId)).toMatchObject({
      status: 'cancelled',
      terminalReason: 'superseded_by_user_message'
    })
    expect(boundRunId(fixture.coordinator, child)).toBeUndefined()
    // 通知事实已在接力消息中，用户的新 turn 自行接管：不得双开预约
    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()
    expect(relayRuns(fixture.coordinator, fixture.parent.id)).toHaveLength(1)
  })
})

describe('SubagentDeliveryCoordinator task_wait receipt 消重', () => {
  it('当前 receiving run 的已持久 turnDraft receipt 阻止 runtime_input 注入', async () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)
    const notificationId = deriveSubagentNotificationId(runId, 'terminal-1')

    // 在 parent run 的 turnDraft 中写入 task_wait success block 携带该 notificationId
    fixture.coordinator.upsertTurnDraft(fixture.parentRunId, {
      messageId: 'parent-message',
      attemptId: 'attempt',
      blocks: [{
        type: 'tool',
        toolCallId: 'tw-1',
        toolName: 'task_wait',
        arguments: {},
        status: 'success',
        result: 'ok',
        subagentNotificationIds: [notificationId]
      }],
      finalized: false
    })

    // receiver 应因 turnDraft receipt 而不注入该通知
    const messages = await fixture.receiver.receive({ messageId: 'parent-message', afterStep: -1 })
    expect(messages).toEqual([])
    expect(fixture.persisted).toHaveLength(0)
  })

  it('只有内存 ToolResult、未写 turnDraft 不阻止注入', async () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)
    // 不写 turnDraft，仅内存中存在 ToolResult 概念——delivery 应正常注入
    const messages = await fixture.receiver.receive({ messageId: 'parent-message', afterStep: -1 })
    expect(messages).toHaveLength(1)
    expect(fixture.persisted).toHaveLength(1)
  })

  it('正式 assistant task_wait receipt 在重建 DeliveryCoordinator 后仍消重', async () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)
    const notificationId = deriveSubagentNotificationId(runId, 'terminal-1')

    // 持久化正式 assistant 消息含 task_wait success block
    const r1 = fixture.sessionStore.appendMessageFast(fixture.parent.id, {
      id: 'assistant-receipt', role: 'assistant', content: '', timestamp: 5,
      blocks: [{
        type: 'tool', toolCallId: 'tw-1', toolName: 'task_wait', arguments: {},
        status: 'success', result: 'ok', subagentNotificationIds: [notificationId]
      }]
    })
    expect(r1.ok).toBe(true)

    // 重建 coordinator + delivery（模拟重启）
    const reborn = fixture.reboot()
    reborn.delivery.noteTerminal(reborn.coordinator.getSnapshot(runId)!)
    const rebornReceiver = reborn.delivery.createActiveTurnReceiver({
      sessionId: fixture.parent.id,
      runId: () => reborn.coordinator.listSnapshotsForSession(fixture.parent.id)[0]?.runId ?? '',
      persistence: {
        persist: () => ({ notificationId })
      }
    })
    const messages = await rebornReceiver.receive({ messageId: 'parent-message', afterStep: -1 })
    expect(messages).toEqual([])
  })

  it('receipt 位于非激活分支不消重', async () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)
    const notificationId = deriveSubagentNotificationId(runId, 'terminal-1')

    // 在旧分支写 task_wait receipt，然后切 leaf 到新分支
    const ru1 = fixture.sessionStore.appendMessage(fixture.parent.id, { id: 'u1', role: 'user', content: 'q', timestamp: 1 })
    expect(ru1).not.toBeNull()
    const raOld = fixture.sessionStore.appendMessageFast(fixture.parent.id, {
      id: 'a-old', role: 'assistant', content: '', timestamp: 2,
      blocks: [{
        type: 'tool', toolCallId: 'tw-old', toolName: 'task_wait', arguments: {},
        status: 'success', result: 'ok', subagentNotificationIds: [notificationId]
      }]
    })
    expect(raOld.ok).toBe(true)
    // 倒回到 u1，新分支挂为其子节点
    const leaf = fixture.sessionStore.setCurrentLeaf(fixture.parent.id, 'u1')
    expect(leaf).not.toBeNull()
    const raNew = fixture.sessionStore.appendMessageFast(fixture.parent.id, {
      id: 'a-new', role: 'assistant', content: '', timestamp: 3
    })
    expect(raNew.ok).toBe(true)

    // 旧分支 receipt 不在激活路径，应正常注入
    const messages = await fixture.receiver.receive({ messageId: 'parent-message', afterStep: -1 })
    expect(messages).toHaveLength(1)
    expect(fixture.persisted).toHaveLength(1)
  })

  it('会话存在控制意图时冻结接力接纳，意图清除后恢复', () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)
    fixture.sessionStore.setControlIntent(fixture.parent.id, {
      version: 1,
      operationId: 'op_stop',
      kind: 'stop',
      targetRunIds: ['some-run'],
      targetSessionIds: [],
      requestedAt: Date.now()
    })

    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).toBeNull()

    fixture.sessionStore.clearControlIntent(fixture.parent.id, 'op_stop')
    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).not.toBeNull()
  })

  it('接力接纳关闭时即使有候选通知也不接纳', () => {
    const fixture = createHarness()
    const runId = fixture.addSource(1)
    fixture.delivery.noteTerminal(fixture.coordinator.getSnapshot(runId)!)
    const closed = new SubagentDeliveryCoordinator({
      runCoordinator: fixture.coordinator,
      sessionStore: fixture.sessionStore,
      isRunExecutionActive: () => false,
      isRelayAdmissionClosed: () => true
    })

    expect(closed.admitIdleRelay(fixture.parent.id)).toBeNull()
    // 关闭只影响新接纳：另一实例不受污染仍可正常接纳
    expect(fixture.delivery.admitIdleRelay(fixture.parent.id)).not.toBeNull()
  })
})
