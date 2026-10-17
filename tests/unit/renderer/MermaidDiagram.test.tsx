// @vitest-environment jsdom

/**
 * MermaidDiagram 单元测试（mock mermaid 模块：jsdom 无布局，真实渲染不可行）
 *
 * 保护的风险：
 * 1. 所在块未封口（renderNow=false）：只占位，绝不加载 mermaid
 * 2. 封口后懒加载 + securityLevel 'strict' + startOnLoad false
 * 3. 同源缓存：虚拟列表重挂载不重复 render
 * 4. 渲染失败：错误 + 源码回退，内容不丢
 * 5. 切换深浅色：按新主题重渲染，不复用旧主题缓存
 */
import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('mermaid', () => {
  const api = {
    initialize: vi.fn(),
    render: vi.fn()
  }
  return { default: api }
})

import mermaidMock from 'mermaid'
import { MermaidDiagram } from '../../../src/renderer/features/chat/MermaidDiagram'
import { useSettingsStore } from '../../../src/renderer/stores/useSettingsStore'
import { renderDom, waitFor, act } from './renderDom'

const SOURCE = 'graph TD\n  A --> B'
const renderMock = mermaidMock.render as unknown as ReturnType<typeof vi.fn>
const initializeMock = mermaidMock.initialize as unknown as ReturnType<typeof vi.fn>

/** 动态 import 需要宏任务节拍才落地；先给一拍再进 waitFor 轮询 */
async function flushLazyImport(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 10))
  })
}

describe('MermaidDiagram', () => {
  beforeEach(() => {
    renderMock.mockReset()
    renderMock.mockResolvedValue({ svg: '<svg data-mermaid="1"></svg>' })
    initializeMock.mockReset()
  })

  it('renderNow=false：占位态不触发 mermaid 加载与渲染', async () => {
    const tree = renderDom(<MermaidDiagram source={SOURCE} renderNow={false} />)
    expect(tree.container.querySelector('.mermaid-diagram--pending')).not.toBeNull()
    expect(tree.container.textContent).toContain('A --> B')
    await flushLazyImport()
    expect(renderMock).not.toHaveBeenCalled()
    tree.unmount()
  })

  it('renderNow=true：懒加载渲染并注入 SVG，strict 安全配置', async () => {
    const tree = renderDom(<MermaidDiagram source={SOURCE} renderNow={true} />)
    await flushLazyImport()
    await waitFor(() => tree.container.querySelector('[data-mermaid="1"]') !== null)
    const initCalls = initializeMock.mock.calls
    expect(initCalls.length).toBeGreaterThan(0)
    expect(initCalls.some(call => (call[0] as { securityLevel?: string }).securityLevel === 'strict')).toBe(true)
    expect(initCalls.some(call => (call[0] as { startOnLoad?: boolean }).startOnLoad === false)).toBe(true)
    tree.unmount()
  })

  it('同源缓存：卸载重挂（虚拟列表滚动）不再 render', async () => {
    // 模块级 SVG 缓存跨测试共享：用本测试专属源码隔离
    const source = 'graph TD\n  C --> D'
    const first = renderDom(<MermaidDiagram source={source} renderNow={true} />)
    await flushLazyImport()
    await waitFor(() => first.container.querySelector('[data-mermaid="1"]') !== null)
    first.unmount()
    expect(renderMock).toHaveBeenCalledTimes(1)

    const second = renderDom(<MermaidDiagram source={source} renderNow={true} />)
    await flushLazyImport()
    await waitFor(() => second.container.querySelector('[data-mermaid="1"]') !== null)
    expect(renderMock).toHaveBeenCalledTimes(1)
    second.unmount()
  })

  it('渲染失败：错误提示 + 源码回退展示', async () => {
    renderMock.mockRejectedValue(new Error('Parse error: unknown node'))
    const source = 'graph TD\n  E --> F'
    const tree = renderDom(<MermaidDiagram source={source} renderNow={true} />)
    await flushLazyImport()
    await waitFor(() => tree.container.querySelector('.mermaid-diagram--error') !== null)
    expect(tree.container.textContent).toContain('Parse error')
    expect(tree.container.textContent).toContain('E --> F')
    tree.unmount()
  })

  it('切换深浅色：已渲染的图表按新主题重渲染', async () => {
    let configuredTheme = ''
    initializeMock.mockImplementation((config: { theme?: string }) => {
      if (config.theme) configuredTheme = config.theme
    })
    renderMock.mockImplementation(() => Promise.resolve({ svg: `<svg data-mermaid-theme="${configuredTheme}"></svg>` }))
    const source = 'graph TD\n  G --> H'
    act(() => useSettingsStore.setState({ theme: 'light' }))
    const tree = renderDom(<MermaidDiagram source={source} renderNow={true} />)
    await flushLazyImport()
    await waitFor(() => tree.container.querySelector('[data-mermaid-theme="neutral"]') !== null)

    act(() => useSettingsStore.setState({ theme: 'dark' }))
    await flushLazyImport()
    await waitFor(() => tree.container.querySelector('[data-mermaid-theme="dark"]') !== null)
    tree.unmount()
    act(() => useSettingsStore.setState({ theme: 'system' }))
  })
})
