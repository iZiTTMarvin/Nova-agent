// @vitest-environment jsdom

/**
 * 过程列表中网页读取分组：组头统计、单项详情、状态文案、授权入口与动态加入时的展开保持。
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ProcessTraceList } from '../../../src/renderer/features/chat/ProcessTraceList'
import { buildTurnRenderModel } from '../../../src/renderer/features/chat/turnProcessModel'
import { resetAgentStoreForTests, useAgentStore } from '../../../src/renderer/stores/useAgentStore'
import { USER_CANCELLED_TOOL_RESULT } from '../../../src/shared/session/toolCancellation'
import type { RendererToolBlock } from '../../../src/renderer/stores/types'
import { act, renderDom } from './renderDom'

function fetchBlock(
  id: string,
  url: string,
  status: RendererToolBlock['status'] = 'success',
  result?: string
): RendererToolBlock {
  return {
    type: 'tool',
    toolCallId: id,
    toolName: 'web_fetch',
    arguments: { url },
    status,
    ...(result !== undefined ? { result } : {})
  }
}

function renderList(blocks: RendererToolBlock[]) {
  const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
  const element = (nextBlocks: RendererToolBlock[]) => {
    const nextModel = buildTurnRenderModel({
      blocks: nextBlocks,
      toolCalls: [],
      mode: 'default',
      phase: 'completed'
    })
    return (
      <ProcessTraceList
        segments={nextModel.timeline}
        messageId="msg-1"
        blocks={nextBlocks}
        isTurnActiveForThisMsg={false}
        isPausedForInput={false}
        isCurrentAssistantGenerating={false}
        sessionId="sess-1"
      />
    )
  }
  void model
  const rendered = renderDom(element(blocks))
  return { ...rendered, update: (next: RendererToolBlock[]) => rendered.render(element(next)) }
}

function headerOf(container: HTMLElement): HTMLButtonElement {
  const header = container.querySelector<HTMLButtonElement>('.tool-call-group__header')
  if (!header) throw new Error('缺少组头')
  return header
}

function rowHeaders(container: HTMLElement): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('.tool-trace-row__header'))
}

beforeEach(() => {
  resetAgentStoreForTests()
  Object.assign(window, { api: { invoke: vi.fn(), on: vi.fn(() => () => {}), removeAllListeners: vi.fn() } })
})

describe('web_fetch 过程呈现', () => {
  it('单条显示为一行：读取网页 + 域名路径 + 已读取，不显示凭据与查询参数', () => {
    const view = renderList([fetchBlock('f1', 'https://user:pw@openai.com/news/post?token=1#x')])
    expect(view.container.querySelector('.tool-call-group')).toBeNull()
    const text = view.container.textContent ?? ''
    expect(text).toContain('读取网页')
    expect(text).toContain('openai.com/news/post')
    expect(text).toContain('已读取')
    expect(text).not.toContain('token=1')
    expect(text).not.toContain('pw@')
    view.unmount()
  })

  it('连续多条成组：组头给出数量与真实的失败数，组内逐项保留自己的状态', () => {
    const view = renderList([
      fetchBlock('f1', 'https://openai.com/news/a'),
      fetchBlock('f2', 'https://anthropic.com/news/b'),
      fetchBlock('f3', 'https://example.com/report'),
      fetchBlock('f4', 'https://example.com/research', 'error', 'HTTP 404')
    ])
    const header = headerOf(view.container)
    expect(header.textContent).toContain('读取网页')
    expect(header.textContent).toContain('4 次')
    expect(header.textContent).toContain('1 项失败')
    expect(header.textContent).not.toContain('·')
    expect(header.getAttribute('aria-expanded')).toBe('false')

    act(() => header.click())
    expect(header.getAttribute('aria-expanded')).toBe('true')
    const rows = rowHeaders(view.container)
    expect(rows).toHaveLength(4)
    expect(rows.map(row => row.querySelector('.tool-trace-row__status')?.textContent)).toEqual([
      '已读取', '已读取', '已读取', '读取失败'
    ])
    view.unmount()
  })

  it('每一项能展开自己的参数、结果与错误原因，再点收起', () => {
    const view = renderList([
      fetchBlock('f1', 'https://a.com/one', 'success', 'A 页面正文'),
      fetchBlock('f2', 'https://b.com/two', 'error', 'HTTP 503')
    ])
    act(() => headerOf(view.container).click())
    const [first, second] = rowHeaders(view.container)

    act(() => second.click())
    expect(second.getAttribute('aria-expanded')).toBe('true')
    expect(first.getAttribute('aria-expanded')).toBe('false')
    const detail = view.container.querySelector('.tool-trace-row__detail')
    expect(detail?.textContent).toContain('https://b.com/two')
    expect(detail?.textContent).toContain('原因')
    expect(detail?.textContent).toContain('HTTP 503')

    act(() => second.click())
    expect(second.getAttribute('aria-expanded')).toBe('false')
    view.unmount()
  })

  it('取消产生的 error 显示为未完成而不是失败', () => {
    const view = renderList([
      fetchBlock('f1', 'https://a.com', 'success', 'ok'),
      fetchBlock('f2', 'https://b.com', 'error', USER_CANCELLED_TOOL_RESULT)
    ])
    const header = headerOf(view.container)
    expect(header.textContent).toContain('1 项未完成')
    expect(header.textContent).not.toContain('失败')
    act(() => header.click())
    expect(rowHeaders(view.container)[1].querySelector('.tool-trace-row__status')?.textContent).toBe('未完成')
    view.unmount()
  })

  it('执行中的项显示正在读取，并计入组头进行中', () => {
    const view = renderList([
      fetchBlock('f1', 'https://a.com', 'running'),
      fetchBlock('f2', 'https://b.com', 'success', 'ok')
    ])
    const header = headerOf(view.container)
    expect(header.textContent).toContain('1 项进行中')
    act(() => header.click())
    expect(rowHeaders(view.container)[0].querySelector('.tool-trace-row__status')?.textContent).toBe('正在读取')
    view.unmount()
  })

  it('新调用加入已有分组时，已展开的组与详情保持不变', () => {
    const initial = [
      fetchBlock('f1', 'https://a.com/one', 'success', 'A 正文'),
      fetchBlock('f2', 'https://b.com/two', 'success', 'B 正文')
    ]
    const view = renderList(initial)
    act(() => headerOf(view.container).click())
    act(() => rowHeaders(view.container)[1].click())
    const groupBefore = view.container.querySelector('.tool-call-group')

    view.update([...initial, fetchBlock('f3', 'https://c.com/three', 'running')])

    expect(view.container.querySelector('.tool-call-group')).toBe(groupBefore)
    expect(headerOf(view.container).getAttribute('aria-expanded')).toBe('true')
    const rows = rowHeaders(view.container)
    expect(rows).toHaveLength(3)
    expect(rows[1].getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('.tool-trace-row__detail')?.textContent).toContain('B 正文')
    view.unmount()
  })

  it('单条已展开后第二条加入变成分组：组默认展开且原详情仍打开', () => {
    const first = fetchBlock('f1', 'https://a.com/one', 'success', 'A 正文')
    const view = renderList([first])
    act(() => rowHeaders(view.container)[0].click())
    expect(view.container.querySelector('.tool-trace-row__detail')?.textContent).toContain('A 正文')

    view.update([first, fetchBlock('f2', 'https://b.com/two', 'running')])

    expect(headerOf(view.container).getAttribute('aria-expanded')).toBe('true')
    expect(rowHeaders(view.container)[0].getAttribute('aria-expanded')).toBe('true')
    expect(view.container.querySelector('.tool-trace-row__detail')?.textContent).toContain('A 正文')
    view.unmount()
  })

  it('组折叠时待处理的授权入口依然可见，且只出现一次', () => {
    const blocks = [
      fetchBlock('f1', 'https://a.com/one', 'running'),
      fetchBlock('f2', 'https://b.com/two', 'running')
    ]
    useAgentStore.getState().handlePermissionRequest({
      messageId: 'msg-1',
      requestId: 'req-1',
      toolName: 'web_fetch',
      args: { url: 'https://b.com/two' },
      riskLevel: 'low',
      reason: '读取网页需要确认',
      toolCallIds: ['f1', 'f2'],
      sessionId: 'sess-1',
      version: 1
    })
    const view = renderList(blocks)
    const header = headerOf(view.container)
    expect(header.getAttribute('aria-expanded')).toBe('false')
    expect(header.textContent).toContain('等待授权')
    expect(view.container.querySelectorAll('.inline-perm')).toHaveLength(1)

    act(() => header.click())
    expect(view.container.querySelectorAll('.inline-perm')).toHaveLength(1)
    view.unmount()
  })
})
