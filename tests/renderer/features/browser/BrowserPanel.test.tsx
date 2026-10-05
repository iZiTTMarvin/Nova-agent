// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BrowserPanel } from '../../../../src/renderer/features/browser/BrowserPanel'
import { resetBrowserStoreForTests, useBrowserStore } from '../../../../src/renderer/features/browser/useBrowserStore'
import { useWorkspaceStore } from '../../../../src/renderer/stores/useWorkspaceStore'
import { BROWSER_NAVIGATE, BROWSER_OPEN } from '../../../../src/shared/ipc/channels'
import { BROWSER_ENGINE_CAPABILITIES } from '../../../../src/shared/browser'
import { act, renderDom } from '../../../unit/renderer/renderDom'

const invoke = vi.fn()

function enterAddress(input: HTMLInputElement, value: string): void {
  act(() => {
    input.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('浏览器地址栏交互', () => {
  beforeEach(() => {
    resetBrowserStoreForTests()
    useWorkspaceStore.setState({ currentSessionId: null })
    invoke.mockReset().mockResolvedValue({ status: 'not_applied', code: 'unavailable', detail: '站点暂不可用' })
    Object.assign(window, { api: { invoke } })
  })

  it('输入法结束后继续输入裸域名，第一次独立 Enter 即提交', async () => {
    const view = renderDom(<BrowserPanel />)
    try {
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="browser-address"]')!
      act(() => {
        input.focus()
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '百' }))
      })
      enterAddress(input, 'baidu.com')
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(invoke).toHaveBeenCalledWith(BROWSER_OPEN, { sessionId: null, url: 'https://baidu.com' })
      expect(useBrowserStore.getState().lastError).toBe('站点暂不可用')
      expect(input.value).toBe('baidu.com')
    } finally { view.unmount() }
  })

  it('没有页面时在正文区域提示输入网址并访问', () => {
    const view = renderDom(<BrowserPanel />)
    try {
      expect(view.container.querySelector('[data-testid="browser-empty"]')?.textContent)
        .toBe('输入网址并点击访问')
    } finally { view.unmount() }
  })

  it('输入法确认键不导航，随后独立 Enter 可导航', async () => {
    const view = renderDom(<BrowserPanel />)
    try {
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="browser-address"]')!
      enterAddress(input, 'baidu.com')
      act(() => {
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }))
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
      })
      expect(invoke).not.toHaveBeenCalled()
      await act(async () => {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(invoke).toHaveBeenCalledWith(BROWSER_OPEN, { sessionId: null, url: 'https://baidu.com' })
    } finally { view.unmount() }
  })

  it('访问按钮提交草稿，空地址不可提交', async () => {
    const view = renderDom(<BrowserPanel />)
    try {
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="browser-address"]')!
      const button = view.container.querySelector<HTMLButtonElement>('[aria-label="访问网址"]')
      expect(button).not.toBeNull()
      expect(button?.disabled).toBe(true)
      enterAddress(input, 'baidu.com')
      await act(async () => { button!.click() })
      expect(invoke).toHaveBeenCalledWith(BROWSER_OPEN, { sessionId: null, url: 'https://baidu.com' })
    } finally { view.unmount() }
  })

  it('已有页面失焦后访问仍提交新草稿，IPC 失败可见且保留输入', async () => {
    useBrowserStore.getState().applySnapshot({
      sequence: 1, activeBrowserId: 'user-page', maxLivePages: 2,
      pages: [{
        browserId: 'user-page', sessionId: null, generation: 1, documentEpoch: 1,
        url: 'https://example.com', title: 'Example', loading: false, lifecycle: 'ready',
        control: { holder: 'user' }, capabilities: BROWSER_ENGINE_CAPABILITIES,
        faviconUrl: null, loadError: null, notice: null
      }]
    })
    invoke.mockRejectedValue(new Error('浏览器连接已断开'))
    const view = renderDom(<BrowserPanel />)
    try {
      const input = view.container.querySelector<HTMLInputElement>('[data-testid="browser-address"]')!
      enterAddress(input, 'baidu.com')
      act(() => { input.blur() })
      await act(async () => {
        view.container.querySelector<HTMLButtonElement>('[aria-label="访问网址"]')!.click()
      })
      expect(invoke).toHaveBeenCalledWith(BROWSER_NAVIGATE, {
        sessionId: null, browserId: 'user-page', action: { kind: 'url', url: 'https://baidu.com' }
      })
      expect(input.value).toBe('baidu.com')
      expect(view.container.querySelector('[data-testid="browser-surface-error"]')?.textContent).toBe('浏览器连接已断开')
    } finally { view.unmount() }
  })
})
