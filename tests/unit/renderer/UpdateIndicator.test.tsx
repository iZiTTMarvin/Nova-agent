// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UpdateIndicator } from '../../../src/renderer/features/update/UpdateIndicator'
import type { AppUpdateInfo, AppUpdateSnapshot } from '../../../src/shared/update'
import { act, renderDom } from './renderDom'

const releaseInfo: AppUpdateInfo = {
  version: '0.1.2',
  releaseName: '春季更新',
  releaseDate: '2026-08-28T00:00:00.000Z',
  releaseNotes: [
    {
      version: '0.1.2',
      note: '## 新功能\n\n- 支持 **安全更新**\n- 优化会话体验'
    }
  ]
}

function availableSnapshot(): AppUpdateSnapshot {
  return {
    status: 'available',
    currentVersion: '0.1.1',
    update: releaseInfo
  }
}

function getTrigger(container: HTMLElement): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('.app-update-indicator__trigger')!
}

describe('UpdateIndicator 应用更新入口', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    invoke.mockResolvedValue(undefined)
    Object.assign(window, {
      api: {
        invoke,
        on: vi.fn(() => () => {}),
        removeAllListeners: vi.fn()
      }
    })
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('只在有更新、下载中、就绪或下载失败时显示入口', () => {
    const hiddenSnapshots: AppUpdateSnapshot[] = [
      { status: 'idle', currentVersion: '0.1.1' },
      { status: 'checking', currentVersion: '0.1.1' },
      { status: 'up-to-date', currentVersion: '0.1.1', checkedAt: '2026-08-28T00:00:00.000Z' },
      { status: 'error', operation: 'check', currentVersion: '0.1.1', message: '网络不可用' }
    ]

    for (const snapshot of hiddenSnapshots) {
      const renderer = renderDom(<UpdateIndicator snapshot={snapshot} />)
      expect(renderer.container.querySelector('.app-update-indicator__trigger')).toBeNull()
      renderer.unmount()
    }

    const renderer = renderDom(<UpdateIndicator snapshot={availableSnapshot()} />)
    expect(getTrigger(renderer.container)).not.toBeNull()
    renderer.unmount()
  })

  it('点击入口打开安全渲染的更新日志，并让 aria-controls 指向弹窗', async () => {
    const renderer = renderDom(<UpdateIndicator snapshot={availableSnapshot()} />)
    const trigger = getTrigger(renderer.container)

    await act(async () => {
      trigger.click()
    })

    const popover = document.body.querySelector<HTMLElement>('.app-update-popover')
    expect(popover).not.toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(trigger.getAttribute('aria-controls')).toBe(popover?.id)
    expect(popover?.textContent).toContain('v0.1.2 更新日志')
    expect(popover?.textContent).toContain('2026年8月28日')
    expect(popover?.textContent).toContain('安全更新')
    expect(popover?.querySelector('strong')).not.toBeNull()
    expect(popover?.querySelector('script')).toBeNull()
    expect(invoke).not.toHaveBeenCalled()

    renderer.unmount()
  })

  it('available 状态不会自动下载，用户确认后才发起下载', async () => {
    const renderer = renderDom(<UpdateIndicator snapshot={availableSnapshot()} />)
    await act(async () => {
      getTrigger(renderer.container).click()
    })

    const downloadButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('下载更新'))
    expect(downloadButton).toBeDefined()
    expect(invoke).not.toHaveBeenCalled()

    await act(async () => {
      downloadButton?.click()
      await Promise.resolve()
    })

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenCalledWith('app:update:download')
    renderer.unmount()
  })

  it('窄视口下将弹窗限制在可见区域内', async () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 })
    const renderer = renderDom(<UpdateIndicator snapshot={availableSnapshot()} />)
    const trigger = getTrigger(renderer.container)
    vi.spyOn(trigger, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 600,
      width: 36,
      height: 36,
      top: 600,
      right: 36,
      bottom: 636,
      left: 0,
      toJSON: () => ({})
    })

    await act(async () => {
      trigger.click()
    })

    const popover = document.body.querySelector<HTMLElement>('.app-update-popover')
    expect(popover?.style.left).toBe('28px')
    renderer.unmount()
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
  })

  it('下载中显示可访问的进度，ready 状态提供重启更新动作', async () => {
    const downloading: AppUpdateSnapshot = {
      status: 'downloading',
      currentVersion: '0.1.1',
      update: releaseInfo,
      progress: { percent: 42.4, transferred: 424, total: 1000, bytesPerSecond: 100 }
    }
    const renderer = renderDom(<UpdateIndicator snapshot={downloading} />)
    await act(async () => {
      getTrigger(renderer.container).click()
    })
    const progress = document.body.querySelector<HTMLElement>('[role="progressbar"]')
    expect(progress?.getAttribute('aria-valuenow')).toBe('42')
    expect(progress?.getAttribute('aria-valuetext')).toBe('42%')
    renderer.unmount()

    const ready: AppUpdateSnapshot = {
      status: 'ready',
      currentVersion: '0.1.1',
      update: releaseInfo
    }
    const readyRenderer = renderDom(<UpdateIndicator snapshot={ready} />)
    await act(async () => {
      getTrigger(readyRenderer.container).click()
    })
    const installButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('立即重启更新'))
    expect(installButton).toBeDefined()
    await act(async () => {
      installButton?.click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('app:update:install')
    readyRenderer.unmount()
  })

  it('下载失败支持重试，Escape 与点击外部可关闭弹窗', async () => {
    const failed: AppUpdateSnapshot = {
      status: 'error',
      operation: 'download',
      currentVersion: '0.1.1',
      update: releaseInfo,
      message: '下载连接已中断'
    }
    const renderer = renderDom(<UpdateIndicator snapshot={failed} />)
    const trigger = getTrigger(renderer.container)
    await act(async () => {
      trigger.click()
    })
    expect(document.body.querySelector('.app-update-popover')?.textContent).toContain('下载连接已中断')

    const retryButton = [...document.body.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.includes('重试下载'))
    await act(async () => {
      retryButton?.click()
      await Promise.resolve()
    })
    expect(invoke).toHaveBeenCalledWith('app:update:download')

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(document.body.querySelector('.app-update-popover')).toBeNull()

    await act(async () => {
      trigger.click()
    })
    expect(document.body.querySelector('.app-update-popover')).not.toBeNull()
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(document.body.querySelector('.app-update-popover')).toBeNull()
    renderer.unmount()
  })
})
