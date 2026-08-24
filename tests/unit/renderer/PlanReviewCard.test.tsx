// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanReviewCard } from '../../../src/renderer/features/chat/PlanReviewCard'
import { resetLayoutStoreForTests, useLayoutStore } from '../../../src/renderer/stores/useLayoutStore'
import { act, renderDom } from './renderDom'

vi.mock('../../../src/renderer/features/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    React.createElement('pre', { className: 'markdown-test' }, content)
}))
vi.mock('framer-motion', () => import('./_framerMotionMock'))

const mockInvoke = vi.fn()
const writeText = vi.fn()
Object.assign(window, {
  api: { invoke: mockInvoke, on: vi.fn(), removeAllListeners: vi.fn() }
})
Object.defineProperty(navigator, 'clipboard', {
  configurable: true,
  value: { writeText }
})

function renderCard(toolCallId = 'plan-1') {
  return renderDom(
    <PlanReviewCard
      sessionId="sess-plan"
      messageId="msg-plan"
      toolCallId={toolCallId}
      status="success"
      args={{ title: '计划审阅体验', content: '# 参数预览' }}
      result={'计划已保存到 ".nova/plans/review.md"'}
    />
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('PlanReviewCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetLayoutStoreForTests()
    mockInvoke.mockResolvedValue({
      path: '.nova/plans/review.md',
      title: '计划审阅体验',
      updatedAt: 1,
      content: '# 完整计划\n\n实施步骤'
    })
  })

  it('从安全 active-plan IPC 读取正文并显示有限预览', async () => {
    const renderer = renderCard()
    await flush()

    expect(mockInvoke).toHaveBeenCalledWith('workspace:read-active-plan', {
      sessionId: 'sess-plan',
      expectedPath: '.nova/plans/review.md'
    })
    expect(renderer.container.querySelector('.markdown-test')?.textContent).toContain('完整计划')
    expect(renderer.container.querySelector('.plan-review-card__preview')).not.toBeNull()
    renderer.unmount()
  })

  it('相同路径的新 toolCallId 会重新读取，并同步已打开的完整计划目标', async () => {
    const renderer = renderCard('plan-1')
    await flush()
    const view = Array.from(renderer.container.querySelectorAll('button')).find(item =>
      item.textContent?.includes('查看完整计划')
    )
    act(() => view?.click())

    renderer.render(
      <PlanReviewCard
        sessionId="sess-plan"
        messageId="msg-plan"
        toolCallId="plan-2"
        status="success"
        args={{ title: '计划审阅体验', content: '# 参数预览' }}
        result={'计划已保存到 ".nova/plans/review.md"'}
      />
    )
    await flush()

    expect(mockInvoke).toHaveBeenCalledTimes(2)
    expect(useLayoutStore.getState().planTarget?.toolCallId).toBe('plan-2')
    renderer.unmount()
  })

  it('查看完整计划复用 Inspector 槽并只保存计划目标', async () => {
    const renderer = renderCard()
    await flush()
    const button = Array.from(renderer.container.querySelectorAll('button')).find(item =>
      item.textContent?.includes('查看完整计划')
    )
    act(() => button?.click())

    expect(useLayoutStore.getState()).toMatchObject({
      inspectorOpen: true,
      inspectorSurface: 'plan',
      planTarget: {
        sessionId: 'sess-plan',
        messageId: 'msg-plan',
        toolCallId: 'plan-1',
        expectedPath: '.nova/plans/review.md'
      }
    })
    renderer.unmount()
  })

  it('复制使用已读取的完整 Markdown', async () => {
    const renderer = renderCard()
    await flush()
    const copy = renderer.container.querySelector<HTMLButtonElement>('[aria-label="复制完整计划"]')
    await act(async () => {
      copy?.click()
      await Promise.resolve()
    })
    expect(writeText).toHaveBeenCalledWith('# 完整计划\n\n实施步骤')
    renderer.unmount()
  })

  it('active plan 已变化时显示可恢复错误且不开放全文按钮', async () => {
    mockInvoke.mockResolvedValue(null)
    const renderer = renderCard()
    await flush()

    expect(renderer.container.textContent).toContain('当前计划已更新')
    const view = Array.from(renderer.container.querySelectorAll<HTMLButtonElement>('button')).find(item =>
      item.textContent?.includes('查看完整计划')
    )
    expect(view?.disabled).toBe(true)
    renderer.unmount()
  })
})
