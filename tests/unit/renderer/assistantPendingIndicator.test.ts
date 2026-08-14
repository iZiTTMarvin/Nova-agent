// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AssistantPendingIndicator,
  NOVA_WORKING_MESSAGES,
  pickNonRepeatingWorkingMessage
} from '../../../src/renderer/features/chat/AssistantPendingIndicator'
import { NOVA_WORKING_ORB_DOT_COUNT } from '../../../src/renderer/features/chat/NovaWorkingOrb'
import { act, renderDom } from './renderDom'

describe('AssistantPendingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('工作文案保持 10 条，并保证下一条不会和上一条重复', () => {
    expect(NOVA_WORKING_MESSAGES).toHaveLength(10)
    expect(NOVA_WORKING_MESSAGES.join('\n')).not.toMatch(/进程已暂停/)

    for (const previous of NOVA_WORKING_MESSAGES) {
      expect(pickNonRepeatingWorkingMessage(previous, () => 0)).not.toBe(previous)
      expect(pickNonRepeatingWorkingMessage(previous, () => 0.999999)).not.toBe(previous)
    }
  })

  it('不同实例各自拥有文案轮播状态', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)

    const first = renderDom(React.createElement(AssistantPendingIndicator))
    expect(first.container.querySelector('.nova-working-indicator__copy')?.textContent)
      .toBe(NOVA_WORKING_MESSAGES[0])

    const second = renderDom(React.createElement(AssistantPendingIndicator))
    expect(second.container.querySelector('.nova-working-indicator__copy')?.textContent)
      .toBe(NOVA_WORKING_MESSAGES[0])

    second.unmount()
    first.unmount()
  })

  it('渲染 Nova N/O/V/A 点阵工作态和随机文案', () => {
    const renderer = renderDom(React.createElement(AssistantPendingIndicator))
    const pending = renderer.container.querySelector('.assistant-pending')
    const orb = renderer.container.querySelector('.nova-working-orb')
    const copy = renderer.container.querySelector('.nova-working-indicator__copy')

    expect(pending).not.toBeNull()
    expect(orb?.getAttribute('data-shape')).toBe('N')
    expect(orb?.querySelectorAll('.nova-working-orb__dot')).toHaveLength(NOVA_WORKING_ORB_DOT_COUNT)
    expect(NOVA_WORKING_MESSAGES).toContain(copy?.textContent)
    expect(pending?.querySelector('.assistant-pending__label')?.textContent).toBe('正在思考')

    act(() => vi.advanceTimersByTime(1500))
    expect(orb?.getAttribute('data-shape')).toBe('O')
    act(() => vi.advanceTimersByTime(1500))
    expect(orb?.getAttribute('data-shape')).toBe('V')
    act(() => vi.advanceTimersByTime(1500))
    expect(orb?.getAttribute('data-shape')).toBe('A')

    renderer.unmount()
  })
})
