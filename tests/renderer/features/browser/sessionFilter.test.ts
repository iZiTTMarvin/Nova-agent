import { describe, expect, it } from 'vitest'
import type { BrowserPageProjection, BrowserSurfaceSnapshot } from '../../../../src/shared/browser'
import { BROWSER_ENGINE_CAPABILITIES } from '../../../../src/shared/browser'
import {
  guestShownInSession,
  pagesForSession,
  pickFocusedPage
} from '../../../../src/renderer/features/browser/sessionFilter'

function page(partial: Partial<BrowserPageProjection> & { browserId: string; sessionId: string }): BrowserPageProjection {
  return {
    generation: 1,
    documentEpoch: 1,
    url: 'https://example.com',
    title: '',
    loading: false,
    lifecycle: 'ready',
    control: { holder: 'user' },
    capabilities: BROWSER_ENGINE_CAPABILITIES,
    faviconUrl: null,
    loadError: null,
    ...partial
  }
}

describe('浏览器快照按会话过滤', () => {
  it('只返回当前会话的页面，并据此选择要展示的 guest', () => {
    const snapshot: BrowserSurfaceSnapshot = {
      sequence: 1,
      activeBrowserId: 'brw_a',
      maxLivePages: 2,
      pages: [
        page({ browserId: 'brw_a', sessionId: 'sess_a', title: 'A' }),
        page({ browserId: 'brw_b', sessionId: 'sess_b', title: 'B' })
      ]
    }
    expect(pagesForSession(snapshot, 'sess_b').map((item) => item.browserId)).toEqual(['brw_b'])
    expect(pagesForSession(snapshot, 'sess_x')).toEqual([])
    const focused = pickFocusedPage(pagesForSession(snapshot, 'sess_b'), null, 'brw_a')
    expect(focused?.browserId).toBe('brw_b')
    expect(guestShownInSession(
      [
        { browserId: 'brw_a', generation: 1, sessionId: 'sess_a', src: 'https://a.test', partition: 'p0', visible: true },
        { browserId: 'brw_b', generation: 1, sessionId: 'sess_b', src: 'https://b.test', partition: 'p1', visible: true }
      ],
      'sess_b',
      'brw_b'
    )?.src).toBe('https://b.test')
    expect(guestShownInSession(
      [
        { browserId: 'brw_a', generation: 1, sessionId: 'sess_a', src: 'https://a.test', partition: 'p0', visible: true }
      ],
      'sess_b',
      'brw_a'
    )).toBeNull()
  })

  it('两页并存时按焦点选择，忽略另一页的加载错误', () => {
    const snapshot: BrowserSurfaceSnapshot = {
      sequence: 2,
      activeBrowserId: 'brw_a',
      maxLivePages: 2,
      pages: [
        page({ browserId: 'brw_a', sessionId: 'sess_a', title: 'A', url: 'https://a.test' }),
        page({
          browserId: 'brw_b',
          sessionId: 'sess_a',
          title: 'B',
          url: 'https://b.test',
          loadError: {
            errorCode: -105,
            message: 'ERR_NAME_NOT_RESOLVED',
            url: 'https://b.test',
            isCertificateError: false
          }
        })
      ]
    }
    const pages = pagesForSession(snapshot, 'sess_a')
    expect(pages).toHaveLength(2)
    expect(pickFocusedPage(pages, 'brw_b', 'brw_a')?.browserId).toBe('brw_b')
    expect(pickFocusedPage(pages, 'brw_b', 'brw_a')?.loadError?.errorCode).toBe(-105)
    expect(pickFocusedPage(pages, 'brw_a', 'brw_a')?.loadError).toBeNull()
  })
})
