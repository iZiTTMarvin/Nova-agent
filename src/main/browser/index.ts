import { screen, session, webContents, type BrowserWindow } from 'electron'
import { processRegistry } from '../../runtime/process'
import type { BrowserGuestMountSnapshot, BrowserSurfaceSnapshot } from '../../shared/browser'
import { getMainWindow } from '../mainWindowRef'
import { getSessionStore } from '../services/SessionStoreHost'
import { createElectronBrowserDriver } from './electronDriver'
import { lookupElectronGuest } from './guestContents'
import { BROWSER_USER_PARTITION, createBrowserPartitionSlotPool } from './partitionSlots'
import { createPreviewGrantStore } from './previewGrants'
import { createRegistryPreviewQuery } from './previewProcess'
import {
  guestDownloadMessage,
  guestPermissionMessage,
  createPartitionHostResolver,
  installBrowserPartitionPolicy,
  installUserBrowserPartitionPolicy,
  type PartitionPolicySink
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

/** 开发模式下主窗口从本机渲染服务加载；打包后走本地文件，没有需要避让的端口。 */
function rendererServerOrigins(): readonly string[] {
  const url = process.env.ELECTRON_RENDERER_URL
  if (!url) return []
  try {
    return [new URL(url).origin]
  } catch {
    return []
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
  const policySink = (partition: string): PartitionPolicySink => ({
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
  })
  const host = createBrowserSessionHost({
    resolveWorkspaceKey: (sessionId) => getSessionStore().loadMetadata(sessionId)?.workspaceRoot ?? null,
    lookupGuest: lookupElectronGuest,
    isGuestOfPartition: (webContentsId, partition) => {
      const guest = webContents.fromId(webContentsId)
      if (!guest || guest.isDestroyed()) return false
      return guest.session === session.fromPartition(partition)
    },
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
      const ses = session.fromPartition(partition)
      // 用户 partition 放行私网（只拦云元数据），AI 槽保持受限地址确认
      if (partition === BROWSER_USER_PARTITION) {
        installUserBrowserPartitionPolicy(partition, ses, policySink(partition))
        return
      }
      installBrowserPartitionPolicy(partition, ses, policySink(partition), { resolveHost: partitionHostResolver })
    },
    previewGrants: createPreviewGrantStore(
      createRegistryPreviewQuery((sessionId) => processRegistry.listRunning(sessionId)),
      { resolveHost: partitionHostResolver, reservedOrigins: rendererServerOrigins() }
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
      void sessionHost.handlePopup(details.url, guest.id)
      return { action: 'deny' }
    })
    // Renderer 的 did-attach 可能早于 guest ID 初始化；绑定以主进程的真实 guest 为准。
    const slot = slotPool.inspect().find(candidate =>
      candidate.state === 'busy' && guest.session === session.fromPartition(candidate.partition)
    )
    if (slot) void sessionHost.attachPartition(slot.partition, guest.id)
  })
  win.webContents.on('did-finish-load', () => {
    sessionHost.noteRendererReloading()
  })
}
