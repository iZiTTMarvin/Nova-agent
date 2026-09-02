// @vitest-environment jsdom

/**
 * GeneralSettingsPanel 应用更新区块：手动检查、发现新版本后的下载/安装接线。
 * preload 桥接以 window.api mock 替代（仓库 renderer 测试惯例），状态经
 * APP_UPDATE_STATE_CHANGED 事件回流，与真实主进程广播路径一致。
 */
import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GeneralSettingsPanel } from '../../../src/renderer/features/settings/GeneralSettingsPanel'
import {
  APP_UPDATE_STATE_CHANGED,
  CHECK_APP_UPDATE,
  DOWNLOAD_APP_UPDATE,
  GET_APP_UPDATE_STATE,
  INSTALL_APP_UPDATE,
} from '../../../src/shared/ipc/channels'
import type { AppUpdateSnapshot } from '../../../src/shared/update'
import { renderDom, act } from './renderDom'

const mockInvoke = vi.fn()
let updateEventHandler: ((snapshot: AppUpdateSnapshot) => void) | null = null
const mockOn = vi.fn((channel: string, handler: (snapshot: AppUpdateSnapshot) => void) => {
  if (channel === APP_UPDATE_STATE_CHANGED) updateEventHandler = handler
  return () => {}
})

const settingsDto = {
  loadThirdPartySkills: true,
  defaultMode: 'default',
  defaultPermissionMode: 'request_approval',
  defaultShell: '',
  persistentShellSessions: true,
  maxToolRounds: 100,
  editorFontSize: 13,
  editorFontFamily: 'monospace',
  theme: 'system',
  diffAutoExpand: false,
  lastProjectPath: '/tmp/project',
  snapshotRetentionDays: 30,
  memoryEnabled: true,
  memorySearchLimit: 10,
  memoryScoreFloor: 0.15,
  memoryReconcileOnSearch: false,
  memoryCaptureEnabled: true,
  memoryEpisodicSummaryEnabled: true,
  memoryExtractEnabled: true
}

function idleSnapshot(): AppUpdateSnapshot {
  return { status: 'idle', currentVersion: '0.1.3' }
}

function availableSnapshot(): AppUpdateSnapshot {
  return {
    status: 'available',
    currentVersion: '0.1.3',
    update: {
      version: '0.1.4',
      releaseName: null,
      releaseDate: '2026-09-02T00:00:00.000Z',
      releaseNotes: [{ version: '0.1.4', note: '## 更新内容' }]
    }
  }
}

function readySnapshot(): AppUpdateSnapshot {
  return { status: 'ready', currentVersion: '0.1.3', update: availableSnapshot().update }
}

function flushAsync(): Promise<void> {
  return act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function renderPanel(): Promise<{ container: HTMLElement; unmount: () => void }> {
  const renderer = renderDom(<GeneralSettingsPanel />)
  await flushAsync()
  return renderer
}

function findButton(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    node => (node.textContent ?? '').includes(text)
  )
  if (!button) throw new Error(`找不到按钮: ${text}`)
  return button
}

async function click(container: HTMLElement, text: string): Promise<void> {
  const button = findButton(container, text)
  await act(async () => {
    button.click()
  })
}

function pushSnapshot(snapshot: AppUpdateSnapshot): void {
  if (!updateEventHandler) throw new Error('更新事件监听未注册')
  act(() => {
    updateEventHandler(snapshot)
  })
}

describe('GeneralSettingsPanel 应用更新区块', () => {
  beforeEach(() => {
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
    mockInvoke.mockReset()
    mockInvoke.mockImplementation((channel: string) => {
      if (channel === 'settings:get') return Promise.resolve(settingsDto)
      if (channel === GET_APP_UPDATE_STATE) return Promise.resolve(idleSnapshot())
      return Promise.resolve(undefined)
    })
    mockOn.mockClear()
    updateEventHandler = null
    global.window.api = {
      invoke: mockInvoke,
      on: mockOn,
      removeAllListeners: vi.fn()
    } as never
  })

  it('挂载即展示当前版本，点击可手动检查更新', async () => {
    const renderer = await renderPanel()

    expect(mockInvoke).toHaveBeenCalledWith(GET_APP_UPDATE_STATE)
    expect(renderer.container.textContent).toContain('当前版本 v0.1.3')

    await click(renderer.container, '检查更新')
    expect(mockInvoke).toHaveBeenCalledWith(CHECK_APP_UPDATE)
    renderer.unmount()
  })

  it('发现新版本时展示版本与下载入口，点击走下载通道', async () => {
    const renderer = await renderPanel()
    pushSnapshot(availableSnapshot())

    expect(renderer.container.textContent).toContain('发现新版本 v0.1.4')
    await click(renderer.container, '下载更新')
    expect(mockInvoke).toHaveBeenCalledWith(DOWNLOAD_APP_UPDATE)
    renderer.unmount()
  })

  it('下载完成后入口切换为重启安装', async () => {
    const renderer = await renderPanel()
    pushSnapshot(readySnapshot())

    expect(renderer.container.textContent).toContain('v0.1.4 已就绪')
    await click(renderer.container, '重启并安装')
    expect(mockInvoke).toHaveBeenCalledWith(INSTALL_APP_UPDATE)
    renderer.unmount()
  })

  it('检查失败与下载进度经事件回流就地展示', async () => {
    const renderer = await renderPanel()
    pushSnapshot({ status: 'error', operation: 'check', currentVersion: '0.1.3', message: '网络不可用' })
    expect(renderer.container.textContent).toContain('检查更新失败：网络不可用')

    pushSnapshot({
      status: 'downloading',
      currentVersion: '0.1.3',
      update: availableSnapshot().update,
      progress: { percent: 42, transferred: 10, total: 24, bytesPerSecond: 1024 }
    })
    expect(renderer.container.textContent).toContain('正在下载 v0.1.4（42%）')
    expect(findButton(renderer.container, '检查更新').disabled).toBe(true)
    renderer.unmount()
  })
})
