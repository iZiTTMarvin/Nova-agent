// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  shouldShowXForgeCapsule,
  XForgeCapsule
} from '../../../src/renderer/features/compose/XForgeCapsule'
import { useComposeStageStore } from '../../../src/renderer/features/compose/useComposeStageStore'
import { useTodoStore } from '../../../src/renderer/features/todo/useTodoStore'
import { useSubagentProjectionStore } from '../../../src/renderer/features/subagents/projection'
import {
  resetAgentStoreForTests,
  useAgentStore
} from '../../../src/renderer/stores/useAgentStore'
import type { ComposeStageEntry } from '../../../src/shared/composeLifecycle'
import type { TodoItem } from '../../../src/shared/todo/types'
import type { SubagentActivityProjection } from '../../../src/shared/subagents'
import { act, renderDom } from './renderDom'
import { useChatStore, resetChatStoreForTests } from '../../../src/renderer/stores/useChatStore'

const mockInvoke = vi.fn()
const onRequestSupplement = vi.fn()
const cancelExecution = vi.fn().mockResolvedValue(undefined)

function seedStages(stages: ComposeStageEntry[] | null, sessionId = 'sess_1'): void {
  useComposeStageStore.getState().setSessionStages(sessionId, stages)
}

function seedTodos(todos: TodoItem[], sessionId = 'sess_1'): void {
  useTodoStore.getState().setSessionTodos(sessionId, todos)
}

function buildStages(): ComposeStageEntry[] {
  return [
    { id: 'interview', status: 'completed', completedAt: 1 },
    { id: 'blueprint', status: 'completed', completedAt: 2 },
    { id: 'build', status: 'in_progress' },
    { id: 'inspect', status: 'pending' },
    { id: 'deliver', status: 'pending' }
  ]
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

function hover(element: Element, entering: boolean): void {
  act(() => {
    const related = document.body
    if (entering) {
      element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: related }))
      element.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, relatedTarget: related }))
    } else {
      element.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: related }))
      element.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true, relatedTarget: related }))
    }
  })
}

async function expand(container: HTMLElement): Promise<void> {
  click(container.querySelector('.xforge-capsule__chip')!)
  await flush()
}

function actionButton(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('.xforge-capsule__btn'))
    .find((button) => button.textContent === label)
  if (!found) throw new Error(`未找到按钮：${label}`)
  return found
}

function chipText(container: HTMLElement): string {
  return container.querySelector('.xforge-capsule__chip')?.textContent?.trim() ?? ''
}

const PLAN_DOC = {
  path: '.nova/plans/demo.md',
  title: '番茄钟',
  updatedAt: 1,
  content: [
    '# 番茄钟',
    '',
    '## 你要的东西',
    '一个计时器',
    '',
    '## 做完你能做什么',
    '1. 打开页面能看到计时器',
    '2. 点击开始会倒计时',
    '',
    '## 我决定不做的',
    '不做账号',
    '',
    '## 技术选择',
    '单文件 HTML'
  ].join('\n')
}

describe('shouldShowXForgeCapsule', () => {
  it('仅 compose 模式主会话显示', () => {
    expect(shouldShowXForgeCapsule({ mode: 'compose', kind: 'primary' })).toBe(true)
  })

  it('default/plan 会话与 compose 子代理会话不显示', () => {
    expect(shouldShowXForgeCapsule({ mode: 'default', kind: 'primary' })).toBe(false)
    expect(shouldShowXForgeCapsule({ mode: 'plan', kind: 'primary' })).toBe(false)
    expect(shouldShowXForgeCapsule({ mode: 'compose', kind: 'subagent' })).toBe(false)
    expect(shouldShowXForgeCapsule(null)).toBe(false)
    expect(shouldShowXForgeCapsule(undefined)).toBe(false)
  })
})

