/**
 * TurnProcessTree mount 门控单测：折叠时过程时间线不 mount
 */
import React from 'react'
import TestRenderer, { act } from 'react-test-renderer'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { TurnProcessTree } from '../../../src/renderer/features/chat/TurnProcessTree'
import { buildTurnRenderModel } from '../../../src/renderer/features/chat/turnProcessModel'
import type { RendererMessageBlock, RendererToolBlock } from '../../../src/renderer/stores/types'

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

function renderTree(isLive: boolean) {
  let renderer: TestRenderer.ReactTestRenderer | null = null
  act(() => {
    renderer = TestRenderer.create(
      <TurnProcessTree
        model={buildCompletedModel()}
        messageId="msg_1"
        isLive={isLive}
        isCurrentAssistantGenerating={false}
        isTurnActiveForThisMsg={false}
        isPausedForInput={false}
        blocks={[]}
      />
    )
  })
  return renderer!
}

describe('TurnProcessTree mount 门控', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      matchMedia: vi.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn()
      }))
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('completed 默认折叠 → 过程时间线不 mount', () => {
    const renderer = renderTree(false)
    expect(renderer.root.findAllByProps({ className: 'tool-trace-row' })).toHaveLength(0)
  })

  it('live 默认展开 → 过程时间线直接 mount', () => {
    const renderer = renderTree(true)
    expect(renderer.root.findAllByProps({ className: 'tool-trace-row' }).length).toBeGreaterThan(0)
  })

  it('点击折叠头展开 → 挂载过程时间线；再次点击 → 收起卸载', () => {
    const renderer = renderTree(false)
    const header = renderer.root.findByProps({ 'data-testid': 'turn-process-header' })

    act(() => {
      header.props.onClick()
    })
    expect(renderer.root.findAllByProps({ className: 'tool-trace-row' }).length).toBeGreaterThan(0)

    act(() => {
      header.props.onClick()
    })
    expect(renderer.root.findAllByProps({ className: 'tool-trace-row' })).toHaveLength(0)
  })
})
