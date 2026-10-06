import { expect, test } from '@playwright/test'
import { launchNova } from '../fixtures/nova'

test('隔离新 profile 下窗口、preload 与基础 UI 可冷启动', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, {
    skipWorkspaceSetup: true, skipViewportResize: true, recordTrace: false
  })

  try {
    const hasPreload = await nova.page.evaluate(() =>
      Boolean((window as typeof window & { api?: unknown }).api)
    )
    expect(hasPreload).toBe(true)

    const workspace = await nova.getWorkspace()
    expect(workspace.currentProjectPath).toBeNull()

    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    await expect(nova.page.locator('input[type="file"]')).toBeHidden()
    await expect.poll(() => nova.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible() && BrowserWindow.getAllWindows()[0].getOpacity() === 1
    )).toBe(true)
    await expect.poll(() => nova.page.evaluate(() =>
      performance.getEntriesByName('nova-startup-complete', 'mark').length
    )).toBe(1)
    const startup = await nova.page.evaluate(() => ({
      brand: performance.getEntriesByName('nova-brand-visible', 'mark')[0]?.startTime,
      complete: performance.getEntriesByName('nova-startup-complete', 'mark')[0]?.startTime,
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
    }))
    expect(startup.brand).toBeDefined()
    expect(startup.complete).toBeDefined()
    expect(startup.complete!).toBeGreaterThanOrEqual(startup.brand!)
    if (!startup.reducedMotion) expect(startup.complete! - startup.brand!).toBeGreaterThanOrEqual(400)
    expect(await nova.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling()
    )).toBe(true)
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})

test('首次显示后的提交通知与 reload 不会重新弹出最小化窗口', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, {
    skipWorkspaceSetup: true, skipViewportResize: true, recordTrace: false
  })
  try {
    await expect.poll(() => nova.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isVisible() && BrowserWindow.getAllWindows()[0].getOpacity() === 1
    )).toBe(true)
    await nova.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize())
    await expect.poll(() => nova.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized()
    )).toBe(true)
    await nova.invoke('window:renderer-ready')
    await nova.page.reload()
    await nova.invoke('window:renderer-ready')
    expect(await nova.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isMinimized()
    )).toBe(true)
    await nova.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore())
    await expect(nova.page.getByLabel('消息输入')).toBeEditable()
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
