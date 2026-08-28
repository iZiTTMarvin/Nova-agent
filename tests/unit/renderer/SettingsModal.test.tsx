// @vitest-environment jsdom

import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../../src/renderer/features/settings/SettingsModal'
import { useSettingsStore, resetSettingsStoreForTests } from '../../../src/renderer/stores/useSettingsStore'
import { renderDom, act } from './renderDom'

describe('SettingsModal 设置导航与视觉样式', () => {
  beforeEach(() => {
    resetSettingsStoreForTests()
    Object.defineProperty(window, 'scrollTo', {
      configurable: true,
      value: vi.fn()
    })
    const escapeCss = (value: string): string => value.replace(/[^a-zA-Z0-9_-]/g, '\\$&')
    if (typeof CSS === 'undefined') {
      Object.defineProperty(globalThis, 'CSS', {
        configurable: true,
        value: { escape: escapeCss }
      })
    } else {
      Object.defineProperty(CSS, 'escape', {
        configurable: true,
        value: escapeCss
      })
    }
    if (typeof HTMLDialogElement !== 'undefined') {
      Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
        configurable: true,
        value() {
          this.open = true
        }
      })
      Object.defineProperty(HTMLDialogElement.prototype, 'close', {
        configurable: true,
        value() {
          this.open = false
        }
      })
    }
    global.window.api = {
      invoke: vi.fn((channel: string) => {
        if (channel === 'settings:get') {
          return Promise.resolve({
            defaultMode: 'default',
            defaultPermissionMode: 'request_approval',
            defaultShell: '',
            persistentShellSessions: true,
            maxToolRounds: 100,
            editorFontSize: 13,
            editorFontFamily: 'monospace',
            theme: 'system',
            diffAutoExpand: false
          })
        }
        if (channel === 'load-llm-registry') {
          return Promise.resolve(null)
        }
        return Promise.resolve(undefined)
      }),
      on: vi.fn(() => () => {}),
      removeAllListeners: vi.fn()
    } as never
  })

  it('未打开时不渲染任何内容', () => {
    useSettingsStore.setState({ isConfigModalOpen: false })
    const { container, unmount } = renderDom(<SettingsModal />)
    expect(container.innerHTML).toBe('')
    unmount()
  })

  it('打开时渲染「← 返回应用」按钮以及偏好、能力、系统三个分组', async () => {
    useSettingsStore.setState({ isConfigModalOpen: true })
    const { container, unmount } = renderDom(<SettingsModal />)

    const backButton = container.querySelector('.settings-shell__back')
    expect(backButton).not.toBeNull()
    expect(backButton?.textContent).toContain('返回应用')

    const groupTitles = [...container.querySelectorAll('.settings-nav__group-title')].map(
      el => el.textContent?.trim()
    )
    expect(groupTitles).toEqual(['偏好', '能力', '系统'])

    // 检查联网搜索带有 Beta 徽标
    const betaBadge = container.querySelector('.settings-nav__item-badge')
    expect(betaBadge).not.toBeNull()
    expect(betaBadge?.textContent).toBe('Beta')

    // 检查所有 10 个板块均已渲染为选项
    const itemLabels = [...container.querySelectorAll('.settings-nav__item-label')].map(
      el => el.textContent?.trim()
    )
    expect(itemLabels).toContain('通用')
    expect(itemLabels).toContain('模型')
    expect(itemLabels).toContain('子 Agent')
    expect(itemLabels).toContain('记忆')
    expect(itemLabels).toContain('规则')
    expect(itemLabels).toContain('技能')
    expect(itemLabels).toContain('代码索引')
    expect(itemLabels).toContain('联网搜索')
    expect(itemLabels).toContain('权限与能力')
    expect(itemLabels).toContain('数据与存储')

    unmount()
  })

  it('点击导航项切换选中态并更新右侧标题与内容', async () => {
    useSettingsStore.setState({ isConfigModalOpen: true })
    const { container, unmount } = renderDom(<SettingsModal />)

    // 默认通用处于选中态
    let selectedItem = container.querySelector('.settings-nav__item--selected')
    expect(selectedItem?.textContent).toContain('通用')
    expect(container.querySelector('.settings-shell__title')?.textContent).toBe('通用')

    // 查找「模型」按钮并点击
    const modelButton = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav__item')].find(
      btn => btn.textContent?.includes('模型')
    )
    expect(modelButton).toBeDefined()

    await act(async () => {
      modelButton!.click()
    })

    selectedItem = container.querySelector('.settings-nav__item--selected')
    expect(selectedItem?.textContent).toContain('模型')
    expect(container.querySelector('.settings-shell__title')?.textContent).toBe('模型')

    unmount()
  })

  it('支持方向键与键盘导航切换分区', async () => {
    useSettingsStore.setState({ isConfigModalOpen: true })
    const { container, unmount } = renderDom(<SettingsModal />)

    const generalButton = [...container.querySelectorAll<HTMLButtonElement>('.settings-nav__item')].find(
      btn => btn.textContent?.includes('通用')
    )!

    // 按 ArrowDown 键应该切换到下一个条目（模型）
    await act(async () => {
      generalButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    expect(container.querySelector('.settings-nav__item--selected')?.textContent).toContain('模型')
    expect(container.querySelector('.settings-shell__title')?.textContent).toBe('模型')

    // 按 End 键应该切换到最后一个条目（数据与存储）
    await act(async () => {
      generalButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })

    expect(container.querySelector('.settings-nav__item--selected')?.textContent).toContain('数据与存储')
    expect(container.querySelector('.settings-shell__title')?.textContent).toBe('数据与存储')

    unmount()
  })

  it('点击「返回应用」按钮触发关闭设置', async () => {
    useSettingsStore.setState({ isConfigModalOpen: true })
    const { container, unmount } = renderDom(<SettingsModal />)

    const backButton = container.querySelector<HTMLButtonElement>('.settings-shell__back')!
    await act(async () => {
      backButton.click()
    })

    expect(useSettingsStore.getState().isConfigModalOpen).toBe(false)
    unmount()
  })
})
