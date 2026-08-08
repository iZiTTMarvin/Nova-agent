/**
 * compose 阶段接线测试：指南注入 provider 与工具门禁 overlay 闭包。
 *
 * 只断言外部行为：
 * - provider 输出随阶段表切换而变化，终态只回基础指令；
 * - overlay 在构思/计划阶段拒绝越界工具，且在 compose 的 auto 语义下仍然拒绝
 *   （overlay 优先于 PermissionManager 的基础判定）。
 */
import { describe, expect, it } from 'vitest'
import {
  createComposeModeInstructionProvider,
  createComposeStageToolPolicy
} from '../../../src/main/agent/runtime/composeStageWiring'
import type { SessionStore } from '../../../src/runtime/sessions/SessionStore'
import {
  createInitialStageTable,
  type ComposeStageEntry
} from '../../../src/shared/composeLifecycle'
import { getModeInstruction } from '../../../src/runtime/agent/promptBuilder/modeInstruction'
import { PermissionCoordinator } from '../../../src/runtime/permissions/PermissionCoordinator'
import { PermissionManager } from '../../../src/runtime/permissions/PermissionManager'

function mockSessionStore(initial: ComposeStageEntry[] | null): {
  store: SessionStore
  setStages: (next: ComposeStageEntry[] | null) => void
} {
  let current = initial
  return {
    store: { getComposeStages: () => current } as unknown as SessionStore,
    setStages: (next) => {
      current = next
    }
  }
}

function stagesWithInProgress(id: ComposeStageEntry['id']): ComposeStageEntry[] {
  const table = createInitialStageTable()
  return table.map(entry => {
    const idx = table.findIndex(e => e.id === entry.id)
    const currentIdx = table.findIndex(e => e.id === id)
    if (idx < currentIdx) return { id: entry.id, status: 'completed', completedAt: 1 }
    if (idx === currentIdx) return { id: entry.id, status: 'in_progress' }
    return { id: entry.id, status: 'pending' }
  })
}

const TERMINAL_STAGES: ComposeStageEntry[] = createInitialStageTable().map(entry => ({
  id: entry.id,
  status: 'completed',
  completedAt: 1
}))

describe('createComposeModeInstructionProvider', () => {
  it('旧会话无阶段表时按初始表注入构思指南', () => {
    const { store } = mockSessionStore(null)
    const provider = createComposeModeInstructionProvider(store, 'sess_1', false)
    const text = provider()
    expect(text).toContain(getModeInstruction('compose'))
    expect(text).toContain('[当前阶段: 构思 — 阶段指南]')
  })

  it('输出随阶段表切换而变化', () => {
    const { store, setStages } = mockSessionStore(stagesWithInProgress('brainstorm'))
    const provider = createComposeModeInstructionProvider(store, 'sess_1', false)
    expect(provider()).toContain('[当前阶段: 构思 — 阶段指南]')

    setStages(stagesWithInProgress('verify'))
    const next = provider()
    expect(next).toContain('[当前阶段: 验证 — 阶段指南]')
    expect(next).not.toContain('[当前阶段: 构思')
  })

  it('生命周期终态后只回基础模式指令', () => {
    const { store } = mockSessionStore(TERMINAL_STAGES)
    const provider = createComposeModeInstructionProvider(store, 'sess_1', false)
    expect(provider()).toBe(getModeInstruction('compose'))
  })

  it('auto 轮次追加确认门自动通过说明，非 auto 不出现', () => {
    const { store } = mockSessionStore(stagesWithInProgress('brainstorm'))
    const auto = createComposeModeInstructionProvider(store, 'sess_1', true)
    const manual = createComposeModeInstructionProvider(store, 'sess_1', false)

    const autoText = auto()
    expect(autoText).toContain('确认门自动通过')
    expect(autoText).toContain('不要停下等待用户确认')
    // 指南仍然注入，确认门说明追加在尾部
    expect(autoText).toContain('[当前阶段: 构思 — 阶段指南]')

    expect(manual()).not.toContain('确认门自动通过')
  })
})

describe('createComposeStageToolPolicy', () => {
  it('构思阶段拒绝写工具、放行只读与 stage_transition', () => {
    const { store } = mockSessionStore(stagesWithInProgress('brainstorm'))
    const policy = createComposeStageToolPolicy(store, 'sess_1')
    expect(policy('write', {}).allowed).toBe(false)
    expect(policy('write', {}).reason).toContain('构思')
    expect(policy('read', {}).allowed).toBe(true)
    expect(policy('stage_transition', {}).allowed).toBe(true)
  })

  it('计划阶段放行 save_plan、拒绝 bash', () => {
    const { store } = mockSessionStore(stagesWithInProgress('plan'))
    const policy = createComposeStageToolPolicy(store, 'sess_1')
    expect(policy('save_plan', {}).allowed).toBe(true)
    expect(policy('bash', {}).allowed).toBe(false)
    expect(policy('bash', {}).reason).toContain('计划')
  })

  it('开发及以后不干预，终态后不再收放', () => {
    const { store: implementStore } = mockSessionStore(stagesWithInProgress('implement'))
    const implement = createComposeStageToolPolicy(implementStore, 'sess_1')
    expect(implement('write', {}).allowed).toBe(true)
    expect(implement('bash', {}).allowed).toBe(true)

    const { store: terminalStore } = mockSessionStore(TERMINAL_STAGES)
    const terminal = createComposeStageToolPolicy(terminalStore, 'sess_1')
    expect(terminal('write', {}).allowed).toBe(true)
  })

  it('任何阶段都物理拦截已废弃的 start_workflow', () => {
    const { store } = mockSessionStore(stagesWithInProgress('implement'))
    const policy = createComposeStageToolPolicy(store, 'sess_1')
    const denial = policy('start_workflow', {})
    expect(denial.allowed).toBe(false)
    expect(denial.reason).toContain('stage_transition')
  })

  it('overlay 在 compose auto 语义下仍拒绝：优先于 PermissionManager 基础判定', async () => {
    const events: unknown[] = []
    const coordinator = new PermissionCoordinator({
      emit: event => events.push(event),
      getMode: () => 'compose'
    })
    // compose 恒为 auto 语义：无 overlay 时 write 会被基础判定直接放行
    const manager = new PermissionManager()
    coordinator.setPermissionManager(manager)
    const baseline = await coordinator.checkPermission('write', { path: 'a.ts' }, 'msg-1')
    expect(baseline.allowed).toBe(true)

    const { store } = mockSessionStore(stagesWithInProgress('brainstorm'))
    coordinator.setToolAuthorizationPolicy(createComposeStageToolPolicy(store, 'sess_1'))
    const gated = await coordinator.checkPermission('write', { path: 'a.ts' }, 'msg-2')
    expect(gated.allowed).toBe(false)
    expect(gated.reason).toContain('构思')
    // overlay 拒绝不再弹权限确认
    expect(events).toHaveLength(0)

    // 只读工具不受门禁影响
    const read = await coordinator.checkPermission('read', { path: 'a.ts' }, 'msg-3')
    expect(read.allowed).toBe(true)
  })
})
