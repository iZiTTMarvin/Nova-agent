import { session, shell, type BrowserWindow } from 'electron'
import type { BrowserGuestMountSnapshot, BrowserSurfaceSnapshot } from '../../shared/browser'
import { getMainWindow } from '../mainWindowRef'
import { getSessionStore } from '../services/SessionStoreHost'
import { getWorkspaceService } from '../services/WorkspaceService'
import { createElectronBrowserDriver } from './electronDriver'
import { lookupElectronGuest } from './guestContents'
import { createBrowserPartitionSlotPool } from './partitionSlots'
import { createBrowserSessionHost, type BrowserSessionHost } from './sessionHost'
import {
  pushBrowserGuestMountSnapshot,
  pushBrowserSurfaceSnapshot
} from './snapshotCoalescer'
import { hardenWebviewAttachment } from './webviewPolicy'

export type { BrowserSessionHost } from './sessionHost'
export { createBrowserSessionHost } from './sessionHost'
export { hardenWebviewAttachment, routeGuestPopup } from './webviewPolicy'
export { lookupElectronGuest } from './guestContents'
export {
  BROWSER_PARTITION_SLOT_COUNT,
  BROWSER_PARTITION_SLOT_NAMES,
  createBrowserPartitionSlotPool
} from './partitionSlots'

let host: BrowserSessionHost | null = null

export async function cleanupBrowserPartition(partition: string): Promise<void> {
  const ses = session.fromPartition(partition)
  await ses.clearStorageData()
  await ses.clearCache()
  await ses.clearAuthCache()
  await ses.closeAllConnections()
}

const slotPool = createBrowserPartitionSlotPool(cleanupBrowserPartition)

function sendSnapshot(snapshot: BrowserSurfaceSnapshot): void {
  pushBrowserSurfaceSnapshot(getMainWindow(), snapshot)
}

function sendGuestMount(snapshot: BrowserGuestMountSnapshot): void {
  pushBrowserGuestMountSnapshot(getMainWindow(), snapshot)
}

export function initBrowserSessionHost(): BrowserSessionHost {
  if (host) return host
  host = createBrowserSessionHost({
    resolveWorkspaceKey: (sessionId) => getSessionStore().loadMetadata(sessionId)?.workspaceRoot ?? null,
    lookupGuest: lookupElectronGuest,
    openExternal: (url) => {
      void shell.openExternal(url)
    },
    getCurrentSessionId: () => getWorkspaceService().getState().currentSessionId,
    control: createElectronBrowserDriver(),
    allocatePartition: (browserId) => {
      const got = slotPool.acquire(browserId)
      if (!got.ok) return { error: 'resource_limit' }
      return { partition: got.partition }
    },
    releasePartition: async (browserId) => {
      await slotPool.release(browserId)
    },
    onSnapshot: sendSnapshot,
    onGuestMount: sendGuestMount
  })
  return host
}

export function getBrowserSessionHost(): BrowserSessionHost | null {
  return host
}

export function bindWebviewPolicy(win: BrowserWindow, sessionHost: BrowserSessionHost): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewAttachment(event, webPreferences, params)
  })
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler((details) => {
      sessionHost.handlePopup(details.url)
      return { action: 'deny' }
    })
  })
  win.webContents.on('did-finish-load', () => {
    sessionHost.noteRendererReloading()
  })
}
