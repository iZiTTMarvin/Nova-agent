// @vitest-environment jsdom

import React from 'react'
import { describe, expect, it } from 'vitest'
import { BrowserTabFavicon } from '../../../../src/renderer/features/browser/BrowserTabFavicon'
import { act, renderDom } from '../../../unit/renderer/renderDom'

describe('浏览器标签 favicon', () => {
  it('没有 URL 时用地球占位，加载失败也不留白块', () => {
    const empty = renderDom(<BrowserTabFavicon faviconUrl={null} />)
    expect(empty.container.querySelector('img')).toBeNull()
    expect(empty.container.querySelector('svg')).not.toBeNull()
    empty.unmount()

    const loaded = renderDom(<BrowserTabFavicon faviconUrl="https://example.com/favicon.ico" />)
    const img = loaded.container.querySelector('img')
    expect(img).not.toBeNull()
    act(() => {
      img?.dispatchEvent(new Event('error'))
    })
    expect(loaded.container.querySelector('img')).toBeNull()
    expect(loaded.container.querySelector('svg')).not.toBeNull()
    loaded.unmount()
  })
})
