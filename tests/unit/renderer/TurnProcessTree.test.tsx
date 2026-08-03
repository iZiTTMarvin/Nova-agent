// @vitest-environment jsdom

/**
 * TurnProcessTree mount 门控单测：折叠时过程时间线不 mount
 */
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { TurnProcessTree } from '../../../src/renderer/features/chat/TurnProcessTree'
import { buildTurnRenderModel } from '../../../src/renderer/features/chat/turnProcessModel'
import type { RendererMessageBlock, RendererToolBlock } from '../../../src/renderer/stores/types'
import { act, renderDom } from './renderDom'

vi.mock('framer-motion', () => import('./_framerMotionMock'))

vi.mock('../../../src/renderer/features/chat/ProcessTraceList', () => ({
  ProcessTraceList: () => React.createElement('div', { className: 'tool-trace-row', 'data-testid': 'mock-trace' })
}))

vi.mock('../../../src/renderer/stores/useAgentStore', () => ({
  useAgentStore: (selector: (s: { pendingPermissionRequest: null; pendingAskQuestion: null }) => unknown) =>
    selector({ pendingPermissionRequest: null, pendingAskQuestion: null })
}))

function toolBlock(id: string): RendererToolBlock {
  return {
    type: 'tool',
    toolCallId: id,
    toolName: 'read',
    arguments: { path: `${id}.ts` },
    status: 'success'
  }
}

function buildCompletedModel() {
  const blocks: RendererMessageBlock[] = [
    toolBlock('1'),
    toolBlock('2'),
    { type: 'text', content: '结论' }
  ]
  return buildTurnRenderModel({ blocks, toolCalls: [], mode: 'default', phase: 'completed' })
}

function renderTree(
  isLive: boolean,
  persistedUserOpen?: boolean,
  onUserOpenChange?: (open: boolean) => void
) {
  return renderDom(
    <TurnProcessTree
      model={buildCompletedModel()}
      messageId="msg_1"
      isLive={isLive}
      isCurrentAssistantGenerating={false}
      isTurnActiveForThisMsg={false}
      isPausedForInput={false}
      blocks={[]}
      persistedUserOpen={persistedUserOpen}
      onUserOpenChange={onUserOpenChange}
    />
  )
}

describe('TurnProcessTree mount 门控', () => {
  it('completed 默认折叠 → 过程时间线不 mount', () => {
    const renderer = renderTree(false)
    expect(renderer.container.querySelectorAll('.tool-trace-row')).toHaveLength(0)
    renderer.unmount()
  })

  it('live 默认展开 → 过程时间线直接 mount', () => {
    const renderer = renderTree(true)
    expect(renderer.container.querySelectorAll('.tool-trace-row').length).toBeGreaterThan(0)
    renderer.unmount()
  })

  it('点击折叠头展开 → 挂载过程时间线；再次点击 → 收起卸载', () => {
    const renderer = renderTree(false)
    const header = renderer.container.querySelector<HTMLElement>('[data-testid="turn-process-header"]')
    expect(header).not.toBeNull()

    act(() => {
      header?.click()
    })
    expect(renderer.container.querySelectorAll('.tool-trace-row').length).toBeGreaterThan(0)

    act(() => {
      header?.click()
    })
    expect(renderer.container.querySelectorAll('.tool-trace-row')).toHaveLength(0)
    renderer.unmount()
  })

  it('把用户展开状态交给虚拟列表保存，重挂载后仍保持展开', () => {
    const onUserOpenChange = vi.fn()
    const first = renderTree(false, undefined, onUserOpenChange)
    const header = first.container.querySelector<HTMLElement>('[data-testid="turn-process-header"]')

    act(() => header?.click())
    expect(onUserOpenChange).toHaveBeenCalledWith(true)
    first.unmount()

    const remounted = renderTree(false, true, onUserOpenChange)
    expect(remounted.container.querySelectorAll('.tool-trace-row').length).toBeGreaterThan(0)
    remounted.unmount()
  })
})
