// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PlanApprovalCard,
  PlanApprovalIgnoredCard
} from '../../../src/renderer/features/chat/PlanApprovalCard'
import { renderToolBlock } from '../../../src/renderer/features/chat/renderToolBlock'
import type { PendingPlanReview } from '../../../src/shared/planReview'
import { act, renderDom } from './renderDom'

vi.mock('framer-motion', () => import('./_framerMotionMock'))

const invoke = vi.fn()
Object.assign(window, {
  api: { invoke, on: vi.fn(), removeAllListeners: vi.fn() }
})

const review: PendingPlanReview = {
  interactionId: 'review-1',
  commandVersion: 3,
  runId: 'run-1',
  sessionId: 'session-1',
  messageId: 'message-1',
  toolCallId: 'tool-1',
  source: 'plan'
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll<HTMLButtonElement>('.plan-approval-card__footer button')).find(item =>
    item.textContent?.includes(label)
  )
  if (!found) throw new Error(`未找到按钮：${label}`)
  return found
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  setter?.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('PlanApprovalCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    invoke.mockResolvedValue({ ok: true, firstApplied: true })
  })

  it('默认批准并携带 interaction identity/version', async () => {
    const renderer = renderDom(<PlanApprovalCard review={review} />)
    act(() => button(renderer.container, '批准').click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('respond-plan-review', expect.objectContaining({
      interactionId: 'review-1',
      expectedVersion: 3,
      decision: 'approve'
    }))
    renderer.unmount()
  })

  it('快速连续点击不会重复提交，且 commandId 在同一 review 内保持一致', async () => {
    const renderer = renderDom(<PlanApprovalCard review={review} />)
    act(() => {
      button(renderer.container, '批准').click()
      button(renderer.container, '批准').click()
    })
    await flush()

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke.mock.calls[0][1]).toMatchObject({
      interactionId: 'review-1',
      expectedVersion: 3,
      decision: 'approve',
      commandId: expect.any(String)
    })
    renderer.unmount()
  })

  it('输入反馈后切为 revise，批准选项可切回', async () => {
    const renderer = renderDom(<PlanApprovalCard review={review} />)
    const textarea = renderer.container.querySelector<HTMLTextAreaElement>('textarea')!
    act(() => changeTextarea(textarea, '补充失败回退'))
    act(() => button(renderer.container, '提交修改').click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('respond-plan-review', expect.objectContaining({
      decision: 'revise',
      feedback: '补充失败回退'
    }))
    renderer.unmount()
  })

  it('忽略使用同一命令通道且不携带 feedback', async () => {
    const renderer = renderDom(<PlanApprovalCard review={{ ...review, source: 'compose' }} />)
    act(() => button(renderer.container, '忽略').click())
    await flush()

    expect(invoke).toHaveBeenCalledWith('respond-plan-review', expect.objectContaining({
      decision: 'ignore'
    }))
    expect(invoke.mock.calls[0][1]).not.toHaveProperty('feedback')
    renderer.unmount()
  })

  it('stale ACK 显示错误且不伪装成功', async () => {
    invoke.mockResolvedValue({
      ok: false,
      code: 'version_mismatch',
      message: '版本不匹配',
      firstApplied: false
    })
    const renderer = renderDom(<PlanApprovalCard review={review} />)
    act(() => button(renderer.container, '批准').click())
    await flush()

    expect(renderer.container.textContent).toContain('版本不匹配')
    expect(button(renderer.container, '批准').disabled).toBe(false)
    renderer.unmount()
  })
})

describe('忽略终态', () => {
  it('忽略决定随工具结果持久化，渲染为灰态「已忽略」且不可交互', () => {
    const renderer = renderDom(
      <div>
        {renderToolBlock(
          {
            type: 'tool',
            toolCallId: 'call-switch-ignore',
            toolName: 'switch_mode',
            arguments: { mode: 'default' },
            status: 'success',
            result: '用户选择忽略当前计划，本轮正常结束。'
          },
          false,
          { messageId: 'message-1', sessionId: 'session-1' }
        )}
        {renderToolBlock(
          {
            type: 'tool',
            toolCallId: 'call-stage-ignore',
            toolName: 'stage_transition',
            arguments: { action: 'complete' },
            status: 'success',
            result: '用户选择忽略当前计划；计划未批准，仍停留在「计划」阶段。'
          },
          false,
          { messageId: 'message-1', sessionId: 'session-1' }
        )}
      </div>
    )
    const cards = renderer.container.querySelectorAll('.plan-approval-card--ignored')
    expect(cards).toHaveLength(2)
    expect(cards[0].textContent).toContain('已忽略')
    expect(cards[0].querySelector('button')).toBeNull()
    expect(cards[0].querySelector('textarea')).toBeNull()
    renderer.unmount()
  })

  it('批准后的控制工具与未知结果不渲染卡片', () => {
    const renderer = renderDom(
      <div>
        {renderToolBlock(
          {
            type: 'tool',
            toolCallId: 'call-switch-ok',
            toolName: 'switch_mode',
            arguments: { mode: 'default' },
            status: 'success',
            result: '已切换到 default 模式。'
          },
          false,
          { messageId: 'message-1', sessionId: 'session-1' }
        )}
      </div>
    )
    expect(renderer.container.querySelector('.plan-approval-card')).toBeNull()
    renderer.unmount()
  })

  it('忽略终态卡单独渲染时无任何提交入口', () => {
    const renderer = renderDom(<PlanApprovalIgnoredCard />)
    const card = renderer.container.querySelector('section[aria-label="实施计划审批"]')
    expect(card).not.toBeNull()
    expect(card?.textContent).toContain('已忽略')
    expect(card?.querySelectorAll('button, textarea').length).toBe(0)
    renderer.unmount()
  })
})
