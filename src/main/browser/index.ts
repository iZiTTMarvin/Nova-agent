import { screen, session, type BrowserWindow } from 'electron'
import { processRegistry } from '../../runtime/process'
import type { BrowserGuestMountSnapshot, BrowserSurfaceSnapshot } from '../../shared/browser'
import { getMainWindow } from '../mainWindowRef'
import { getSessionStore } from '../services/SessionStoreHost'
import { createElectronBrowserDriver } from './electronDriver'
import { lookupElectronGuest } from './guestContents'
import { createBrowserPartitionSlotPool } from './partitionSlots'
import { createPreviewGrantStore } from './previewGrants'
import { createRegistryPreviewQuery } from './previewProcess'
import {
  guestDownloadMessage,
  guestPermissionMessage,
  createPartitionHostResolver,
  installBrowserPartitionPolicy
} from './networkPolicy'
import { getBrowserSessionHost, setBrowserSessionHost } from './hostRef'
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
export { getBrowserSessionHost } from './hostRef'

export async function cleanupBrowserPartition(partition: string): Promise<void> {
  const ses = session.fromPartition(partition)
  await ses.clearStorageData()
  await ses.clearCache()
  await ses.clearAuthCache()
  await ses.closeAllConnections()
}

const slotPool = createBrowserPartitionSlotPool(cleanupBrowserPartition)

// 打开确认与请求拦截共用同一份解析缓存，域名指向在期限内只查一次
const partitionHostResolver = createPartitionHostResolver()

function readDisplayScale(): number | null {
  try {
    const win = getMainWindow()
    const display = win && !win.isDestroyed()
      ? screen.getDisplayMatching(win.getBounds())
      : screen.getPrimaryDisplay()
    return typeof display.scaleFactor === 'number' ? display.scaleFactor : null
  } catch {
    return null
  }
}

function sendSnapshot(snapshot: BrowserSurfaceSnapshot): void {
  pushBrowserSurfaceSnapshot(getMainWindow(), snapshot)
}

function sendGuestMount(snapshot: BrowserGuestMountSnapshot): void {
  pushBrowserGuestMountSnapshot(getMainWindow(), snapshot)
}

export function initBrowserSessionHost(): BrowserSessionHost {
  const existing = getBrowserSessionHost()
  if (existing) return existing
  const host = createBrowserSessionHost({
    resolveWorkspaceKey: (sessionId) => getSessionStore().loadMetadata(sessionId)?.workspaceRoot ?? null,
    lookupGuest: lookupElectronGuest,
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
    onGuestMount: sendGuestMount,
    installPartitionPolicy: (partition) => {
      installBrowserPartitionPolicy(partition, session.fromPartition(partition), {
        grantsFor: (webContentsId) => {
          const host = getBrowserSessionHost()
          if (!host) return []
          if (webContentsId !== undefined) {
            const bound = host.grantsForGuest(webContentsId)
            if (bound.length > 0) return bound
          }
          return host.grantsForPartition(partition)
        },
        onPermissionDenied: (input) => {
          getBrowserSessionHost()?.noteGuestHandoff(input.webContentsId, {
            kind: 'permission',
            sourceUrl: input.requestingUrl,
            targetUrl: null,
            message: guestPermissionMessage(input.permission, input.requestingUrl)
          })
        },
        onDownloadDenied: (input) => {
          getBrowserSessionHost()?.noteGuestHandoff(input.webContentsId, {
            kind: 'download',
            sourceUrl: input.url,
            targetUrl: null,
            message: guestDownloadMessage(input.filename, input.url)
          })
        }
      }, { resolveHost: partitionHostResolver })
    },
    previewGrants: createPreviewGrantStore(
      createRegistryPreviewQuery((sessionId) => processRegistry.listRunning(sessionId)),
      { resolveHost: partitionHostResolver }
    ),
    readDisplayScale
  })
  setBrowserSessionHost(host)
  return host
}

export function bindWebviewPolicy(win: BrowserWindow, sessionHost: BrowserSessionHost): void {
  win.webContents.on('will-attach-webview', (event, webPreferences, params) => {
    hardenWebviewAttachment(event, webPreferences, params)
  })
  win.webContents.on('did-attach-webview', (_event, guest) => {
    guest.setWindowOpenHandler((details) => {
      sessionHost.handlePopup(details.url, guest.id)
      return { action: 'deny' }
    })
  })
  win.webContents.on('did-finish-load', () => {
    sessionHost.noteRendererReloading()
  })
}
