import { describe, it, expect, vi } from 'vitest'
import {
  PermissionCoordinator,
  type PermissionCoordinatorDeps
} from '../../../../src/runtime/permissions/PermissionCoordinator'
import { PermissionManager } from '../../../../src/runtime/permissions/PermissionManager'
import type { Mode } from '../../../../src/shared/session/types'

type EmittedEvent = Parameters<PermissionCoordinatorDeps['emit']>[0]

function createCoordinator(options?: { mode?: Mode; manager?: PermissionManager }) {
  const events: EmittedEvent[] = []
  let mode: Mode = options?.mode ?? 'default'
  const coordinator = new PermissionCoordinator({
    emit: (event) => events.push(event),
    getMode: () => mode
  })
  if (options?.manager) {
    coordinator.setPermissionManager(options.manager)
  }
  return {
    coordinator,
    events,
    setMode(next: Mode) {
      mode = next
    }
  }
}

describe('PermissionCoordinator 无 PermissionManager 的安全降级', () => {
  it('default 模式下普通工具直接放行，不发权限事件', async () => {
    const { coordinator, events } = createCoordinator()
    const result = await coordinator.checkPermission('write', { path: 'a.ts' }, 'msg-1')
    expect(result).toEqual({ allowed: true, reason: '' })
    expect(events).toHaveLength(0)
  })

  it('plan 模式只读允许、写入拒绝', async () => {
    const { coordinator } = createCoordinator({ mode: 'plan' })
    const read = await coordinator.checkPermission('read', { path: 'a.ts' }, 'msg-1')
    expect(read.allowed).toBe(true)
    const write = await coordinator.checkPermission('write', { path: 'a.ts' }, 'msg-1')
    expect(write.allowed).toBe(false)
    expect(write.reason).toContain('plan 模式')
  })

  it('switch_mode 恢复写入能力时 fail closed，安全转换放行', async () => {
    const planSide = createCoordinator({ mode: 'plan' })
    const unsafe = await planSide.coordinator.checkPermission('switch_mode', { mode: 'default' }, 'msg-1')
    expect(unsafe.allowed).toBe(false)
    expect(unsafe.reason).toContain('缺少 PermissionManager')

    // default → plan 是收缩权限的安全转换，降级路径下直接放行
    const defaultSide = createCoordinator({ mode: 'default' })
    const safe = await defaultSide.coordinator.checkPermission('switch_mode', { mode: 'plan' }, 'msg-1')
    expect(safe.allowed).toBe(true)
  })

  it('批量路径与单项路径共享同一降级判定', async () => {
    const { coordinator, events } = createCoordinator({ mode: 'plan' })
    const results = await coordinator.checkBatchPermission(
      [
        { toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } },
        { toolCallId: 'c2', toolName: 'write', args: { path: 'a.ts' } },
        { toolCallId: 'c3', toolName: 'switch_mode', args: { mode: 'default' } }
      ],
      'msg-1'
    )
    expect(results.get('c1')).toEqual({ allowed: true, reason: '' })
    expect(results.get('c2')?.allowed).toBe(false)
    expect(results.get('c2')?.reason).toContain('plan 模式')
    expect(results.get('c3')?.allowed).toBe(false)
    expect(results.get('c3')?.reason).toContain('缺少 PermissionManager')
    expect(events).toHaveLength(0)
  })
})

describe('PermissionCoordinator authorization overlay', () => {
  it('overlay 拒绝优先于 PermissionManager，不弹权限确认', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })
    coordinator.setToolAuthorizationPolicy((toolName) =>
      toolName === 'bash'
        ? { allowed: false, reason: '当前阶段禁止执行命令' }
        : { allowed: true, reason: '' }
    )

    const single = await coordinator.checkPermission('bash', { command: 'git status' }, 'msg-1')
    expect(single).toEqual({ allowed: false, reason: '当前阶段禁止执行命令' })

    const batch = await coordinator.checkBatchPermission(
      [{ toolCallId: 'c1', toolName: 'bash', args: { command: 'git status' } }],
      'msg-1'
    )
    expect(batch.get('c1')?.allowed).toBe(false)
    expect(batch.get('c1')?.reason).toContain('禁止执行命令')
    expect(events).toHaveLength(0)
  })

  it('overlay 放行时继续走 PermissionManager 规则', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })
    coordinator.setToolAuthorizationPolicy(() => ({ allowed: true, reason: '' }))

    const pending = coordinator.checkPermission('bash', { command: 'git status' }, 'msg-1')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    coordinator.respondPermission(events[0].requestId, true)
    expect((await pending).allowed).toBe(true)
  })
})

