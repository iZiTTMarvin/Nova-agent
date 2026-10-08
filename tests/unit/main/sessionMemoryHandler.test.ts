import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { IpcMainInvokeEvent } from 'electron'
import { SessionStore } from '../../../src/runtime/sessions/SessionStore'
const registrations = vi.fn(), skip = vi.fn(), cleanup = vi.fn(), refresh = vi.fn()
const mainFrame = {}, webContents = { mainFrame }
let store: SessionStore, root: string
vi.mock('electron', () => ({ app: { getPath: () => root }, ipcMain: { handle: (...args: unknown[]) => registrations(...args) } }))
vi.mock('../../../src/main/mainWindowRef', () => ({ getMainWindow: () => ({ webContents }) }))
vi.mock('../../../src/main/services/SessionStoreHost', () => ({ initSessionStoreHost: () => store, getSessionStore: () => store }))
vi.mock('../../../src/main/services/WorkspaceService', () => ({ getWorkspaceService: () => ({ refreshAvailableSessions: refresh }) }))
vi.mock('../../../src/main/services/MemoryExtractHost', () => ({ skipMemoryExtractionThroughCurrentTail: (...args: unknown[]) => skip(...args) }))
vi.mock('../../../src/main/services/MemoryConsolidationHost', () => ({ cleanupObservationCaptureSession: (...args: unknown[]) => cleanup(...args) }))
import { registerSessionHandler } from '../../../src/main/ipc/sessionHandler'
function call(params: unknown) {
  const handler = registrations.mock.calls.find(row => row[0] === 'session:set-memory-opt-out')?.[1] as (event: IpcMainInvokeEvent, params: unknown) => Promise<void>
  return handler({ sender: webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent, params)
}
beforeEach(() => { vi.clearAllMocks(); skip.mockReset(); root = mkdtempSync(join(tmpdir(), 'nova-session-memory-ipc-')); store = new SessionStore(root); registerSessionHandler() })
afterEach(() => rmSync(root, { recursive: true, force: true }))
it('validates input and primary identity before modifying persistent privacy choice', async () => {
  const session = store.create('/workspace')
  for (const raw of [null, {}, { sessionId: session.id, optOut: 'true' }, { sessionId: 3, optOut: true }]) await expect(call(raw)).rejects.toThrow('参数不合法')
  await expect(call({ sessionId: 'missing', optOut: true })).rejects.toThrow('主会话不存在')
  await call({ sessionId: session.id, optOut: true })
  expect(new SessionStore(root).loadMetadata(session.id)?.memoryOptOut).toBe(true)
  expect(skip).toHaveBeenCalledWith(session.id, store)
  expect(cleanup).toHaveBeenCalledWith(session.id)
  expect(refresh).toHaveBeenCalledOnce()
})
it('failed cursor advancement keeps opt-out and cleans captures; re-enable advances before changing the flag', async () => {
  const session = store.create('/workspace')
  skip.mockImplementation(() => { throw new Error('cursor unavailable') })
  await expect(call({ sessionId: session.id, optOut: true })).rejects.toThrow('cursor unavailable')
  expect(store.loadMetadata(session.id)?.memoryOptOut).toBe(true)
  expect(cleanup).toHaveBeenCalledWith(session.id)
  await expect(call({ sessionId: session.id, optOut: false })).rejects.toThrow('cursor unavailable')
  expect(store.loadMetadata(session.id)?.memoryOptOut).toBe(true)
  skip.mockImplementation(() => { expect(store.loadMetadata(session.id)?.memoryOptOut).toBe(true) })
  await call({ sessionId: session.id, optOut: false })
  expect(store.loadMetadata(session.id)?.memoryOptOut).toBe(false)
})
