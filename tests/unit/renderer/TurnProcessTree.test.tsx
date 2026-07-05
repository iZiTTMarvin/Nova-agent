/**
 * TurnProcessTree mount 门控单测：L1/L2 折叠时 L3 不 mount
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
  useAgentStore: (selector: (s: { pendingPermissionRequest: null; pendingAskQuestion: null; pendingVerificationRequest: null }) => unknown) =>
    selector({ pendingPermissionRequest: null, pendingAskQuestion: null, pendingVerificationRequest: null })
}))

vi.mock('../../../src/renderer/features/compose/useComposeStore', () => ({
  useComposeStore: (selector: (s: { pendingAskUser: null }) => unknown) => selector({ pendingAskUser: null })
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

  it('completed 默认 L1 折叠 → 无 L3 DOM', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <TurnProcessTree
          model={buildCompletedModel()}
          messageId="msg_1"
          isLive={false}
          currentMode="default"
          isCurrentAssistantGenerating={false}
          isTurnActiveForThisMsg={false}
          isPausedForInput={false}
          blocks={[]}
        />
      )
    })
    expect(renderer!.root.findAllByProps({ className: 'tool-trace-row' })).toHaveLength(0)
  })

  it('点击 L1 展开但 L2 未展开 → 仍无 L3', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <TurnProcessTree
          model={buildCompletedModel()}
          messageId="msg_1"
          isLive={false}
          currentMode="default"
          isCurrentAssistantGenerating={false}
          isTurnActiveForThisMsg={false}
          isPausedForInput={false}
          blocks={[]}
        />
      )
    })
    const l1 = renderer!.root.findByProps({ 'data-testid': 'turn-process-l1' })
    act(() => {
      l1.props.onClick()
    })
    expect(renderer!.root.findAllByProps({ className: 'tool-trace-row' })).toHaveLength(0)
  })

  it('点击 L2 展开 → 挂载 L3', () => {
    let renderer: TestRenderer.ReactTestRenderer | null = null
    act(() => {
      renderer = TestRenderer.create(
        <TurnProcessTree
          model={buildCompletedModel()}
          messageId="msg_1"
          isLive={false}
          currentMode="default"
          isCurrentAssistantGenerating={false}
          isTurnActiveForThisMsg={false}
          isPausedForInput={false}
          blocks={[]}
        />
      )
    })
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'turn-process-l1' }).props.onClick()
    })
    act(() => {
      renderer!.root.findByProps({ 'data-testid': 'turn-process-l2' }).props.onClick()
    })
    expect(renderer!.root.findAllByProps({ className: 'tool-trace-row' }).length).toBeGreaterThan(0)
  })
})
