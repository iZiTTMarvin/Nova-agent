// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposeStageBar } from '../../../src/renderer/features/compose/ComposeStageBar'
import { useComposeStageStore } from '../../../src/renderer/features/compose/useComposeStageStore'
import { useTodoStore } from '../../../src/renderer/features/todo/useTodoStore'
import type { ComposeStageEntry } from '../../../src/shared/composeLifecycle'
import type { TodoItem } from '../../../src/shared/todo/types'
import { act, renderDom } from './renderDom'

const mockInvoke = vi.fn()

function seedStages(stages: ComposeStageEntry[] | null, sessionId = 'sess_1'): void {
  useComposeStageStore.getState().setSessionStages(sessionId, stages)
}

function seedTodos(todos: TodoItem[], sessionId = 'sess_1'): void {
  useTodoStore.getState().setSessionTodos(sessionId, todos)
}

function midFlowStages(): ComposeStageEntry[] {
  return [
    { id: 'brainstorm', status: 'completed', completedAt: 1_700_000_000_000 },
    { id: 'plan', status: 'skipped', note: '需求简单，直接进入开发', completedAt: 1_700_000_060_000 },
    { id: 'implement', status: 'in_progress' },
    { id: 'verify', status: 'pending' },
    { id: 'review', status: 'pending' },
    { id: 'report', status: 'pending' }
  ]
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

function typeInto(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function queryNode(container: HTMLElement, status: string): HTMLElement | null {
  return container.querySelector(`.compose-stage-bar__node--${status}`)
}

describe('ComposeStageBar', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useComposeStageStore.getState().reset()
    useTodoStore.getState().reset()
    mockInvoke.mockResolvedValue({ ok: true, stages: [] })
    Object.assign(window, {
      api: { invoke: mockInvoke, on: vi.fn(() => () => {}), removeAllListeners: vi.fn() }
    })
  })

  it('渲染六个中文阶段名', () => {
    seedStages(null)
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)
    const text = renderer.container.textContent ?? ''
    for (const label of ['构思', '计划', '开发', '验证', '审查', '收尾']) {
      expect(text).toContain(label)
    }
    expect(renderer.container.querySelectorAll('.compose-stage-bar__node')).toHaveLength(6)
    renderer.unmount()
  })

  it('会话无阶段表时按初始表投影：构思为当前呼吸态节点（aria-current=step）', () => {
    seedStages(null)
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)
    const current = queryNode(renderer.container, 'in_progress')
    expect(current).not.toBeNull()
    expect(current!.getAttribute('aria-current')).toBe('step')
    expect(current!.textContent).toContain('构思')
    renderer.unmount()
  })

  it('completed 节点显示 ✓，skipped 节点显示 ⊘ 并在提示里带原因', () => {
    seedStages(midFlowStages())
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    const completed = queryNode(renderer.container, 'completed')
    expect(completed).not.toBeNull()
    expect(completed!.textContent).toContain('✓')

    const skipped = queryNode(renderer.container, 'skipped')
    expect(skipped).not.toBeNull()
    expect(skipped!.textContent).toContain('⊘')
    expect(skipped!.getAttribute('title')).toContain('需求简单，直接进入开发')
    renderer.unmount()
  })

  it('点击已完成节点展开详情（状态 + 完成时间），再次点击收起', () => {
    seedStages(midFlowStages())
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(queryNode(renderer.container, 'completed')!)
    const detail = renderer.container.querySelector('.compose-stage-bar__detail')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('构思')
    expect(detail!.textContent).toContain('已完成')
    expect(detail!.textContent).toContain('完成于')

    click(queryNode(renderer.container, 'completed')!)
    expect(renderer.container.querySelector('.compose-stage-bar__detail')).toBeNull()
    renderer.unmount()
  })

  it('点击已跳过节点展开详情显示跳过原因', () => {
    seedStages(midFlowStages())
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(queryNode(renderer.container, 'skipped')!)
    const detail = renderer.container.querySelector('.compose-stage-bar__detail')
    expect(detail).not.toBeNull()
    expect(detail!.textContent).toContain('已跳过')
    expect(detail!.textContent).toContain('需求简单，直接进入开发')
    renderer.unmount()
  })

  it('计划节点详情展示 active plan 标题/路径，并可打开计划文件', async () => {
    seedStages(midFlowStages())
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'workspace:read-active-plan') {
        return Promise.resolve({
          path: '.nova/plans/demo.md',
          title: '演示计划',
          updatedAt: 1,
          content: '# 演示计划'
        })
      }
      return Promise.resolve({ ok: true, stages: [] })
    })

    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)
    click(queryNode(renderer.container, 'skipped')!)
    // read-active-plan 是异步返回， flush 一个 microtask 周期
    await act(async () => {
      await Promise.resolve()
    })

    const plan = renderer.container.querySelector('.compose-stage-bar__plan')
    expect(plan).not.toBeNull()
    expect(plan!.textContent).toContain('演示计划')
    expect(plan!.textContent).toContain('.nova/plans/demo.md')

    const openBtn = Array.from(plan!.querySelectorAll('button')).find((btn) =>
      btn.textContent?.includes('打开计划文件')
    )!
    await act(async () => {
      openBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })
    expect(mockInvoke).toHaveBeenCalledWith('workspace:open-active-plan', { sessionId: 'sess_1' })
    renderer.unmount()
  })

  it('手动兜底：⋯ 菜单 → 完成当前阶段，走 compose:apply-stage-transition', async () => {
    seedStages(midFlowStages())
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(renderer.container.querySelector('.compose-stage-bar__menu-trigger')!)
    const completeItem = Array.from(
      renderer.container.querySelectorAll('.compose-stage-bar__menu-item')
    ).find((item) => item.textContent === '完成当前阶段')!
    await act(async () => {
      completeItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('compose:apply-stage-transition', {
      sessionId: 'sess_1',
      action: { type: 'complete' }
    })
    renderer.unmount()
  })

  it('手动兜底：跳过必须填原因，确认后携带原因提交', async () => {
    seedStages(midFlowStages())
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(renderer.container.querySelector('.compose-stage-bar__menu-trigger')!)
    const skipItem = Array.from(
      renderer.container.querySelectorAll('.compose-stage-bar__menu-item')
    ).find((item) => item.textContent === '跳过当前阶段…')!
    click(skipItem)

    const form = renderer.container.querySelector('.compose-stage-bar__form')!
    expect(form.textContent).toContain('跳过「开发」')

    const confirm = Array.from(form.querySelectorAll('button')).find((btn) =>
      btn.textContent === '确认跳过'
    )! as HTMLButtonElement
    // 未填原因时确认按钮禁用，防空原因直达 IPC
    expect(confirm.disabled).toBe(true)

    typeInto(form.querySelector('input')!, '暂不验证，先联调')
    expect(confirm.disabled).toBe(false)
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('compose:apply-stage-transition', {
      sessionId: 'sess_1',
      action: { type: 'skip', reason: '暂不验证，先联调' }
    })
    renderer.unmount()
  })

  it('手动兜底：回退需选目标阶段并填原因', async () => {
    seedStages(midFlowStages())
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(renderer.container.querySelector('.compose-stage-bar__menu-trigger')!)
    const returnItem = Array.from(
      renderer.container.querySelectorAll('.compose-stage-bar__menu-item')
    ).find((item) => item.textContent === '回退到…')!
    click(returnItem)

    const form = renderer.container.querySelector('.compose-stage-bar__form')!
    // 当前为开发，可回退目标只有构思/计划
    const targets = Array.from(form.querySelectorAll('.compose-stage-bar__form-target'))
    expect(targets.map((target) => target.textContent)).toEqual(['构思', '计划'])

    click(targets[1])
    typeInto(form.querySelector('input')!, '方案有遗漏，回到计划补充')

    const confirm = Array.from(form.querySelectorAll('button')).find((btn) =>
      btn.textContent === '确认回退'
    )!
    await act(async () => {
      confirm.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    expect(mockInvoke).toHaveBeenCalledWith('compose:apply-stage-transition', {
      sessionId: 'sess_1',
      action: { type: 'return', targetStage: 'plan', reason: '方案有遗漏，回到计划补充' }
    })
    renderer.unmount()
  })

  it('转换被主进程拒绝时展示中文错误，不静默', async () => {
    seedStages(midFlowStages())
    mockInvoke.mockResolvedValue({ ok: false, error: '跳过阶段必须提供原因' })
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(renderer.container.querySelector('.compose-stage-bar__menu-trigger')!)
    const completeItem = Array.from(
      renderer.container.querySelectorAll('.compose-stage-bar__menu-item')
    ).find((item) => item.textContent === '完成当前阶段')!
    await act(async () => {
      completeItem.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
      await Promise.resolve()
    })

    const error = renderer.container.querySelector('.compose-stage-bar__error')
    expect(error).not.toBeNull()
    expect(error!.textContent).toBe('跳过阶段必须提供原因')
    renderer.unmount()
  })

  it('运行中（interactionLocked）禁用手动菜单并给出提示', () => {
    seedStages(midFlowStages())
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={true} />)
    const trigger = renderer.container.querySelector(
      '.compose-stage-bar__menu-trigger'
    ) as HTMLButtonElement
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('title')).toContain('Agent 运行中')
    renderer.unmount()
  })

  it('终态时完成/跳过菜单项禁用，回退仍可用', () => {
    seedStages([
      { id: 'brainstorm', status: 'completed', completedAt: 1 },
      { id: 'plan', status: 'completed', completedAt: 2 },
      { id: 'implement', status: 'completed', completedAt: 3 },
      { id: 'verify', status: 'skipped', note: '无代码改动', completedAt: 4 },
      { id: 'review', status: 'completed', completedAt: 5 },
      { id: 'report', status: 'completed', completedAt: 6 }
    ])
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)
    expect(queryNode(renderer.container, 'in_progress')).toBeNull()

    click(renderer.container.querySelector('.compose-stage-bar__menu-trigger')!)
    const items = Array.from(
      renderer.container.querySelectorAll('.compose-stage-bar__menu-item')
    ) as HTMLButtonElement[]
    const byText = (text: string) => items.find((item) => item.textContent === text)!
    expect(byText('完成当前阶段').disabled).toBe(true)
    expect(byText('跳过当前阶段…').disabled).toBe(true)
    expect(byText('回退到…').disabled).toBe(false)
    renderer.unmount()
  })

  it('开发节点聚合会话 todo 进度，标签显示为「开发 ● 完成/总数」', () => {
    seedStages(midFlowStages())
    seedTodos([
      { content: '接入登录接口', status: 'completed', priority: 'high' },
      { content: '补充单测', status: 'in_progress', priority: 'medium' },
      { content: '联调验收', status: 'pending', priority: 'low' }
    ])
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    const implementNode = queryNode(renderer.container, 'in_progress')
    expect(implementNode).not.toBeNull()
    expect(implementNode!.textContent).toContain('开发 ● 1/3')
    renderer.unmount()
  })

  it('点击开发节点展开任务清单明细', () => {
    seedStages(midFlowStages())
    seedTodos([
      { content: '接入登录接口', status: 'completed', priority: 'high' },
      { content: '补充单测', status: 'in_progress', priority: 'medium' }
    ])
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(queryNode(renderer.container, 'in_progress')!)
    const detail = renderer.container.querySelector('.compose-stage-bar__detail')
    expect(detail).not.toBeNull()
    const todoRows = detail!.querySelectorAll('.todo-row')
    expect(todoRows).toHaveLength(2)
    expect(detail!.textContent).toContain('接入登录接口')
    expect(detail!.textContent).toContain('补充单测')
    renderer.unmount()
  })

  it('开发节点没有任务清单时展示提示文案', () => {
    seedStages(midFlowStages())
    seedTodos([])
    const renderer = renderDom(<ComposeStageBar sessionId="sess_1" interactionLocked={false} />)

    click(queryNode(renderer.container, 'in_progress')!)
    const detail = renderer.container.querySelector('.compose-stage-bar__detail')
    expect(detail!.textContent).toContain('当前会话暂无任务清单')
    renderer.unmount()
  })
})
