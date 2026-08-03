// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlanReviewCard } from '../../../src/renderer/features/chat/PlanReviewCard'
import { useChatStore } from '../../../src/renderer/stores/useChatStore'
import { useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { act, renderDom, type DomRenderResult } from './renderDom'

vi.mock('../../../src/renderer/features/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) =>
    React.createElement('pre', { className: 'markdown-test' }, content)
}))

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
    expect(findButton(renderer.container, '开始实施').disabled).toBe(false)
    renderer.unmount()
  })

  it('开始实施先切 Default，再发起新的实施轮次', async () => {
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
        findButton(renderer.container, '开始实施').click()
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

  it('继续完善只把修订提示送入输入框，不切换模式', async () => {
    const renderer = await renderSuccessCard()

    act(() => {
      findButton(renderer.container, '继续完善').click()
    })

    expect(useSettingsStore.getState().composerPrefill).toContain('继续完善当前计划')
    renderer.unmount()
  })
})
