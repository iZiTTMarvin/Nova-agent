// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ReasoningEffortControl } from '../../../src/renderer/features/chat/ReasoningEffortControl'
import { resetSettingsStoreForTests, useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { resetWorkspaceStoreForTests, useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import { createProviderFromPreset, type LlmRegistry } from '../../../src/shared/config/llmRegistry'
import { act, renderDom } from './renderDom'

vi.mock('@astryxdesign/core/Popover', () => ({
  Popover: ({ children, content }: { children: React.ReactNode; content: React.ReactNode }) => (
    <div>{children}{content}</div>
  )
}))

function registryFor(modelId: string): LlmRegistry {
  const provider = createProviderFromPreset('glm', 'key')
  provider.id = 'provider'
  provider.models = [{ id: 'model', modelId, displayName: modelId }]
  return {
    version: 2,
    providers: [provider],
    activeModel: { providerId: 'provider', modelEntryId: 'model' }
  }
}

describe('ReasoningEffortControl', () => {
  const setReasoningEffortOverride = vi.fn(async () => {})

  beforeEach(() => {
    resetSettingsStoreForTests()
    resetWorkspaceStoreForTests()
    vi.clearAllMocks()
    useWorkspaceStore.setState({
      currentSessionId: 'session-1',
      activeModelRef: { providerId: 'provider', modelEntryId: 'model' },
      setReasoningEffortOverride
    })
  })

  it('按当前模型能力渲染档位，并允许键盘选到 XHigh', async () => {
    useSettingsStore.setState({ llmRegistry: registryFor('gpt-5.4') })
    useWorkspaceStore.setState({ reasoningEffortOverride: 'medium' })

    const renderer = renderDom(<ReasoningEffortControl />)
    const slider = renderer.container.querySelector<HTMLElement>('[role="slider"]')
    expect(slider?.getAttribute('aria-valuemax')).toBe('3')
    expect(slider?.getAttribute('aria-valuetext')).toBe('Medium')

    await act(async () => {
      slider?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      await Promise.resolve()
    })

    expect(setReasoningEffortOverride).toHaveBeenCalledWith('xhigh')
    renderer.unmount()
  })

  it('MiniMax 只显示 High 与 Max 两个节点', () => {
    useSettingsStore.setState({ llmRegistry: registryFor('MiniMax-M3') })
    useWorkspaceStore.setState({ reasoningEffortOverride: null })

    const renderer = renderDom(<ReasoningEffortControl />)
    const slider = renderer.container.querySelector<HTMLElement>('[role="slider"]')
    expect(slider?.getAttribute('aria-valuemax')).toBe('1')
    expect(slider?.getAttribute('aria-valuetext')).toBe('High')
    renderer.unmount()
  })

  it('能力未知或没有当前会话时不展示虚假的调节器', () => {
    useSettingsStore.setState({ llmRegistry: registryFor('custom-model') })
    const unknown = renderDom(<ReasoningEffortControl />)
    expect(unknown.container.querySelector('[role="slider"]')).toBeNull()
    unknown.unmount()

    useSettingsStore.setState({ llmRegistry: registryFor('gpt-5.4') })
    useWorkspaceStore.setState({ currentSessionId: null })
    const withoutSession = renderDom(<ReasoningEffortControl />)
    expect(withoutSession.container.querySelector('[role="slider"]')).toBeNull()
    withoutSession.unmount()
  })
})