describe('PermissionCoordinator allow / deny / ask', () => {
  it('规则 allow 与 deny 直接返回，不产生 pending resolver', async () => {
    const { coordinator, events, setMode } = createCoordinator({ manager: new PermissionManager() })

    const read = await coordinator.checkPermission('read', { path: 'a.ts' }, 'msg-1')
    expect(read.allowed).toBe(true)

    setMode('plan')
    const bash = await coordinator.checkPermission('bash', { command: 'ls' }, 'msg-1')
    expect(bash.allowed).toBe(false)
    expect(bash.reason).toContain('plan 模式')
    expect(events).toHaveLength(0)
  })

  it('ask 时发出带 requestId 与 toolCallIds 锚点的单项 permission_request', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })

    const pending = coordinator.checkPermission('bash', { command: 'git status' }, 'msg-1', 'tc-1')
    await vi.waitFor(() => expect(events).toHaveLength(1))

    const event = events[0]
    expect(event.type).toBe('permission_request')
    expect(event.messageId).toBe('msg-1')
    expect(event.toolName).toBe('bash')
    expect(event.toolCallIds).toEqual(['tc-1'])
    expect(coordinator.hasPendingPermission(event.requestId)).toBe(true)

    coordinator.respondPermission(event.requestId, true)
    expect((await pending).allowed).toBe(true)
    expect(coordinator.hasPendingPermission(event.requestId)).toBe(false)
  })

  it('用户拒绝后返回含拒绝文案的结果', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })

    const pending = coordinator.checkPermission('bash', { command: 'npm install' }, 'msg-1')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    coordinator.respondPermission(events[0].requestId, false)

    const result = await pending
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('用户拒绝了 "bash" 工具的执行请求')
    expect(result.aborted).toBeUndefined()
  })

  it('计划审阅 revise 拒绝切换并把反馈写回 reason', async () => {
    const { coordinator, events } = createCoordinator({
      mode: 'plan',
      manager: new PermissionManager()
    })
    const pending = coordinator.checkPermission(
      'switch_mode',
      { mode: 'default', reason: '开始实施' },
      'msg-1'
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))

    coordinator.respondPlanReview(events[0].requestId, {
      decision: 'revise',
      feedback: '补充分批回滚步骤'
    })

    expect(await pending).toEqual({
      allowed: false,
      reason: '补充分批回滚步骤'
    })
  })

  it('计划审阅 ignore 拒绝切换并返回可信 turn_complete 控制信号', async () => {
    const { coordinator, events } = createCoordinator({
      mode: 'plan',
      manager: new PermissionManager()
    })
    const pending = coordinator.checkPermission(
      'switch_mode',
      { mode: 'default', reason: '开始实施' },
      'msg-1'
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))

    coordinator.respondPlanReview(events[0].requestId, { decision: 'ignore' })

    expect(await pending).toEqual({
      allowed: false,
      reason: '用户选择忽略当前计划，本轮正常结束。',
      control: { type: 'turn_complete' }
    })
  })
})

describe('PermissionCoordinator 批量合并', () => {
  it('多条 ask 命令合并为一个请求：commands 列表、最高 riskLevel、toolCallIds', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })

    const pending = coordinator.checkBatchPermission(
      [
        { toolCallId: 'c1', toolName: 'bash', args: { command: 'git status' } },
        { toolCallId: 'c2', toolName: 'bash', args: { command: 'rm -rf build' } }
      ],
      'msg-1'
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))

    const event = events[0]
    expect(event.commands).toEqual(['git status', 'rm -rf build'])
    expect(event.riskLevel).toBe('high')
    expect(event.toolCallIds).toEqual(['c1', 'c2'])

    coordinator.respondPermission(event.requestId, true)
    const results = await pending
    expect(results.get('c1')).toEqual({ allowed: true, reason: '' })
    expect(results.get('c2')).toEqual({ allowed: true, reason: '' })
  })

  it('用户拒绝时整批 ask 项被拒，allow/deny 项不受影响', async () => {
    const manager = new PermissionManager()
    const { coordinator, events } = createCoordinator({ manager })

    const pending = coordinator.checkBatchPermission(
      [
        { toolCallId: 'c1', toolName: 'bash', args: { command: 'git status' } },
        { toolCallId: 'c2', toolName: 'bash', args: { command: 'npm install' } }
      ],
      'msg-1'
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))
    coordinator.respondPermission(events[0].requestId, false)

    const results = await pending
    expect(results.get('c1')?.allowed).toBe(false)
    expect(results.get('c1')?.reason).toContain('拒绝')
    expect(results.get('c2')?.allowed).toBe(false)
  })
})

