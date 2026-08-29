import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { BrowserWindow } from 'electron'
import type {
  AppUpdateInfo,
  AppUpdateProgress,
  AppUpdateSnapshot,
} from '../shared/update'
import { APP_UPDATE_STATE_CHANGED } from '../shared/ipc/channels'
import { mainLog } from './logger'

const CHECK_DELAY_MS = 15_000
const MAX_RELEASE_NOTE_LENGTH = 64 * 1024
const MAX_RELEASE_NOTES_LENGTH = 128 * 1024
const MAX_RELEASE_NOTES = 20

interface AppUpdaterListeners {
  checking: () => void
  available: (info: unknown) => void
  notAvailable: () => void
  progress: (progress: unknown) => void
  downloaded: (info: unknown) => void
  error: (error: unknown) => void
}

export interface AppUpdaterPort {
  initialize(listeners: AppUpdaterListeners): void
  checkForUpdates(): Promise<void>
  downloadUpdate(): Promise<void>
  quitAndInstall(): void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`更新信息缺少有效的 ${field}`)
  }
  return value.trim()
}

function normalizeReleaseNotes(notes: unknown): AppUpdateInfo['releaseNotes'] {
  if (typeof notes === 'string') {
    const note = notes.trim().slice(0, Math.min(MAX_RELEASE_NOTE_LENGTH, MAX_RELEASE_NOTES_LENGTH))
    return note ? [{ version: '', note }] : []
  }

  if (notes === undefined || notes === null) return []
  if (!Array.isArray(notes)) throw new Error('更新日志格式无效')

  const normalized: AppUpdateInfo['releaseNotes'][number][] = []
  let remainingLength = MAX_RELEASE_NOTES_LENGTH
  for (const entry of notes.slice(0, MAX_RELEASE_NOTES)) {
    if (!isRecord(entry)) throw new Error('更新日志条目格式无效')
    if (entry.note !== null && typeof entry.note !== 'string') {
      throw new Error('更新日志内容格式无效')
    }
    const version = typeof entry.version === 'string' ? entry.version.trim() : ''
    const note = entry.note?.trim().slice(0, Math.min(MAX_RELEASE_NOTE_LENGTH, remainingLength))
    if (!note) continue
    normalized.push({ version, note })
    remainingLength -= note.length
    if (remainingLength === 0) break
  }
  return normalized
}

function normalizeInfo(info: unknown): AppUpdateInfo {
  if (!isRecord(info)) throw new Error('更新信息格式无效')
  const releaseName = info.releaseName
  if (releaseName !== undefined && releaseName !== null && typeof releaseName !== 'string') {
    throw new Error('更新名称格式无效')
  }
  return {
    version: requiredString(info, 'version'),
    releaseName: releaseName?.trim() || null,
    releaseDate: typeof info.releaseDate === 'string' ? info.releaseDate.trim() : '',
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  }
}

function normalizeProgress(progress: unknown): AppUpdateProgress {
  if (!isRecord(progress)) throw new Error('更新下载进度格式无效')
  const numberField = (field: string): number => {
    const value = progress[field]
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`更新下载进度缺少有效的 ${field}`)
    }
    return Math.max(0, value)
  }
  return {
    percent: Math.min(100, numberField('percent')),
    transferred: numberField('transferred'),
    total: numberField('total'),
    bytesPerSecond: numberField('bytesPerSecond'),
  }
}

function cloneSnapshot(snapshot: AppUpdateSnapshot): AppUpdateSnapshot {
  return structuredClone(snapshot)
}

class ElectronAppUpdaterAdapter implements AppUpdaterPort {
  initialize(listeners: AppUpdaterListeners): void {
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.logger = mainLog
    autoUpdater.on('checking-for-update', listeners.checking)
    autoUpdater.on('update-available', listeners.available)
    autoUpdater.on('update-not-available', listeners.notAvailable)
    autoUpdater.on('download-progress', listeners.progress)
    autoUpdater.on('update-downloaded', listeners.downloaded)
    autoUpdater.on('error', listeners.error)
  }

  async checkForUpdates(): Promise<void> {
    await autoUpdater.checkForUpdates()
  }

  async downloadUpdate(): Promise<void> {
    await autoUpdater.downloadUpdate()
  }

  quitAndInstall(): void {
    autoUpdater.quitAndInstall(true, true)
  }
}

export class AppUpdateController {
  private snapshot: AppUpdateSnapshot
  private initialized = false
  private activeOperation: 'check' | 'download' | null = null
  private checkInFlight: Promise<void> | null = null

  constructor(
    private readonly updater: AppUpdaterPort,
    currentVersion: string,
    private readonly emit: (snapshot: AppUpdateSnapshot) => void,
  ) {
    this.snapshot = { status: 'idle', currentVersion }
  }