describe('XForgeCapsule', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useComposeStageStore.getState().reset()
    useTodoStore.getState().reset()
    useSubagentProjectionStore.getState().resetForTests()
    resetAgentStoreForTests()
    resetChatStoreForTests()
    useAgentStore.setState({ cancelExecution })
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'workspace:read-active-plan') return Promise.resolve(PLAN_DOC)
      if (channel === 'compose:apply-stage-transition') {
        return Promise.resolve({ ok: true, stages: [] })
      }
      return Promise.resolve(undefined)
    })
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() }
    })
  })

  it('后台文档停止阶段动效，恢复可见后只在运行时继续', () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const props = { sessionId: 'sess_1', interactionLocked: true, isRunning: true, onRequestSupplement }
    const renderer = renderDom(<XForgeCapsule {...props} />)
    const chip = renderer.container.querySelector('.xforge-capsule__chip')!
    try {
      expect(chip.getAttribute('data-running')).toBe('true')
      act(() => {
        visibility.mockReturnValue('hidden')
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(chip.getAttribute('data-running')).toBe('false')
      act(() => {
        visibility.mockReturnValue('visible')
        document.dispatchEvent(new Event('visibilitychange'))
      })
      expect(chip.getAttribute('data-running')).toBe('true')
      renderer.render(<XForgeCapsule {...props} isRunning={false} />)
      expect(chip.getAttribute('data-running')).toBe('false')
    } finally {
      renderer.unmount()
      visibility.mockRestore()
    }
  })

  it('收起态显示阶段字；无 todo 时不带分数', () => {
    seedStages(null)
    const renderer = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={false}
        onRequestSupplement={onRequestSupplement}
      />
    )
    expect(chipText(renderer.container)).toBe('问')
    expect(chipText(renderer.container)).not.toContain('/')
    renderer.unmount()
  })

  it('保持展开时保存计划会刷新；旧格式计划仍可读正文', async () => {
    mockInvoke.mockResolvedValue(null)
    const renderer = renderDom(<XForgeCapsule sessionId="sess_1" interactionLocked={false} onRequestSupplement={onRequestSupplement} />)
    await expand(renderer.container)
    expect(renderer.container.textContent).toContain('暂无一页纸')
    mockInvoke.mockResolvedValue(PLAN_DOC)
    act(() => useChatStore.setState({ messages: [{ id: 'save-msg', sessionId: 'sess_1', role: 'assistant', content: '', timestamp: 1, _revision: 1,
      blocks: [{ type: 'tool', toolName: 'save_plan', toolCallId: 'save-1', arguments: {}, status: 'success' }] }] }))
    await flush()
    expect(renderer.container.textContent).toContain('点击开始会倒计时')
    mockInvoke.mockResolvedValue({ ...PLAN_DOC, content: '# 旧格式\n原有表格和技术方案' })
    act(() => useChatStore.setState({ messages: [{ id: 'save-msg', sessionId: 'sess_1', role: 'assistant', content: '', timestamp: 2, _revision: 2,
      blocks: [{ type: 'tool', toolName: 'save_plan', toolCallId: 'save-2', arguments: {}, status: 'success' }] }] }))
    await flush()
    expect(renderer.container.querySelector('summary')?.textContent).toContain('查看计划正文')
    expect(renderer.container.textContent).not.toContain('暂无一页纸')
    renderer.unmount()
  })

  it('有 todo 时收起态显示 n/m', () => {
    seedStages(buildStages())
    seedTodos([
      { content: '打开页面能看到计时器', status: 'completed', priority: 'high' },
      { content: '点击开始会倒计时', status: 'pending', priority: 'medium' }
    ])
    const renderer = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={false}
        onRequestSupplement={onRequestSupplement}
      />
    )
    expect(chipText(renderer.container)).toBe('锤 · 1/2')
    renderer.unmount()
  })

  it('终态收起显示交，不空白', () => {
    seedStages([
      { id: 'interview', status: 'completed', completedAt: 1 },
      { id: 'blueprint', status: 'completed', completedAt: 2 },
      { id: 'build', status: 'completed', completedAt: 3 },
      { id: 'inspect', status: 'completed', completedAt: 4 },
      { id: 'deliver', status: 'completed', completedAt: 5 }
    ])
    const renderer = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={false}
        onRequestSupplement={onRequestSupplement}
      />
    )
    expect(chipText(renderer.container)).toBe('交')
    renderer.unmount()
  })

  it('hover 展开、离开收起；click 固定后再离开仍展开', async () => {
    seedStages(null)
    const renderer = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={false}
        onRequestSupplement={onRequestSupplement}
      />
    )
    const root = renderer.container.querySelector('.xforge-capsule')!

    hover(root, true)
    expect(renderer.container.querySelector('.xforge-capsule__panel')).not.toBeNull()

    hover(root, false)
    expect(renderer.container.querySelector('.xforge-capsule__panel')).toBeNull()

    click(renderer.container.querySelector('.xforge-capsule__chip')!)
    expect(renderer.container.querySelector('.xforge-capsule__panel')).not.toBeNull()
    hover(root, false)
    expect(renderer.container.querySelector('.xforge-capsule__panel')).not.toBeNull()

    click(renderer.container.querySelector('.xforge-capsule__chip')!)
    expect(renderer.container.querySelector('.xforge-capsule__panel')).toBeNull()
    renderer.unmount()
  })

  it('展开态按 todo 给一页纸清单打勾', async () => {
    seedStages(buildStages())
    seedTodos([
      { content: '打开页面能看到计时器', status: 'completed', priority: 'high' },
      { content: '点击开始会倒计时', status: 'in_progress', priority: 'medium' }
    ])
    const renderer = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={false}
        onRequestSupplement={onRequestSupplement}
      />
    )
    await expand(renderer.container)

    const items = Array.from(renderer.container.querySelectorAll('.xforge-capsule__check'))
    expect(items).toHaveLength(2)
    expect(items[0].getAttribute('data-checked')).toBe('true')
    expect(items[0].textContent).toContain('打开页面能看到计时器')
    expect(items[1].getAttribute('data-checked')).toBe('false')
    expect(renderer.container.querySelector('.xforge-capsule__activity')?.textContent)
      .toBe('正在做：点击开始会倒计时')
    renderer.unmount()
  })

  it('暂停仅运行中可点；补充要求运行中与空闲都可；回到方案仅空闲且锤/验/交', async () => {
    seedStages(buildStages())
    const idle = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={false}
        onRequestSupplement={onRequestSupplement}
      />
    )
    await expand(idle.container)
    expect(actionButton(idle.container, '暂停').disabled).toBe(true)
    expect(actionButton(idle.container, '补充要求').disabled).toBe(false)
    expect(actionButton(idle.container, '回到方案').disabled).toBe(false)

    click(actionButton(idle.container, '补充要求'))
    expect(onRequestSupplement).toHaveBeenCalledTimes(1)
    click(actionButton(idle.container, '回到方案'))
    await flush()
    expect(mockInvoke).toHaveBeenCalledWith('compose:apply-stage-transition', {
      sessionId: 'sess_1',
      action: { type: 'return', targetStage: 'blueprint', reason: '回到方案' }
    })
    idle.unmount()

    const running = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={true}
        onRequestSupplement={onRequestSupplement}
      />
    )
    await expand(running.container)
    expect(actionButton(running.container, '暂停').disabled).toBe(false)
    expect(actionButton(running.container, '补充要求').disabled).toBe(false)
    expect(actionButton(running.container, '回到方案').disabled).toBe(true)
    click(actionButton(running.container, '暂停'))
    expect(cancelExecution).toHaveBeenCalledTimes(1)
    running.unmount()
  })

  it('问/图阶段空闲时不能回到方案', async () => {
    seedStages(null)
    const renderer = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={false}
        onRequestSupplement={onRequestSupplement}
      />
    )
    await expand(renderer.container)
    expect(actionButton(renderer.container, '回到方案').disabled).toBe(true)
    renderer.unmount()
  })
})

