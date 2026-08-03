// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TodoPanel } from '../../../src/renderer/features/todo/TodoPanel'
import { useTodoStore } from '../../../src/renderer/features/todo/useTodoStore'
import { act, renderDom, type DomRenderResult } from './renderDom'

vi.mock('framer-motion', () => import('./_framerMotionMock'))

const TODO_LIST = [
  { content: 'A', status: 'completed' as const, priority: 'high' as const },
  { content: 'B', status: 'in_progress' as const, priority: 'medium' as const },
  { content: 'C', status: 'pending' as const, priority: 'low' as const }
]

const TODO_DATA = {
  todos: TODO_LIST,
  view: { mode: 'full' as const, todos: TODO_LIST, hiddenBefore: 0, hiddenAfter: 0, changed: 0 }
}

function treeText(renderer: DomRenderResult | null): string {
  return renderer?.container.textContent ?? ''
}

/** 展开态会渲染 todo-panel__body / todo-row */
function isExpanded(renderer: DomRenderResult | null): boolean {
  return renderer?.container.querySelector('.todo-panel__body') !== null
}

describe('TodoPanel 细条状态机', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    useTodoStore.setState({ bySession: {}, seen: {} })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('有 todo 且 turnTouched 时渲染；5s 后回到细条', () => {
    useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })

    const renderer = renderDom(<TodoPanel sessionId="s1" />)

    // 挂载时 updatedAt effect 会展开
    expect(treeText(renderer)).toContain('当前计划')
    expect(renderer.container.querySelector('.todo-panel__progress')?.getAttribute('aria-label'))
      .toBe('已完成 1 项，共 3 项')
    expect(isExpanded(renderer)).toBe(true)

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(isExpanded(renderer)).toBe(false)
    expect(treeText(renderer)).toContain('当前计划')

    renderer.unmount()
  })

  it('5s 内再次 applyUpdate 会重置计时，仍保持展开', () => {
    useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })

    const renderer = renderDom(<TodoPanel sessionId="s1" />)

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    expect(isExpanded(renderer)).toBe(true)

    act(() => {
      useTodoStore.getState().applyUpdate({
        sessionId: 's1',
        todos: [
          { content: 'A', status: 'completed', priority: 'high' },
          { content: 'B', status: 'completed', priority: 'medium' },
          { content: 'C', status: 'in_progress', priority: 'low' }
        ],
        view: {
          mode: 'full',
          todos: [
            { content: 'A', status: 'completed', priority: 'high' },
            { content: 'B', status: 'completed', priority: 'medium' },
            { content: 'C', status: 'in_progress', priority: 'low' }
          ],
          hiddenBefore: 0,
          hiddenAfter: 0,
          changed: 1
        }
      })
    })

    act(() => {
      vi.advanceTimersByTime(3000)
    })
    // 距上次更新仅 3s，应仍展开
    expect(isExpanded(renderer)).toBe(true)

    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(isExpanded(renderer)).toBe(false)

    renderer.unmount()
  })

  it('手动收起后无更新保持细条；再更新则展开', () => {
    useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })

    const renderer = renderDom(<TodoPanel sessionId="s1" />)
    expect(isExpanded(renderer)).toBe(true)

    act(() => {
      renderer.container.querySelector<HTMLElement>('.todo-panel__header')?.click()
    })
    expect(isExpanded(renderer)).toBe(false)

    act(() => {
      vi.advanceTimersByTime(5000)
    })
    expect(isExpanded(renderer)).toBe(false)

    act(() => {
      useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })
    })
    expect(isExpanded(renderer)).toBe(true)

    renderer.unmount()
  })

  it('priorityDockOccupied 强制细条，期间更新不自动展开', () => {
    useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })

    const renderer = renderDom(<TodoPanel sessionId="s1" />)
    expect(isExpanded(renderer)).toBe(true)

    renderer.render(<TodoPanel sessionId="s1" priorityDockOccupied />)
    expect(isExpanded(renderer)).toBe(false)

    act(() => {
      useTodoStore.getState().applyUpdate({
        sessionId: 's1',
        todos: TODO_LIST,
        view: { ...TODO_DATA.view, changed: 1 }
      })
    })
    expect(isExpanded(renderer)).toBe(false)

    renderer.unmount()
  })

  it('turnTouched=false 时不渲染', () => {
    useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })
    useTodoStore.getState().resetTurnTouched('s1')

    const renderer = renderDom(<TodoPanel sessionId="s1" />)

    expect(renderer.container.querySelector('.todo-panel')).toBeNull()

    renderer.unmount()
  })

  it('todo 清空时立即不渲染', () => {
    useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })

    const renderer = renderDom(<TodoPanel sessionId="s1" />)

    act(() => {
      useTodoStore.getState().applyUpdate({
        sessionId: 's1',
        todos: [],
        view: { mode: 'full', todos: [], hiddenBefore: 0, hiddenAfter: 0, changed: 0 }
      })
    })

    expect(renderer.container.querySelector('.todo-panel')).toBeNull()

    renderer.unmount()
  })

  it('idle 后 turnTouched 仍为 true 时保留细条', () => {
    useTodoStore.getState().applyUpdate({ sessionId: 's1', ...TODO_DATA })

    const renderer = renderDom(<TodoPanel sessionId="s1" />)

    act(() => {
      vi.advanceTimersByTime(5000)
    })

    // 无 live 概念：组件持续挂载即表示 idle 后仍在
    expect(renderer.container.querySelector('.todo-panel')).not.toBeNull()
    expect(isExpanded(renderer)).toBe(false)
    expect(treeText(renderer)).toContain('当前计划')

    renderer.unmount()
  })
})
