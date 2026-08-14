import { expect, test } from '@playwright/test'
import { launchNova } from '../fixtures/nova'

test('隔离新 profile 下窗口、preload 与基础 UI 可冷启动', async ({}, testInfo) => {
  const nova = await launchNova(testInfo, { skipWorkspaceSetup: true })

  try {
    const hasPreload = await nova.page.evaluate(() =>
      Boolean((window as typeof window & { api?: unknown }).api)
    )
    expect(hasPreload).toBe(true)

    const workspace = await nova.getWorkspace()
    expect(workspace.currentProjectPath).toBeNull()

    await expect(nova.page.getByLabel('消息输入')).toBeVisible()
    expect(nova.pageErrors).toEqual([])
  } finally {
    await nova.cleanup()
  }
})