describe('XForgeCapsule 子代理活动行', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useComposeStageStore.getState().reset()
    useTodoStore.getState().reset()
    useSubagentProjectionStore.getState().resetForTests()
    resetAgentStoreForTests()
    mockInvoke.mockResolvedValue(null)
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() }
    })
  })

  it('运行中的 critic 优先于进行中 todo', async () => {
    seedStages(buildStages())
    seedTodos([{ content: '写页面', status: 'in_progress', priority: 'high' }])
    const projection: SubagentActivityProjection = {
      childSessionId: 'sess-child',
      childRunId: 'run-child',
      parentSessionId: 'sess_1',
      parentToolCallId: 'call-task',
      taskLabel: '挑刺',
      profile: {
        profileId: 'critic',
        name: 'Critic',
        permissionCeiling: 'read_only'
      },
      status: 'running',
      startedAt: 10,
      artifactCount: 0
    }
    useSubagentProjectionStore.getState().hydrateParent('sess_1', [projection])

    const renderer = renderDom(
      <XForgeCapsule
        sessionId="sess_1"
        interactionLocked={true}
        onRequestSupplement={onRequestSupplement}
      />
    )
    await expand(renderer.container)
    expect(renderer.container.querySelector('.xforge-capsule__activity')?.textContent)
      .toBe('批评者正在挑刺…')
    renderer.unmount()
  })
})
