import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (request: Request) => Promise<Response>>()
}))

vi.mock('electron', () => ({
  protocol: {
    handle: (scheme: string, handler: (request: Request) => Promise<Response>) => {
      mocks.handlers.set(scheme, handler)
    }
  }
}))

import {
  bindVisualizationFramePolicy,
  isFrameNavigationAllowed,
  registerNovaVizHandler
} from '../../../../src/main/protocol/novaVizProtocol'
import { buildVisualizationUri, VISUALIZATION_SCHEME } from '../../../../src/shared/visualization'

const MAIN_FRAME_ID = 1
const SNAPSHOT = buildVisualizationUri({ sessionId: 's1', sha256: 'd'.repeat(64) })
const APP_URL = 'file:///app/index.html'

interface FakeFrame {
  url: string
  parent: FakeFrame | null
  frameTreeNodeId: number
}

const mainFrame: FakeFrame = { url: APP_URL, parent: null, frameTreeNodeId: MAIN_FRAME_ID }

function childFrame(url: string, parent: FakeFrame = mainFrame, id = 7): FakeFrame {
  return { url, parent, frameTreeNodeId: id }
}

function subframeNavigation(url: string, frame: FakeFrame | null, initiator?: FakeFrame | null) {
  return { url, isMainFrame: false, frame, initiator }
}

describe('可视化帧导航策略', () => {
  it('宿主页面可以把新子帧指向快照', () => {
    expect(isFrameNavigationAllowed(subframeNavigation(SNAPSHOT, childFrame('about:blank'), mainFrame), MAIN_FRAME_ID)).toBe(true)
  })

  it.each([
    ['快照帧自行跳到远程页面', subframeNavigation('https://evil.example', childFrame(SNAPSHOT), childFrame(SNAPSHOT))],
    ['快照帧读取另一个快照', subframeNavigation(SNAPSHOT.replace('s1', 's2'), childFrame(SNAPSHOT), childFrame(SNAPSHOT))],
    ['快照帧刷新自身', subframeNavigation(SNAPSHOT, childFrame(SNAPSHOT), childFrame(SNAPSHOT))],
    ['快照内部的嵌套帧导航', subframeNavigation('about:blank', childFrame('about:srcdoc', childFrame(SNAPSHOT), 9), null)],
    ['非宿主发起的快照导航', subframeNavigation(SNAPSHOT, childFrame('about:blank'), childFrame('about:blank', mainFrame, 8))],
    ['发起方未知的快照导航', subframeNavigation(SNAPSHOT, childFrame('about:blank'), undefined)],
    ['帧对象缺失', subframeNavigation(SNAPSHOT, null, mainFrame)]
  ])('拒绝%s', (_label, navigation) => {
    expect(isFrameNavigationAllowed(navigation, MAIN_FRAME_ID)).toBe(false)
  })

  it('主帧不能导航到快照，其余主帧导航交给既有策略', () => {
    expect(isFrameNavigationAllowed({ url: SNAPSHOT.toUpperCase(), isMainFrame: true, frame: mainFrame }, MAIN_FRAME_ID)).toBe(false)
    expect(isFrameNavigationAllowed({ url: APP_URL, isMainFrame: true, frame: mainFrame }, MAIN_FRAME_ID)).toBe(true)
  })

  it('帧已销毁导致读取失败时拒绝', () => {
    const disposed = (): never => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    }
    const destroyed = {
      frameTreeNodeId: 7,
      get url(): string {
        return disposed()
      },
      get parent(): FakeFrame | null {
        return disposed()
      }
    }
    expect(isFrameNavigationAllowed(subframeNavigation(SNAPSHOT, destroyed, mainFrame), MAIN_FRAME_ID)).toBe(false)
  })

  it('绑定到 WebContents 后拦截违规导航', () => {
    let listener: ((details: unknown) => void) | undefined
    const contents = {
      mainFrame: { frameTreeNodeId: MAIN_FRAME_ID },
      on: (event: string, callback: (details: unknown) => void) => {
        if (event === 'will-frame-navigate') listener = callback
      }
    }
    bindVisualizationFramePolicy(contents as never)

    const blocked = { ...subframeNavigation('https://evil.example', childFrame(SNAPSHOT), childFrame(SNAPSHOT)), preventDefault: vi.fn() }
    const allowed = { ...subframeNavigation(SNAPSHOT, childFrame('about:blank'), mainFrame), preventDefault: vi.fn() }
    listener?.(blocked)
    listener?.(allowed)
    expect(blocked.preventDefault).toHaveBeenCalledTimes(1)
    expect(allowed.preventDefault).not.toHaveBeenCalled()
  })
})

describe('nova-viz 协议响应', () => {
  beforeEach(() => {
    mocks.handlers.clear()
    registerNovaVizHandler({ read: async () => ({ status: 'ok', html: '<p>快照</p>' }) })
  })

  it('返回带 CSP、禁缓存与禁嗅探头的帧文档', async () => {
    const response = await mocks.handlers.get(VISUALIZATION_SCHEME)!(new Request(SNAPSHOT))
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('Content-Security-Policy')).toContain('sandbox allow-scripts')
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await response.text()).toContain('<p>快照</p>')
  })

  it('只响应 GET', async () => {
    const response = await mocks.handlers.get(VISUALIZATION_SCHEME)!(new Request(SNAPSHOT, { method: 'POST', body: 'x' }))
    expect(response.status).toBe(405)
  })
})
