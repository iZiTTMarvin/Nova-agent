// @vitest-environment jsdom

import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EvidenceCard } from '../../../src/renderer/features/chat/EvidenceCard'
import { useBrowserStore } from '../../../src/renderer/features/browser/useBrowserStore'
import { useLayoutStore } from '../../../src/renderer/stores/useLayoutStore'
import { useWorkspaceStore } from '../../../src/renderer/stores/useWorkspaceStore'
import type { EvidenceReference } from '../../../src/shared/evidence'
import type { BrowserPageProjection } from '../../../src/shared/browser'
import { renderDom, act } from './renderDom'

const SAMPLE_PAGE: BrowserPageProjection = {
  browserId: 'browser-ev-1',
  sessionId: 'sess-ev-1',
  url: 'http://localhost:3000/dashboard',
  title: 'Dashboard',
  lifecycle: 'ready',
  owner: 'agent',
  generation: 1,
  documentEpoch: 2,
  canGoBack: false,
  canGoForward: false,
  lastError: null
}

const SAMPLE_IMAGE_EVIDENCE: EvidenceReference = {
  kind: 'image',
  sourceTool: 'browser',
  description: '仪表盘首屏渲染结果',
  bytes: 4096,
  url: 'nova-image://sess-ev-1/0123456789abcdef0123456789abcdef.png',
  mimeType: 'image/png',
  width: 1280,
  height: 720,
  browser: {
    browserId: 'browser-ev-1',
    generation: 1,
    documentEpoch: 2,
    url: 'http://localhost:3000/dashboard'
  }
}

describe('EvidenceCard 实时页面联动', () => {
  const invoke = vi.fn()

  beforeEach(() => {
    invoke.mockReset()
    global.window.api = {
      invoke,
      on: vi.fn(() => () => {}),
      removeAllListeners: vi.fn()
    } as never

    useWorkspaceStore.setState({
      currentSessionId: 'sess-ev-1',
      currentMode: 'pilot'
    })
    useLayoutStore.setState({
      inspectorOpen: false,
      inspectorTab: 'review'
    })
    useBrowserStore.setState({
      snapshot: {
        activeBrowserId: null,
        pages: [
          {
            ...SAMPLE_PAGE,
            browserId: 'browser-other',
            url: 'http://localhost:3000/other'
          },
          SAMPLE_PAGE
        ]
      },
      focusedBrowserId: 'browser-other',
      lastError: null,
      composeNewPage: false
    })
  })

  afterEach(() => {
    useBrowserStore.setState({
      snapshot: null,
      focusedBrowserId: null,
      lastError: null,
      composeNewPage: false
    })
  })

  it('点击打开实时结果成功时聚焦目标页面并展开右侧浏览器面板', async () => {
    invoke.mockResolvedValueOnce({
      status: 'applied',
      page: SAMPLE_PAGE
    })

    const view = renderDom(
      <EvidenceCard sessionId="sess-ev-1" evidence={[SAMPLE_IMAGE_EVIDENCE]} />
    )
    try {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        el => el.textContent?.includes('打开实时结果')
      )
      expect(button).toBeTruthy()

      await act(async () => {
        button!.click()
        await Promise.resolve()
      })

      expect(invoke).toHaveBeenCalledWith('evidence:open-browser', {
        sessionId: 'sess-ev-1',
        id: SAMPLE_IMAGE_EVIDENCE.url
      })
      expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-ev-1')
      expect(useLayoutStore.getState().inspectorOpen).toBe(true)
      expect(useLayoutStore.getState().inspectorTab).toBe('browser')
      expect(view.container.textContent).toContain('已打开实时页面')
    } finally {
      view.unmount()
    }
  })

  it('主进程返回不可用时不误弹浏览器面板并提示重新验证', async () => {
    invoke.mockResolvedValueOnce({
      status: 'rejected',
      reason: 'target_unavailable',
      detail: '端口未响应'
    })

    const view = renderDom(
      <EvidenceCard sessionId="sess-ev-1" evidence={[SAMPLE_IMAGE_EVIDENCE]} />
    )
    try {
      const button = Array.from(view.container.querySelectorAll('button')).find(
        el => el.textContent?.includes('打开实时结果')
      )
      await act(async () => {
        button!.click()
        await Promise.resolve()
      })

      expect(useBrowserStore.getState().focusedBrowserId).toBe('browser-other')
      expect(useLayoutStore.getState().inspectorOpen).toBe(false)
      expect(view.container.textContent).toContain('实时页面不可用：端口未响应，请重新验证')
    } finally {
      view.unmount()
    }
  })
})