describe('PermissionCoordinator cancel / dispose', () => {
  it('abortPending 使等待中的请求返回 aborted，而非用户拒绝', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })

    const pending = coordinator.checkPermission('bash', { command: 'git status' }, 'msg-1')
    await vi.waitFor(() => expect(events).toHaveLength(1))

    coordinator.abortPending()
    const result = await pending
    expect(result).toEqual({ allowed: false, reason: '', aborted: true })
    expect(coordinator.hasPendingPermission(events[0].requestId)).toBe(false)
  })

  it('批量等待中 abortPending 时整批标记 aborted', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })

    const pending = coordinator.checkBatchPermission(
      [
        { toolCallId: 'c1', toolName: 'bash', args: { command: 'git status' } },
        { toolCallId: 'c2', toolName: 'bash', args: { command: 'npm install' } }
      ],
      'msg-1'
    )
    await vi.waitFor(() => expect(events).toHaveLength(1))

    coordinator.abortPending()
    const results = await pending
    expect(results.get('c1')).toEqual({ allowed: false, reason: '', aborted: true })
    expect(results.get('c2')).toEqual({ allowed: false, reason: '', aborted: true })
  })

  it('abortPending 清理全部并发 pending resolver', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })

    const first = coordinator.checkPermission('bash', { command: 'git status' }, 'msg-1')
    const second = coordinator.checkPermission('bash', { command: 'npm install' }, 'msg-1')
    await vi.waitFor(() => expect(events).toHaveLength(2))

    coordinator.abortPending()
    expect((await first).aborted).toBe(true)
    expect((await second).aborted).toBe(true)
    for (const event of events) {
      expect(coordinator.hasPendingPermission(event.requestId)).toBe(false)
    }
  })
})

describe('PermissionCoordinator requestId 隔离', () => {
  it('未知 / 已消费的 requestId 回应是无操作', async () => {
    const { coordinator, events } = createCoordinator({ manager: new PermissionManager() })

    expect(() => coordinator.respondPermission('req-unknown', true)).not.toThrow()

    const pending = coordinator.checkPermission('bash', { command: 'git status' }, 'msg-1')
    await vi.waitFor(() => expect(events).toHaveLength(1))
    const requestId = events[0].requestId

    coordinator.respondPermission(requestId, true)
    // 重复回应同一 requestId 不应影响后续状态
    expect(() => coordinator.respondPermission(requestId, false)).not.toThrow()
    expect((await pending).allowed).toBe(true)
  })

  it('不同 coordinator 实例的 requestId 互不串扰', async () => {
    const a = createCoordinator({ manager: new PermissionManager() })
    const b = createCoordinator({ manager: new PermissionManager() })

    const pendingA = a.coordinator.checkPermission('bash', { command: 'git status' }, 'msg-a')
    const pendingB = b.coordinator.checkPermission('bash', { command: 'npm install' }, 'msg-b')
    await vi.waitFor(() => expect(a.events).toHaveLength(1))
    await vi.waitFor(() => expect(b.events).toHaveLength(1))

    // 用 A 的 requestId 回应 B：无操作，B 仍在等待
    b.coordinator.respondPermission(a.events[0].requestId, true)
    expect(b.coordinator.hasPendingPermission(b.events[0].requestId)).toBe(true)

    a.coordinator.respondPermission(a.events[0].requestId, true)
    b.coordinator.respondPermission(b.events[0].requestId, false)
    expect((await pendingA).allowed).toBe(true)
    expect((await pendingB).allowed).toBe(false)
  })
})