  initialize(): void {
    if (this.initialized) return
    this.initialized = true
    this.updater.initialize({
      checking: () => this.setSnapshot({ status: 'checking', currentVersion: this.currentVersion }),
      available: (info) => {
        try {
          this.setSnapshot({
            status: 'available',
            currentVersion: this.currentVersion,
            update: normalizeInfo(info),
          })
        } catch (error) {
          this.handleError(error)
        }
      },
      notAvailable: () => {
        this.setSnapshot({
          status: 'up-to-date',
          currentVersion: this.currentVersion,
          checkedAt: new Date().toISOString(),
        })
      },
      progress: (progress) => {
        if (this.snapshot.status !== 'downloading') return
        try {
          this.setSnapshot({ ...this.snapshot, progress: normalizeProgress(progress) })
        } catch (error) {
          mainLog.warn('[updater] 忽略无效的下载进度', error)
        }
      },
      downloaded: (info) => {
        try {
          this.setSnapshot({
            status: 'ready',
            currentVersion: this.currentVersion,
            update: normalizeInfo(info),
          })
        } catch (error) {
          this.handleError(error)
        }
      },
      error: (error) => this.handleError(error),
    })
  }

  getSnapshot(): AppUpdateSnapshot {
    return cloneSnapshot(this.snapshot)
  }

  async check(): Promise<AppUpdateSnapshot> {
    if (this.snapshot.status === 'checking' || this.snapshot.status === 'downloading') {
      return this.getSnapshot()
    }
    this.setSnapshot({ status: 'checking', currentVersion: this.currentVersion })
    this.activeOperation = 'check'
    const checkTask = this.updater.checkForUpdates()
    this.checkInFlight = checkTask
    try {
      await checkTask
    } catch (error) {
      this.handleError(error)
    } finally {
      this.activeOperation = null
      if (this.checkInFlight === checkTask) this.checkInFlight = null
    }
    return this.getSnapshot()
  }

  async download(): Promise<AppUpdateSnapshot> {
    if (this.checkInFlight) {
      await this.checkInFlight.catch(() => undefined)
    }
    const update = this.downloadableUpdate
    if (!update) throw new Error('当前没有可下载的更新')

    this.setSnapshot({
      status: 'downloading',
      currentVersion: this.currentVersion,
      update,
      progress: { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 },
    })
    this.activeOperation = 'download'
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      this.handleError(error)
    } finally {
      this.activeOperation = null
    }
    return this.getSnapshot()
  }

  install(): void {
    if (this.snapshot.status !== 'ready') throw new Error('更新尚未下载完成')
    this.updater.quitAndInstall()
  }

  private get currentVersion(): string {
    return this.snapshot.currentVersion
  }

  private get downloadableUpdate(): AppUpdateInfo | null {
    if (this.snapshot.status === 'available') return this.snapshot.update
    if (this.snapshot.status === 'error' && this.snapshot.operation === 'download') {
      return this.snapshot.update
    }
    return null
  }

  private handleError(error: unknown): void {
    const message = errorMessage(error)
    if (
      this.activeOperation === 'download'
      || this.snapshot.status === 'downloading'
      || (this.snapshot.status === 'error' && this.snapshot.operation === 'download')
    ) {
      const update = this.snapshot.status === 'downloading'
        || (this.snapshot.status === 'error' && this.snapshot.operation === 'download')
        ? this.snapshot.update
        : null
      if (!update) return
      this.setSnapshot({
        status: 'error',
        operation: 'download',
        currentVersion: this.currentVersion,
        update,
        message,
      })
      return
    }
    this.setSnapshot({ status: 'error', operation: 'check', currentVersion: this.currentVersion, message })
  }

  private setSnapshot(snapshot: AppUpdateSnapshot): void {
    this.snapshot = cloneSnapshot(snapshot)
    this.emit(cloneSnapshot(this.snapshot))
  }
}

let initialized = false
let controller: AppUpdateController | null = null

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
  if (initialized) return
  initialized = true

  const emit = (snapshot: AppUpdateSnapshot): void => {
    const window = getMainWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(APP_UPDATE_STATE_CHANGED, snapshot)
    }
  }
  controller = new AppUpdateController(new ElectronAppUpdaterAdapter(), app.getVersion(), emit)

  if (!app.isPackaged) {
    mainLog.info('[updater] 开发态跳过自动更新检查')
    return
  }

  controller.initialize()

  setTimeout(() => {
    void controller?.check()
  }, CHECK_DELAY_MS)
}

export function getAppUpdateState(): AppUpdateSnapshot {
  return controller?.getSnapshot() ?? { status: 'idle', currentVersion: app.getVersion() }
}

export async function checkForAppUpdate(): Promise<AppUpdateSnapshot> {
  if (!app.isPackaged) return getAppUpdateState()
  return requireController().check()
}

export async function downloadAppUpdate(): Promise<AppUpdateSnapshot> {
  return requireController().download()
}

export function quitAndInstallUpdate(): void {
  requireController().install()
}

function requireController(): AppUpdateController {
  if (!controller) throw new Error('自动更新尚未初始化')
  return controller
}
