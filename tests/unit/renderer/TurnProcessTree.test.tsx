// @vitest-environment jsdom

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TurnProcessTree } from '../../../src/renderer/features/chat/TurnProcessTree'
import { buildTurnRenderModel } from '../../../src/renderer/features/chat/turnProcessModel'
import type { RendererMessageBlock, RendererToolBlock } from '../../../src/renderer/stores/types'
import { act, renderDom } from './renderDom'

vi.mock('framer-motion', () => import('./_framerMotionMock'))
vi.mock('../../../src/renderer/features/chat/ProcessTraceList', () => ({
  ProcessTraceList: ({ segments }: { segments: Array<{ display?: string }> }) =>
    React.createElement(
      'div',
      { className: `trace-${segments[0]?.display ?? 'legacy'}`, 'data-testid': 'mock-trace' },
      segments[0]?.display
    )
}))

function toolBlock(id: string, toolName = 'read'): RendererToolBlock {
  return {
    type: 'tool',
    toolCallId: id,
    toolName,
    arguments: { path: `${id}.ts` },
    status: 'success'
  }
}

function buildCompletedModel() {
  const blocks: RendererMessageBlock[] = [
    toolBlock('1'),
    { type: 'text', content: '计划说明' },
    toolBlock('plan', 'save_plan'),
    toolBlock('2'),
    { type: 'text', content: '最终结论' }
  ]
  return buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
}

function renderTree(
  isLive: boolean,
  persistedUserOpen?: boolean,
  onUserOpenChange?: (open: boolean) => void,
  model = buildCompletedModel(),
  interrupted = false
) {
  return renderDom(
    <TurnProcessTree
      model={model}
      messageId="msg-1"
      isLive={isLive}
      interrupted={interrupted}
      isCurrentAssistantGenerating={isLive}
      isTurnActiveForThisMsg={isLive}
      isPausedForInput={false}
      blocks={[]}
      persistedUserOpen={persistedUserOpen}
      onUserOpenChange={onUserOpenChange}
    />
  )
}

describe('TurnProcessTree', () => {
  it('completed 默认折叠整个工作过程（含计划卡），仅最终文本保持挂载', () => {
    const renderer = renderTree(false)
    const collapsible = renderer.container.querySelector('.turn-process-collapsible')
    expect(collapsible?.getAttribute('data-expanded')).toBe('false')
    expect(renderer.container.querySelector('.trace-process')).toBeNull()
    expect(renderer.container.querySelectorAll('.trace-persistent').length).toBeGreaterThan(0)
    expect(renderer.container.querySelector('[data-testid="turn-no-summary"]')).toBeNull()
    renderer.unmount()
  })

  it('live 不显示工作状态头，过程区直接展开', () => {
    const renderer = renderTree(true)
    const header = renderer.container.querySelector('[data-testid="turn-process-header"]')
    expect(header).toBeNull()
    expect(renderer.container.querySelector('.turn-process-tree__chevron')).toBeNull()
    expect(renderer.container.querySelector('.trace-process')).not.toBeNull()
    expect(renderer.container.querySelector('.trace-persistent')).not.toBeNull()
    renderer.unmount()
  })

  it('completed 点击折叠头切换过程挂载，最终文本始终外露', () => {
    const renderer = renderTree(false)
    const header = renderer.container.querySelector<HTMLElement>('[data-testid="turn-process-header"]')
    act(() => header?.click())
    expect(renderer.container.querySelector('.trace-process')).not.toBeNull()
    expect(renderer.container.querySelector('.trace-persistent')).not.toBeNull()

    act(() => header?.click())
    expect(renderer.container.querySelector('.turn-process-collapsible')?.getAttribute('data-expanded'))
      .toBe('false')
    expect(renderer.container.querySelector('.trace-persistent')).not.toBeNull()
    renderer.unmount()
  })

  it('用户展开状态可由虚拟列表保存并在重挂载后恢复', () => {
    const onUserOpenChange = vi.fn()
    const first = renderTree(false, undefined, onUserOpenChange)
    act(() => first.container.querySelector<HTMLElement>('[data-testid="turn-process-header"]')?.click())
    expect(onUserOpenChange).toHaveBeenCalledWith(true)
    first.unmount()

    const remounted = renderTree(false, true, onUserOpenChange)
    expect(remounted.container.querySelector('.trace-process')).not.toBeNull()
    remounted.unmount()
  })

  it('无最终 text 的 completed 轮次在折叠区外展示占位文案；中断轮次不展示', () => {
    const blocks: RendererMessageBlock[] = [
      toolBlock('1'),
      { type: 'text', content: '计划说明' },
      toolBlock('plan', 'save_plan')
    ]
    const model = buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
    expect(model.missingAnswer).toBe(true)

    const finished = renderTree(false, undefined, undefined, model)
    expect(finished.container.querySelector('[data-testid="turn-no-summary"]')?.textContent)
      .toBe('已结束，未生成总结')
    finished.unmount()

    const interrupted = renderTree(false, undefined, undefined, model, true)
    expect(interrupted.container.querySelector('[data-testid="turn-no-summary"]')).toBeNull()
    interrupted.unmount()

    const working = renderTree(true, undefined, undefined, buildTurnRenderModel({
      blocks,
      toolCalls: [],
      mode: 'default',
      phase: 'live'
    }))
    expect(working.container.querySelector('[data-testid="turn-no-summary"]')).toBeNull()
    working.unmount()
  })
})
