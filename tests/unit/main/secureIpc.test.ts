import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'

const mockHandle = vi.fn()
const mockGetMainWindow = vi.fn()

vi.mock('electron', () => ({
  ipcMain: { handle: (...args: unknown[]) => mockHandle(...args) }
}))

vi.mock('../../../src/main/mainWindowRef', () => ({
  getMainWindow: () => mockGetMainWindow()
}))

import { handle } from '../../../src/main/ipc/secureIpc'

function makeEvent(
  sender: { mainFrame: object },
  senderFrame: object
): IpcMainInvokeEvent {
  return { sender, senderFrame } as unknown as IpcMainInvokeEvent
}

describe('secureIpc.handle', () => {
  beforeEach(() => {
    mockHandle.mockClear()
    mockGetMainWindow.mockReset()
  })

  it('注册包装后的 handler', () => {
    const listener = vi.fn()
    handle('test-channel', listener)
    expect(mockHandle).toHaveBeenCalledWith('test-channel', expect.any(Function))
  })

  it('主窗口主 frame 调用通过', async () => {
    const mainFrame = {}
    const trustedSender = { mainFrame }
    mockGetMainWindow.mockReturnValue({ webContents: trustedSender })

    let wrapped: ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined
    mockHandle.mockImplementation((_ch, fn) => { wrapped = fn })

    const listener = vi.fn().mockReturnValue('ok')
    handle('ping', listener)

    const event = makeEvent(trustedSender, mainFrame)
    await expect(Promise.resolve(wrapped!(event))).resolves.toBe('ok')
    expect(listener).toHaveBeenCalledWith(event)
  })

  it('伪造 sender 被拒绝', async () => {
    const mainFrame = {}
    const trustedSender = { mainFrame }
    mockGetMainWindow.mockReturnValue({ webContents: trustedSender })

    let wrapped: ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined
    mockHandle.mockImplementation((_ch, fn) => { wrapped = fn })

    handle('ping', vi.fn())

    const fakeSender = { mainFrame }
    const event = makeEvent(fakeSender, mainFrame)
    expect(() => wrapped!(event)).toThrow(/来源不可信/)
  })

  it('非主 frame 被拒绝', async () => {
    const mainFrame = {}
    const iframe = {}
    const trustedSender = { mainFrame }
    mockGetMainWindow.mockReturnValue({ webContents: trustedSender })

    let wrapped: ((event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) | undefined
    mockHandle.mockImplementation((_ch, fn) => { wrapped = fn })

    handle('ping', vi.fn())

    const event = makeEvent(trustedSender, iframe)
    expect(() => wrapped!(event)).toThrow(/非主 frame/)
  })
})
