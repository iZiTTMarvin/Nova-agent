// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionStatusPanel } from '../../../src/renderer/features/session-status/SessionStatusPanel'
import { buildStatusDiffTurns, statusRailWidth } from '../../../src/renderer/features/session-status/statusModel'
import { useTodoStore } from '../../../src/renderer/features/todo/useTodoStore'
import { useComposeStageStore } from '../../../src/renderer/features/compose/useComposeStageStore'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import { resetChatStoreForTests, useChatStore } from '../../../src/renderer/stores/useChatStore'
import { resetLayoutStoreForTests, useLayoutStore } from '../../../src/renderer/stores/useLayoutStore'
import { resetAgentStoreForTests, useAgentStore } from '../../../src/renderer/stores/useAgentStore'
import { useRunStore } from '../../../src/renderer/stores/useRunStore'
import type { TodoItem } from '../../../src/shared/todo/types'
import type { ExtendedMessage } from '../../../src/renderer/stores/types'
import { act, renderDom } from './renderDom'
import { makeRunSnapshot, publishRunSnapshot } from './runSnapshotFixture'

const invoke = vi.fn()
const supplement = vi.fn()
const cancel = vi.fn().mockResolvedValue(undefined)
const plan = { path: '.nova/plans/test.md', title: '番茄钟', updatedAt: 1, content: '# 番茄钟\n## 做完你能做什么\n1. 打开计时器\n2. 开始倒计时\n## 我决定不做的\n不做账号' }
const todos: TodoItem[] = [{ content: '打开计时器', status: 'completed', priority: 'medium' }, { content: '开始倒计时', status: 'in_progress', priority: 'medium' }]
function message(id: string, sessionId = 'sess_1'): ExtendedMessage { return { id, sessionId, role: 'assistant', content: '', timestamp: 1, _revision: 1 } }
function click(element: Element) { act(() => element.dispatchEvent(new MouseEvent('click', { bubbles: true }))) }
async function flush() { await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }) }
function panel(mode: 'default' | 'compose' = 'default') { return renderDom(<SessionStatusPanel sessionId="sess_1" mode={mode} onRequestSupplement={supplement} />) }
function button(container: HTMLElement, text: string) { const result = [...container.querySelectorAll<HTMLButtonElement>('button')].find(element => element.textContent === text); if (!result) throw new Error(`按钮不存在：${text}`); return result }

beforeEach(() => {
  vi.clearAllMocks()
  resetChatStoreForTests(); resetLayoutStoreForTests(); resetAgentStoreForTests()
  useRunStore.getState().resetForTests()
  useTodoStore.getState().reset(); useComposeStageStore.getState().reset(); useSubagentProjectionStore.getState().resetForTests()
  useChatStore.setState({ currentSessionId: 'sess_1' })
  useAgentStore.setState({ cancelExecution: cancel })
  invoke.mockImplementation(async channel => channel === 'workspace:read-active-plan' ? plan : channel === 'get-message-diffs' ? { diffs: [], reviews: {} } : undefined)
  Object.assign(window, { api: { invoke, on: vi.fn(() => () => {}) } })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const computed = window.getComputedStyle.bind(window)
  vi.stubGlobal('getComputedStyle', (element: Element) => {
    const style = computed(element)
    if (element.classList.contains('session-status-rail')) style.setProperty('--status-wide', '1')
    return style
  })
})
afterEach(() => vi.unstubAllGlobals())

