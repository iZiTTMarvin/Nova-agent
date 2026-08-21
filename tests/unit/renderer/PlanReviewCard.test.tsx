// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanReviewCard, type PlanReviewCardProps } from '../../../src/renderer/features/chat/PlanReviewCard'
import { useChatStore } from '../../../src/renderer/stores/useChatStore'
import { useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import type { ComposePlanApproval } from '../../../src/shared/composeLifecycle'
import { act, renderDom, type DomRenderResult } from './renderDom'

vi.mock('../../../src/renderer/features/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    React.createElement('pre', { className: 'markdown-test' }, content)
}))

vi.mock('framer-motion', () => import('./_framerMotionMock'))

const mockInvoke = vi.fn()

Object.assign(window, {
  api: {
    invoke: mockInvoke,
    on: vi.fn(),
    removeAllListeners: vi.fn()
  }
})

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(element =>
    element.textContent?.includes(label)
  )
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

async function renderSuccessCard(): Promise<DomRenderResult> {
  const renderer = renderDom(
    React.createElement(PlanReviewCard, {
      sessionId: 'sess_plan',
      currentMode: 'plan',
      status: 'success',
      args: {
        title: '可审阅计划',
        content: {
          content_omitted: true,
          content_hash: 'hash',
          content_head: '# 摘要头',
          content_tail: '摘要尾'
        }
      },
      result: '计划已保存到 ".nova/plans/2026-07-24-readable.md"',
      turnActive: false
    })
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return renderer
}

async function renderComposeCard(overrides: Partial<PlanReviewCardProps> = {}): Promise<DomRenderResult> {
  const renderer = renderDom(
    React.createElement(PlanReviewCard, {
      sessionId: 'sess_plan',
      currentMode: 'compose',
      status: 'success',
      args: { title: '可审阅计划', content: '# preview' },
      result: '计划已保存到 ".nova/plans/2026-07-24-readable.md"',
      turnActive: false,
      composeStageId: 'plan',
      composePlanApproval: null,
      ...overrides
    })
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  return renderer
}

describe('PlanReviewCard', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockInvoke.mockResolvedValue({
      path: '.nova/plans/2026-07-24-readable.md',
      title: '可审阅计划',
      updatedAt: 123,
      content: '# 完整计划\n\n这是超过工具参数摘要限制后从项目文件加载的正文。'
    })
  })

  it('成功后从当前会话 active plan 加载并展示完整 Markdown', async () => {
    const renderer = await renderSuccessCard()

    expect(mockInvoke).toHaveBeenCalledWith('workspace:read-active-plan', {
      sessionId: 'sess_plan',
      expectedPath: '.nova/plans/2026-07-24-readable.md'
    })
    expect(renderer.container.querySelector('.markdown-test')?.textContent ?? '')
      .toContain('从项目文件加载的正文')
    expect(findButton(renderer.container, '执行').disabled).toBe(false)
    renderer.unmount()
  })

  it('执行先切 Default，再发起新的实施轮次', async () => {
    const originalSetMode = useSettingsStore.getState().setMode
    const originalSendMessage = useChatStore.getState().sendMessage
    const calls: string[] = []
    const setMode = vi.fn(async () => {
      calls.push('mode')
    })
    const sendMessage = vi.fn(async () => {
      calls.push('send')
      return true
    })
    useSettingsStore.setState({ setMode })
    useChatStore.setState({ sendMessage })

    let renderer: DomRenderResult | undefined
    try {
      renderer = await renderSuccessCard()
      await act(async () => {
        findButton(renderer.container, '执行').click()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(setMode).toHaveBeenCalledWith('default')
      expect(sendMessage).toHaveBeenCalledWith(
        expect.stringContaining('读取当前 active plan'),
        []
      )
      expect(calls).toEqual(['mode', 'send'])
    } finally {
      useSettingsStore.setState({ setMode: originalSetMode })
      useChatStore.setState({ sendMessage: originalSendMessage })
      renderer?.unmount()
    }
  })

  it('计划 turn 未结束时不能提前放开实施按钮', async () => {
    const renderer = renderDom(
      React.createElement(PlanReviewCard, {
        sessionId: 'sess_plan',
        currentMode: 'plan',
        status: 'success',
        args: { title: '可审阅计划', content: '# preview' },
        turnActive: true
      })
    )
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(findButton(renderer.container, '等待回复完成').disabled).toBe(true)
    renderer.unmount()
  })

  it('需要更正停留在 plan 模式，并把更正意图发给模型追问', async () => {
    const originalSetMode = useSettingsStore.getState().setMode
    const originalSendMessage = useChatStore.getState().sendMessage
    const setMode = vi.fn(async () => {})
    const sendMessage = vi.fn(async () => true)
    useSettingsStore.setState({ setMode })
    useChatStore.setState({ sendMessage })

    let renderer: DomRenderResult | undefined
    try {
      renderer = await renderSuccessCard()
      await act(async () => {
        renderer.container
          .querySelector<HTMLButtonElement>('[aria-label="更多计划决策"]')
          ?.click()
        await Promise.resolve()
      })
      await act(async () => {
        findButton(renderer.container, '需要更正').click()
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(setMode).not.toHaveBeenCalled()
      expect(sendMessage).toHaveBeenCalledWith(expect.stringContaining('需要更正'), [])
    } finally {
      useSettingsStore.setState({ setMode: originalSetMode })
      useChatStore.setState({ sendMessage: originalSendMessage })
      renderer?.unmount()
    }
  })

  describe('compose 模式：计划确认门', () => {
    it('计划阶段未批准时可点击「批准并开始开发」，成功后调用 compose:approve-plan 并发送引导消息', async () => {
      const originalSendMessage = useChatStore.getState().sendMessage
      const sendMessage = vi.fn(async () => true)
      useChatStore.setState({ sendMessage })
      mockInvoke.mockImplementation((channel: string) => {
        if (channel === 'compose:approve-plan') {
          return Promise.resolve({
            ok: true,
            approval: { status: 'approved', approvedAt: 1, auto: false }
          })
        }
        return Promise.resolve({
          path: '.nova/plans/2026-07-24-readable.md',
          title: '可审阅计划',
          updatedAt: 123,
          content: '# 完整计划'
        })
      })

      let renderer: DomRenderResult | undefined
      try {
        renderer = await renderComposeCard()
        const approveButton = findButton(renderer.container, '批准并开始开发')
        expect(approveButton.disabled).toBe(false)

        await act(async () => {
          approveButton.click()
          await Promise.resolve()
          await Promise.resolve()
        })

        expect(mockInvoke).toHaveBeenCalledWith('compose:approve-plan', { sessionId: 'sess_plan' })
        expect(sendMessage).toHaveBeenCalledWith(
          expect.stringContaining('todo_write'),
          []
        )
      } finally {
        useChatStore.setState({ sendMessage: originalSendMessage })
        renderer?.unmount()
      }
    })

    it('已批准（用户手动）时展示徽标，不显示批准按钮', async () => {
      const approval: ComposePlanApproval = { status: 'approved', approvedAt: 1, auto: false }
      const renderer = await renderComposeCard({ composePlanApproval: approval })

      expect(renderer.container.textContent).toContain('已批准')
      expect(
        Array.from(renderer.container.querySelectorAll('button')).some(btn =>
          btn.textContent?.includes('批准并开始开发')
        )
      ).toBe(false)
      renderer.unmount()
    })

    it('auto 模式自动批准时徽标能看出是自动批准', async () => {
      const approval: ComposePlanApproval = { status: 'approved', approvedAt: 1, auto: true }
      const renderer = await renderComposeCard({ composePlanApproval: approval })

      expect(renderer.container.textContent).toContain('自动批准')
      renderer.unmount()
    })

    it('非计划阶段（已推进到开发）不显示批准/继续完善按钮', async () => {
      const renderer = await renderComposeCard({
        composeStageId: 'implement',
        composePlanApproval: { status: 'approved', approvedAt: 1, auto: false }
      })

      expect(
        Array.from(renderer.container.querySelectorAll('button')).some(btn =>
          btn.textContent?.includes('批准并开始开发') || btn.textContent?.includes('继续完善')
        )
      ).toBe(false)
      renderer.unmount()
    })
  })
})
