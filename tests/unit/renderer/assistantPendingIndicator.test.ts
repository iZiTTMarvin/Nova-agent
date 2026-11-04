// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AssistantPendingIndicator,
  NOVA_WORKING_MESSAGES,
  describeRunPhase,
  pickNonRepeatingWorkingMessage
} from '../../../src/renderer/features/chat/AssistantPendingIndicator'
import { NOVA_WORKING_ORB_DOT_COUNT } from '../../../src/renderer/features/chat/NovaWorkingOrb'
import { makeRunSnapshot } from './runSnapshotFixture'
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
    const second = renderDom(React.createElement(AssistantPendingIndicator))
    expect(first.container.querySelector('.nova-working-indicator__copy')?.textContent)
      .toBe(NOVA_WORKING_MESSAGES[0])
    expect(second.container.querySelector('.nova-working-indicator__copy')?.textContent)
      .toBe(NOVA_WORKING_MESSAGES[0])

    second.unmount()
    first.unmount()
  })

  it('阶段文案来自运行快照：执行中的工具优先于思考，新一轮未建立运行时为发送中', () => {
    const running = makeRunSnapshot({ sessionId: 's1' })
    expect(describeRunPhase(running)).toBe('正在思考')
    expect(describeRunPhase({
      ...running,
      toolCommits: [{ toolCallId: 't1', toolName: 'bash', phase: 'executing', idempotent: false, updatedAt: 1 }]
    })).toBe('正在执行 bash')
    expect(describeRunPhase({
      ...running,
      toolCommits: [
        { toolCallId: 't1', toolName: 'read', phase: 'executing', idempotent: true, updatedAt: 1 },
        { toolCallId: 't2', toolName: 'grep', phase: 'executing', idempotent: true, updatedAt: 1 },
        { toolCallId: 't0', toolName: 'ls', phase: 'committed', idempotent: true, updatedAt: 1 }
      ]
    })).toBe('正在执行 2 个工具')
    expect(describeRunPhase({ ...running, status: 'retrying' })).toBe('正在重试')
    expect(describeRunPhase({ ...running, status: 'completed' })).toBe('正在发送')
    expect(describeRunPhase(null)).toBe('正在发送')
  })

  it('视觉层轮播工作文案，读屏只播报阶段文案', () => {
    const renderer = renderDom(React.createElement(AssistantPendingIndicator, { label: '正在执行 bash' }))
    const pending = renderer.container.querySelector('.assistant-pending')
    const orb = renderer.container.querySelector('.nova-working-orb')
    const label = pending?.querySelector('.assistant-pending__label')
    const copy = () => renderer.container.querySelector('.nova-working-indicator__copy')

    expect(orb?.getAttribute('data-shape')).toBe('N')
    expect(orb?.querySelectorAll('.nova-working-orb__dot')).toHaveLength(NOVA_WORKING_ORB_DOT_COUNT)
    expect(label?.textContent).toBe('正在执行 bash')
    expect(label?.getAttribute('role')).toBe('status')
    expect(pending?.getAttribute('aria-live')).toBeNull()
    expect(copy()?.getAttribute('aria-hidden')).toBe('true')

    const firstCopy = copy()?.textContent
    expect(NOVA_WORKING_MESSAGES).toContain(firstCopy)
    act(() => vi.advanceTimersByTime(4600))
    expect(copy()?.textContent).not.toBe(firstCopy)
    expect(orb?.getAttribute('data-shape')).not.toBe('N')

    renderer.unmount()
  })

  it('超过 15 秒后展示运行时钟', () => {
    const now = Date.now()
    const renderer = renderDom(
      React.createElement(AssistantPendingIndicator, { turnStartedAt: now - 16_000 })
    )

    const clock = renderer.container.querySelector('.nova-working-indicator__clock')
    expect(clock).not.toBeNull()
    expect(clock?.textContent).toMatch(/16 秒/)

    renderer.unmount()
  })

  it('运行未满 15 秒时不展示运行时钟', () => {
    const now = Date.now()
    const renderer = renderDom(
      React.createElement(AssistantPendingIndicator, { turnStartedAt: now - 5_000 })
    )

    expect(renderer.container.querySelector('.nova-working-indicator__clock')).toBeNull()

    renderer.unmount()
  })
})