describe('会话状态入口', () => {
  it('任务原序保留，完成勾选；正文更新不重新展开，任务状态更新才激活', async () => {
    useTodoStore.getState().setSessionTodos('sess_1', todos)
    const view = panel(); await flush()
    expect([...view.container.querySelectorAll('.session-status__task-text')].map(element => element.textContent)).toEqual(['打开计时器', '开始倒计时'])
    expect(view.container.querySelector('[data-status="completed"] [aria-label="已完成"]')).not.toBeNull()
    click(view.container.querySelector('.session-status__collapse')!)
    act(() => useChatStore.setState({ messages: [message('text-only')] }))
    await flush()
    expect(view.container.querySelector('.session-status')?.getAttribute('data-expanded')).toBe('false')
    act(() => useTodoStore.getState().setSessionTodos('sess_1', todos.map(todo => ({ ...todo, status: 'completed' }))))
    expect(view.container.querySelector('.session-status')?.getAttribute('data-expanded')).toBe('true')
    expect(view.container.querySelectorAll('[data-status="completed"]')).toHaveLength(2)
    view.unmount()
  })

  it('Inspector 打开期间新任务只更新内容，关闭后恢复；取消项不伪装全部完成', async () => {
    useTodoStore.getState().setSessionTodos('sess_1', todos)
    const view = panel(); await flush()
    act(() => useLayoutStore.getState().openFiles())
    act(() => useTodoStore.getState().setSessionTodos('sess_1', [{ ...todos[0], status: 'cancelled' }]))
    expect(view.container.querySelector('.session-status')?.getAttribute('data-expanded')).toBe('false')
    expect(view.container.querySelector('.session-status')?.getAttribute('data-tiny')).toBe('true')
    expect(view.container.querySelector('.session-status')?.getAttribute('data-complete')).toBe('false')
    act(() => useLayoutStore.getState().closeInspector())
    expect(view.container.querySelector('.session-status')?.getAttribute('data-expanded')).toBe('true')
    view.unmount()
  })

  it('窄窗已有详情时一次点击直接进入状态，再次点击退出而不复活原侧栏', async () => {
    const computed = getComputedStyle
    vi.stubGlobal('getComputedStyle', (element: Element) => {
      const style = computed(element)
      style.setProperty('--status-wide', '0')
      return style
    })
    useTodoStore.getState().setSessionTodos('sess_1', todos)
    useLayoutStore.getState().openFiles()
    const view = panel(); await flush()
    click(view.container.querySelector('.session-status__trigger')!)
    expect(useLayoutStore.getState()).toMatchObject({ inspectorOpen: true, inspectorSurface: 'status', statusSessionId: 'sess_1' })
    expect(view.container.querySelector('.session-status')?.getAttribute('data-expanded')).toBe('false')
    click(view.container.querySelector('.session-status__trigger')!)
    expect(useLayoutStore.getState()).toMatchObject({ inspectorOpen: false, inspectorSurface: 'standard', statusSessionId: null })
    view.unmount()
  })

  it('后台入口指向精确子会话，不切换父会话焦点', async () => {
    useSubagentProjectionStore.getState().hydrateParent('sess_1', [{ childSessionId: 'child-1', childRunId: 'run-child', parentSessionId: 'sess_1', parentToolCallId: 'task-1', profile: { profileId: 'inspector', name: '核验者', permissionCeiling: 'read_only' }, status: 'running', execution: 'background_read_only', artifactCount: 0, taskLabel: '核验页面' }])
    const view = panel(); await flush()
    click(view.container.querySelector('[aria-label="查看核验者子会话"]')!)
    expect(useLayoutStore.getState()).toMatchObject({ inspectorSurface: 'subagent', subagentTarget: { parentSessionId: 'sess_1', childSessionId: 'child-1' } })
    expect(useChatStore.getState().currentSessionId).toBe('sess_1')
    view.unmount()
  })

  it('保留 compose 阶段、一页纸清单与运行/空闲操作权限', async () => {
    useComposeStageStore.getState().setSessionStages('sess_1', [{ id: 'interview', status: 'completed' }, { id: 'blueprint', status: 'completed' }, { id: 'build', status: 'in_progress' }, { id: 'inspect', status: 'pending' }, { id: 'deliver', status: 'pending' }])
    useTodoStore.getState().setSessionTodos('sess_1', todos)
    const view = panel('compose'); await flush()
    expect(view.container.querySelector('.session-status__capabilities [data-checked="true"]')?.textContent).toContain('打开计时器')
    expect(button(view.container, '暂停').disabled).toBe(true)
    expect(button(view.container, '回到方案').disabled).toBe(false)
    click(button(view.container, '补充要求')); expect(supplement).toHaveBeenCalledTimes(1)
    click(button(view.container, '回到方案')); await flush()
    expect(invoke).toHaveBeenCalledWith('compose:apply-stage-transition', { sessionId: 'sess_1', action: { type: 'return', targetStage: 'blueprint', reason: '回到方案' } })
    act(() => publishRunSnapshot(makeRunSnapshot()))
    expect(button(view.container, '暂停').disabled).toBe(false)
    expect(button(view.container, '回到方案').disabled).toBe(true)
    click(button(view.container, '暂停')); expect(cancel).toHaveBeenCalledTimes(1)
    act(() => publishRunSnapshot(makeRunSnapshot({ sequence: 2, status: 'waiting_user' })))
    expect(button(view.container, '暂停').disabled).toBe(false)
    view.unmount()
  })

  it('胶囊常驻顶部栏槽位并通过点击激活或收起下方浮窗；前置完成项可折叠展开', async () => {
    invoke.mockImplementation(async () => undefined)
    const slot = document.createElement('div')
    slot.className = 'glass-header__status-slot'
    document.body.appendChild(slot)
    const view = panel(); await flush()
    const topbarBtn = () => slot.querySelector<HTMLButtonElement>('.session-status__topbar-capsule')
    expect(topbarBtn()).not.toBeNull()
    expect(view.container.querySelector('.session-status')).toBeNull()
    click(topbarBtn()!)
    expect(view.container.querySelector('.session-status')?.getAttribute('data-expanded')).toBe('true')
    click(topbarBtn()!)
    expect(view.container.querySelector('.session-status')).toBeNull()

    act(() => useTodoStore.getState().setSessionTodos('sess_1', [
      { content: '步骤 1', status: 'completed', priority: 'medium' },
      { content: '步骤 2', status: 'completed', priority: 'medium' },
      { content: '步骤 3', status: 'completed', priority: 'medium' },
      { content: '步骤 4', status: 'in_progress', priority: 'medium' },
      { content: '步骤 5', status: 'pending', priority: 'medium' }
    ]))
    expect(topbarBtn()?.textContent).toContain('3/5')
    expect(view.container.querySelector('.session-status')?.getAttribute('data-expanded')).toBe('true')
    const fold = view.container.querySelector<HTMLButtonElement>('.session-status__fold-toggle')
    expect(fold?.textContent).toContain('已完成 2 项')
    expect([...view.container.querySelectorAll('.session-status__task-text')].map(el => el.textContent)).toEqual(['步骤 3', '步骤 4', '步骤 5'])
    click(fold!)
    expect([...view.container.querySelectorAll('.session-status__task-text')].map(el => el.textContent)).toEqual(['步骤 1', '步骤 2', '步骤 3', '步骤 4', '步骤 5'])
    view.unmount()
    slot.remove()
  })

  it('隐藏文档与等待用户期间停止运行态动画', async () => {
    act(() => publishRunSnapshot(makeRunSnapshot()))
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const view = panel('compose'); await flush()
    expect(view.container.querySelector('.status-sprite')?.getAttribute('data-running')).toBe('true')
    act(() => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')) })
    expect(view.container.querySelector('.status-sprite')?.getAttribute('data-running')).toBe('false')
    act(() => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); publishRunSnapshot(makeRunSnapshot({ sequence: 2, status: 'waiting_user' })) })
    expect(view.container.querySelector('.status-sprite')?.getAttribute('data-running')).toBe('false')
    view.unmount(); visibility.mockRestore()
  })

  it('保存新计划刷新已打开浮窗，旧格式仍可从计划入口阅读全文', async () => {
    const view = panel(); await flush()
    invoke.mockImplementation(async channel => channel === 'workspace:read-active-plan' ? { ...plan, title: '新方案', content: '# 旧格式\n原有技术表格', updatedAt: 2 } : { diffs: [], reviews: {} })
    act(() => useChatStore.setState({ messages: [{ ...message('save'), blocks: [{ type: 'tool', toolName: 'save_plan', toolCallId: 'new-plan', arguments: { title: '新方案' }, status: 'success' }] }] }))
    await flush()
    click(button(view.container, '新方案'))
    expect(useLayoutStore.getState()).toMatchObject({ inspectorSurface: 'plan', planTarget: { sessionId: 'sess_1', toolCallId: 'new-plan' } })
    view.unmount()
  })

  it('切会话后旧计划的在途读取不覆盖当前内容', async () => {
    const resolves: Array<(value: typeof plan) => void> = []
    invoke.mockImplementation(channel => channel === 'workspace:read-active-plan' ? new Promise<typeof plan>(done => resolves.push(done)) : Promise.resolve({ diffs: [], reviews: {} }))
    const view = panel()
    act(() => useChatStore.setState({ currentSessionId: 'other' }))
    view.render(<SessionStatusPanel key="other" sessionId="other" mode="default" onRequestSupplement={supplement} />)
    await act(async () => { resolves[1]({ ...plan, title: '新会话计划' }); await Promise.resolve(); await Promise.resolve() })
    await act(async () => { resolves[0]({ ...plan, title: '旧会话计划' }); await Promise.resolve(); await Promise.resolve() })
    expect(view.container.textContent).toContain('新会话计划')
    expect(view.container.textContent).not.toContain('旧会话计划')
    view.unmount()
  })

  it('轮次与会话分离，保留跳过快照的警示；不把多轮变更相加', () => {
    const first = { filePath: 'a.ts', status: 'modified' as const, hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, content: '-a\n+b' }] }
    const turns = buildStatusDiffTurns([message('a'), message('b'), message('other', 'sess_2')], 'sess_1', { a: { diffs: [first], reviews: {} }, b: { diffs: [], reviews: {}, skippedFiles: [{ path: 'large.dat', bytes: 100, reason: 'oversized' }] }, other: { diffs: [first], reviews: {} } }, {})
    expect(turns.map(turn => turn.messageId)).toEqual(['b', 'a'])
    expect(turns[1]).toMatchObject({ added: 1, removed: 1 })
    expect(turns[0].cache?.skippedFiles?.[0].path).toBe('large.dat')
  })

  it('悬浮状态区始终零文档流占位，不挤压对话阅读列宽度', () => {
    expect(statusRailWidth(900, false, true)).toBe(0)
    expect(statusRailWidth(900, true, true)).toBe(0)
    expect(statusRailWidth(600, false, true)).toBe(0)
    expect(statusRailWidth(900, false, false)).toBe(0)
  })
})
