// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelSelector } from '../../../src/renderer/features/chat/ModelSelector'
import { resetSettingsStoreForTests, useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { resetWorkspaceStoreForTests, useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import { createProviderFromPreset, type LlmRegistry } from '../../../src/shared/config/llmRegistry'
import { act, renderDom } from './renderDom'

type MockOption = {
  type?: 'divider' | 'section'
  title?: string
  label?: React.ReactNode
  onClick?: () => void
  items?: MockOption[]
}

vi.mock('@astryxdesign/core/DropdownMenu', () => {
  const renderOptions = (options: MockOption[]): React.ReactNode => options.map((option, index) => {
    if (option.type === 'divider') return <hr key={index} />
    if (option.type === 'section') {
      return <section key={index} aria-label={option.title}>{renderOptions(option.items ?? [])}</section>
    }
    return (
      <div key={index}>
        <button type="button" onClick={option.onClick}>{option.label}</button>
        {option.items ? <div>{renderOptions(option.items)}</div> : null}
      </div>
    )
  })

  return {
    DropdownMenu: ({ button, items }: { button: { children?: React.ReactNode }; items: MockOption[] }) => (
      <div>
        <div data-testid="trigger-label">{button.children}</div>
        <div data-testid="menu">{renderOptions(items)}</div>
      </div>
    )
  }
})

function registryWithModels(): LlmRegistry {
  const glm = createProviderFromPreset('glm', 'glm-key')
  glm.id = 'glm'
  glm.models = [{ id: 'glm-53', modelId: 'glm-5.3', displayName: 'GLM-5.3' }]

  const minimax = createProviderFromPreset('minimax', 'minimax-key')
  minimax.id = 'minimax'
  minimax.models = [{ id: 'm3', modelId: 'MiniMax-M3', displayName: 'MiniMax-M3' }]

  return {
    version: 2,
    providers: [glm, minimax],
    activeModel: { providerId: 'glm', modelEntryId: 'glm-53' }
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find(candidate => candidate.textContent?.trim() === label)
  if (!button) throw new Error(`button not found: ${label}`)
  return button
}

describe('ModelSelector', () => {
  const setActiveModel = vi.fn(async () => {})
  const setSessionModel = vi.fn(async () => {})

  beforeEach(() => {
    resetSettingsStoreForTests()
    resetWorkspaceStoreForTests()
    vi.clearAllMocks()
    useSettingsStore.setState({ setActiveModel })
    useWorkspaceStore.setState({ setSessionModel })
  })

  it('独立展示当前模型，不把思考强度塞进模型菜单', () => {
    useSettingsStore.setState({ llmRegistry: registryWithModels() })
    useWorkspaceStore.setState({
      currentSessionId: 'session-1',
      activeModelRef: { providerId: 'glm', modelEntryId: 'glm-53' }
    })

    const renderer = renderDom(<ModelSelector />)

    expect(renderer.container.querySelector('[data-testid="trigger-label"]')?.textContent)
      .toContain('GLM-5.3')
    expect(renderer.container.textContent).toContain('MiniMax-M3')
    expect(renderer.container.textContent).not.toContain('思考强度')
    renderer.unmount()
  })

  it('有会话时模型写入会话覆盖，而不是改成全局 activeModel', async () => {
    useSettingsStore.setState({ llmRegistry: registryWithModels() })
    useWorkspaceStore.setState({
      currentSessionId: 'session-1',
      activeModelRef: { providerId: 'glm', modelEntryId: 'glm-53' }
    })

    const renderer = renderDom(<ModelSelector />)
    await act(async () => {
      findButton(renderer.container, 'MiniMax-M3').click()
      await Promise.resolve()
    })

    expect(setSessionModel).toHaveBeenCalledWith({ providerId: 'minimax', modelEntryId: 'm3' })
    expect(setActiveModel).not.toHaveBeenCalled()
    renderer.unmount()
  })

  it('无会话时模型选择写入全局最近选择，供新会话继承', async () => {
    useSettingsStore.setState({ llmRegistry: registryWithModels() })
    useWorkspaceStore.setState({ currentSessionId: null, activeModelRef: null })

    const renderer = renderDom(<ModelSelector />)
    await act(async () => {
      findButton(renderer.container, 'MiniMax-M3').click()
      await Promise.resolve()
    })

    expect(setActiveModel).toHaveBeenCalledWith('minimax', 'm3')
    expect(setSessionModel).not.toHaveBeenCalled()
    renderer.unmount()
  })
})