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

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function pointer(slider: HTMLElement, type: string, clientX: number) {
  slider.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX }))
}

function mountMiniMax() {
  useSettingsStore.setState({ llmRegistry: registryFor('MiniMax-M3') })
  const renderer = renderDom(<ReasoningEffortControl />)
  const slider = renderer.container.querySelector<HTMLElement>('[role="slider"]')!
  vi.spyOn(slider, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, left: 0, top: 0, right: 100, bottom: 36, width: 100, height: 36,
    toJSON: () => ({})
  })
  return { renderer, slider }
}

describe('ReasoningEffortControl', () => {
  const setReasoningEffortOverride = vi.fn(async () => {})

  beforeEach(() => {
    resetSettingsStoreForTests()
    resetWorkspaceStoreForTests()
    vi.clearAllMocks()
    setReasoningEffortOverride.mockReset()
    setReasoningEffortOverride.mockResolvedValue(undefined)
    useWorkspaceStore.setState({
      currentSessionId: 'session-1',
      activeModelRef: { providerId: 'provider', modelEntryId: 'model' },
      setReasoningEffortOverride
    })
  })

  it('节点点击松手后保留目标档位，直到写回确认', async () => {
    const request = deferred()
    setReasoningEffortOverride.mockReturnValueOnce(request.promise)
    const { renderer, slider } = mountMiniMax()
    act(() => pointer(slider, 'pointerdown', 100))
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    act(() => pointer(slider, 'pointerup', 100))
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    await act(async () => {
      useWorkspaceStore.setState({ reasoningEffortOverride: 'max' })
      request.resolve()
      await request.promise
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    renderer.unmount()
  })

  it('连续键盘选档按待确认的档位前进', async () => {
    const first = deferred()
    const second = deferred()
    setReasoningEffortOverride.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    useSettingsStore.setState({ llmRegistry: registryFor('gpt-5.4') })
    useWorkspaceStore.setState({ reasoningEffortOverride: 'medium' })
    const renderer = renderDom(<ReasoningEffortControl />)
    const slider = renderer.container.querySelector<HTMLElement>('[role="slider"]')!
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    expect(slider.getAttribute('aria-valuetext')).toBe('XHigh')
    expect(setReasoningEffortOverride.mock.calls.map(call => call[0])).toEqual(['high', 'xhigh'])
    await act(async () => {
      useWorkspaceStore.setState({ reasoningEffortOverride: 'high' })
      first.resolve()
      await first.promise
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('XHigh')
    await act(async () => {
      useWorkspaceStore.setState({ reasoningEffortOverride: 'xhigh' })
      second.resolve()
      await second.promise
    })
    renderer.unmount()
  })

  it('连续选择回原档位时仍提交，旧请求完成不清掉新预览', async () => {
    const first = deferred()
    const second = deferred()
    setReasoningEffortOverride.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const { renderer, slider } = mountMiniMax()
    act(() => pointer(slider, 'pointerdown', 100))
    act(() => pointer(slider, 'pointerup', 100))
    act(() => pointer(slider, 'pointerdown', 0))
    act(() => pointer(slider, 'pointerup', 0))
    expect(setReasoningEffortOverride.mock.calls.map(call => call[0])).toEqual(['max', null])
    await act(async () => {
      useWorkspaceStore.setState({ reasoningEffortOverride: 'max' })
      first.resolve()
      await first.promise
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    await act(async () => {
      useWorkspaceStore.setState({ reasoningEffortOverride: null })
      second.resolve()
      await second.promise
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    renderer.unmount()
  })

  it('提交失败回到会话档位并提示，取消新拖动保留尚未确认的选择', async () => {
    const request = deferred()
    setReasoningEffortOverride.mockReturnValueOnce(request.promise)
    const { renderer, slider } = mountMiniMax()
    act(() => pointer(slider, 'pointerdown', 100))
    act(() => pointer(slider, 'pointerup', 100))
    act(() => pointer(slider, 'pointerdown', 0))
    act(() => pointer(slider, 'pointercancel', 0))
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    await act(async () => {
      request.reject(new Error('write failed'))
      await request.promise.catch(() => {})
    })
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    expect(renderer.container.querySelector('[role="alert"]')?.textContent).toContain('保存失败')
    renderer.unmount()
  })

  it('切会话立即丢弃旧预览，旧请求失败不污染新会话', async () => {
    const request = deferred()
    setReasoningEffortOverride.mockReturnValueOnce(request.promise)
    const { renderer, slider } = mountMiniMax()
    act(() => pointer(slider, 'pointerdown', 100))
    act(() => pointer(slider, 'pointerup', 100))
    act(() => useWorkspaceStore.setState({ currentSessionId: 'session-2' }))
    expect(renderer.container.querySelector('[role="slider"]')?.getAttribute('aria-valuetext')).toBe('High')
    await act(async () => {
      request.reject(new Error('old request failed'))
      await request.promise.catch(() => {})
    })
    expect(renderer.container.querySelector('[role="alert"]')).toBeNull()
    renderer.unmount()
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

  it('拖动时图标连续跟随指针，只有松开才写入离散档位', async () => {
    const request = deferred()
    setReasoningEffortOverride.mockReturnValueOnce(request.promise)
    const { renderer, slider } = mountMiniMax()

    act(() => pointer(slider, 'pointerdown', 0))
    act(() => pointer(slider, 'pointermove', 58))

    expect(Number.parseFloat(slider.style.getPropertyValue('--effort-progress'))).toBeCloseTo(58)
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    expect(setReasoningEffortOverride).not.toHaveBeenCalled()

    act(() => pointer(slider, 'pointerup', 58))
    expect(setReasoningEffortOverride).toHaveBeenCalledWith('max')

    await act(async () => {
      useWorkspaceStore.setState({ reasoningEffortOverride: 'max' })
      request.resolve()
      await request.promise
    })
    renderer.unmount()
  })

  it('只在最高可用档展示 Nova 星光，仍使用模型真实的档位名称', async () => {
    const request = deferred()
    setReasoningEffortOverride.mockReturnValueOnce(request.promise)
    const { renderer, slider } = mountMiniMax()

    expect(slider.classList.contains('effort-slider--stellar')).toBe(false)
    expect(renderer.container.querySelectorAll('.effort-slider__spark')).toHaveLength(16)

    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })))
    expect(slider.classList.contains('effort-slider--stellar')).toBe(true)
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    expect(renderer.container.querySelector('.effort-panel__value')?.textContent).toBe('Max')

    await act(async () => {
      useWorkspaceStore.setState({ reasoningEffortOverride: 'max' })
      request.resolve()
      await request.promise
    })

    act(() => slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })))
    expect(slider.classList.contains('effort-slider--stellar')).toBe(false)
    renderer.unmount()
  })

})
