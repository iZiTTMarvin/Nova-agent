import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', isPackaged: false },
}))

vi.mock('electron-updater', () => ({
  autoUpdater: {
    on: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
  },
}))

vi.mock('../../../src/main/logger', () => ({
  mainLog: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}))

import {
  AppUpdateController,
  type AppUpdaterPort,
} from '../../../src/main/updater'
import type { AppUpdateSnapshot } from '../../../src/shared/update'

type Listeners = Parameters<AppUpdaterPort['initialize']>[0]

class FakeUpdater implements AppUpdaterPort {
  listeners: Listeners | null = null
  checkForUpdates = vi.fn(async () => {})
  downloadUpdate = vi.fn(async () => {})
  quitAndInstall = vi.fn()

  initialize(listeners: Listeners): void {
    this.listeners = listeners
  }
}

describe('AppUpdateController', () => {
  let updater: FakeUpdater
  let emitted: AppUpdateSnapshot[]
  let controller: AppUpdateController

  beforeEach(() => {
    updater = new FakeUpdater()
    emitted = []
    controller = new AppUpdateController(updater, '1.0.0', (snapshot) => emitted.push(snapshot))
    controller.initialize()
  })

  it('发现更新时只发布可下载状态，不在后台下载', () => {
    updater.listeners?.available({
      version: '1.1.0',
      releaseName: '体验更新',
      releaseDate: '2026-08-29T08:00:00.000Z',
      releaseNotes: '新增快捷更新入口',
    })

    expect(controller.getSnapshot()).toEqual({
      status: 'available',
      currentVersion: '1.0.0',
      update: {
        version: '1.1.0',
        releaseName: '体验更新',
        releaseDate: '2026-08-29T08:00:00.000Z',
        releaseNotes: [{ version: '', note: '新增快捷更新入口' }],
      },
    })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
  })

  it('拒绝无效的外部更新信息，不把松散数据发送到 Renderer', () => {
    updater.listeners?.available({ version: '', releaseNotes: { body: 'invalid' } })

    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      operation: 'check',
      message: '更新信息缺少有效的 version',
    })
  })

  it('对外只发布不可反向修改的状态副本', () => {
    updater.listeners?.available({
      version: '1.1.0',
      releaseDate: '2026-08-29T08:00:00.000Z',
      releaseNotes: '更新说明',
    })
    const external = controller.getSnapshot()
    if (external.status !== 'available') throw new Error('expected available snapshot')
    Reflect.set(external.update, 'version', '9.9.9')
    const current = controller.getSnapshot()

    expect(current).toMatchObject({ status: 'available', update: { version: '1.1.0' } })
  })

  it('由用户触发下载并持续发布进度，完成后才允许安装', async () => {
    const info = {
      version: '1.1.0',
      releaseDate: '2026-08-29T08:00:00.000Z',
      releaseNotes: [{ version: '1.1.0', note: '  更清晰的更新提示  ' }],
    }
    updater.listeners?.available(info)

    await controller.download()
    updater.listeners?.progress({ percent: 42.5, transferred: 425, total: 1000, bytesPerSecond: 50 })
    expect(controller.getSnapshot()).toMatchObject({
      status: 'downloading',
      progress: { percent: 42.5 },
    })

    expect(() => controller.install()).toThrow('更新尚未下载完成')
    updater.listeners?.downloaded(info)
    controller.install()
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })

  it('下载失败后保留更新说明并允许重试', async () => {
    updater.listeners?.available({
      version: '1.1.0',
      releaseDate: '2026-08-29T08:00:00.000Z',
      releaseNotes: null,
    })
    updater.downloadUpdate.mockRejectedValueOnce(new Error('network unavailable'))

    await controller.download()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      operation: 'download',
      update: { version: '1.1.0' },
      message: 'network unavailable',
    })

    await controller.download()
    expect(updater.downloadUpdate).toHaveBeenCalledTimes(2)
  })

  it('下载错误事件与 Promise 拒绝同时发生时仍保留下载错误状态', async () => {
    updater.listeners?.available({
      version: '1.1.0',
      releaseDate: '2026-08-29T08:00:00.000Z',
    })
    updater.downloadUpdate.mockImplementationOnce(async () => {
      updater.listeners?.error(new Error('download interrupted'))
      throw new Error('download interrupted')
    })

    await controller.download()
    expect(controller.getSnapshot()).toMatchObject({
      status: 'error',
      operation: 'download',
      update: { version: '1.1.0' },
    })
  })

  it('检查失败时发布可恢复的检查错误', async () => {
    updater.checkForUpdates.mockRejectedValueOnce(new Error('release endpoint unavailable'))
    await controller.check()

    expect(emitted.at(-1)).toEqual({
      status: 'error',
      operation: 'check',
      currentVersion: '1.0.0',
      message: 'release endpoint unavailable',
    })
  })

  it('发现更新后等待检查请求收尾，再开始用户触发的下载', async () => {
    let finishCheck: (() => void) | null = null
    updater.checkForUpdates.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishCheck = resolve
    }))

    const checking = controller.check()
    updater.listeners?.available({
      version: '1.1.0',
      releaseDate: '2026-08-29T08:00:00.000Z',
    })
    const downloading = controller.download()
    expect(updater.downloadUpdate).not.toHaveBeenCalled()

    finishCheck?.()
    await checking
    await downloading
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
  })
})
