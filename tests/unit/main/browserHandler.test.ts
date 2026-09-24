import { readFileSync } from 'fs'
import path from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPort } from '../../../src/runtime/browser'
import { BROWSER_ENGINE_CAPABILITIES } from '../../../src/shared/browser'
import {
  BROWSER_ACT,
  BROWSER_ATTACH,
  BROWSER_CAPTURE,
  BROWSER_CLAIM,
  BROWSER_CLOSE,
  BROWSER_GET_SNAPSHOT,
  BROWSER_NAVIGATE,
  BROWSER_OBSERVE,
  BROWSER_OPEN,
  BROWSER_RELEASE
} from '../../../src/shared/ipc/channels'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, raw: unknown) => unknown>()
}))

vi.mock('../../../src/main/ipc/secureIpc', () => ({
  handle: (channel: string, listener: (event: unknown, raw: unknown) => unknown) => {
    mocks.handlers.set(channel, listener)
  }
}))

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() }
}))

import { registerBrowserHandler } from '../../../src/main/ipc/browserHandler'

function invoke(channel: string, raw: unknown): Promise<unknown> {
  const listener = mocks.handlers.get(channel)
  if (!listener) throw new Error(`未注册 ${channel}`)
  return Promise.resolve(listener({}, raw))
}

function createPort(): BrowserPort {
  return {
    open: vi.fn(async () => ({
      status: 'applied',
      page: {
        browserId: 'brw_1',
        generation: 1,
        documentEpoch: 1,
        sessionId: 'sess_1',
        url: 'https://example.com',
        title: '',
        loading: true,
        lifecycle: 'opening',
        control: { holder: 'user' },
        capabilities: BROWSER_ENGINE_CAPABILITIES,
        faviconUrl: null,
        loadError: null,
        notice: null
      }
    })),
    navigate: vi.fn(async () => ({ status: 'not_applied', code: 'unavailable', detail: 'nav' })),
    observe: vi.fn(async () => ({ status: 'not_applied', code: 'unavailable', detail: 'obs' })),
    act: vi.fn(async () => ({ status: 'not_applied', code: 'unavailable', detail: 'act' })),
    capture: vi.fn(async () => ({ status: 'not_applied', code: 'unavailable', detail: 'cap' })),
    close: vi.fn(async () => ({ status: 'applied', browserId: 'brw_1' })),
    listPages: vi.fn(async () => ({
      status: 'applied',
      snapshot: {
        sequence: 1,
        pages: [],
        activeBrowserId: null,
        maxLivePages: 2
      }
    })),
    claim: vi.fn(async () => ({ status: 'not_applied', code: 'unavailable', detail: 'claim' })),
    release: vi.fn(async () => ({ status: 'not_applied', code: 'unavailable', detail: 'release' }))
  }
}

describe('browserHandler 源码契约', () => {
  it('经 secureIpc.handle 登记，不直接使用 ipcMain', () => {
    const src = readFileSync(
      path.join(__dirname, '../../../src/main/ipc/browserHandler.ts'),
      'utf8'
    )
    expect(src).toMatch(/import\s*\{\s*handle\s*\}\s*from\s*['"]\.\/secureIpc['"]/)
    expect(src).not.toMatch(/ipcMain\.handle/)
  })
})

describe('browserHandler 入参校验与转发', () => {
  let port: BrowserPort | null

  beforeEach(() => {
    mocks.handlers.clear()
    port = createPort()
    registerBrowserHandler({ getPort: () => port })
  })

  it('登记人工浏览通道', () => {
    expect([...mocks.handlers.keys()].sort()).toEqual([
      BROWSER_ATTACH,
      BROWSER_CLAIM,
      BROWSER_ACT,
      BROWSER_CAPTURE,
      BROWSER_CLOSE,
      BROWSER_GET_SNAPSHOT,
      BROWSER_NAVIGATE,
      BROWSER_OBSERVE,
      BROWSER_OPEN,
      BROWSER_RELEASE
    ].sort())
  })

  it('未知导航动作在转发前拒绝', async () => {
    const result = await invoke(BROWSER_NAVIGATE, {
      sessionId: 'sess_1',
      browserId: 'brw_1',
      action: { kind: 'evaluate', expression: '1' }
    })
    expect(result).toEqual({
      status: 'not_applied',
      code: 'invalid_request',
      detail: '未知的导航动作'
    })
    expect(port?.navigate).not.toHaveBeenCalled()
  })

  it('合法打开命令转发给端口', async () => {
    const result = await invoke(BROWSER_OPEN, {
      sessionId: 'sess_1',
      url: 'https://example.com/app'
    })
    expect(result).toMatchObject({ status: 'applied', page: { browserId: 'brw_1' } })
    expect(port?.open).toHaveBeenCalledWith(
      { url: 'https://example.com/app' },
      { sessionId: 'sess_1' }
    )
  })

  it('宿主未装配时返回 unavailable，不把非法身份当成已打开', async () => {
    port = null
    const result = await invoke(BROWSER_OPEN, {
      sessionId: 'sess_1',
      url: 'https://example.com'
    })
    expect(result).toEqual({
      status: 'not_applied',
      code: 'unavailable',
      detail: '浏览器宿主尚未装配'
    })
  })

  it('缺少 sessionId 的快照查询被拒绝', async () => {
    const result = await invoke(BROWSER_GET_SNAPSHOT, { browserId: 'brw_1' })
    expect(result).toMatchObject({ status: 'not_applied', code: 'invalid_request' })
    expect(port?.listPages).not.toHaveBeenCalled()
  })

  it('未装配宿主时拒绝 webContentsId 上报', async () => {
    const result = await invoke(BROWSER_ATTACH, {
      sessionId: 'sess_1',
      browserId: 'brw_1',
      webContentsId: 2
    })
    expect(result).toEqual({
      status: 'not_applied',
      code: 'unavailable',
      detail: '浏览器宿主尚未装配'
    })
  })
})
